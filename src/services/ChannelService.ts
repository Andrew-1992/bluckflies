import type { BluckFliesAgent } from '../agent/Agent.js';
import { AppError, isAppError } from '../domain/errors.js';
import type { Clock } from '../lib/clock.js';
import { hashToken, newId, newSessionToken } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import type { RateLimiter } from '../lib/rateLimiter.js';
import { keyedHash, maskPhone } from '../lib/phone.js';
import { DuplicateKeyError, type ProcessedEventRepository, type SessionRepository } from '../repositories/types.js';
import type { AuthService } from './AuthService.js';
import type { BookingView } from './BookingService.js';
import type { ConfirmationService } from './ConfirmationService.js';
import type { SupportService } from './SupportService.js';

export type MessagingChannel = 'whatsapp' | 'sms';

export interface InboundMessage {
  /** Provider message ID (dedupe). */
  id: string;
  /** Sender, E.164. Proven by the channel provider (signed webhook). */
  from: string;
  kind: 'text' | 'button' | 'audio' | 'other';
  text?: string;
  /** Reply-button payload, e.g. "cnf:cnf_…:yes". */
  buttonId?: string;
}

export interface OutboundReply {
  text: string;
  /** Reply buttons (WhatsApp). SMS shows the YES/NO instruction in the text instead. */
  buttons?: Array<{ id: string; title: string }>;
}

export interface ChannelSender {
  send(to: string, reply: OutboundReply): Promise<void>;
}

const YES = /^\s*(yes|y|ok|confirm|نعم|ايوه|أيوه|اي|أكد)\s*[.!]*\s*$/i;
const NO = /^\s*(no|n|cancel|لا|إلغاء|الغاء)\s*[.!]*\s*$/i;
const isArabic = (s: string) => /[؀-ۿ]/.test(s);

/** Per-sender flood protection, shared by all servers: 30 messages per 10 minutes. */
const SENDER_LIMIT = { windowMs: 10 * 60_000, max: 30 };

/**
 * WhatsApp and SMS front-end for the same agent.
 *
 * Safety: the model still cannot approve anything. A booking or cancellation
 * proposed by the agent is confirmed only when the traveller taps the Yes
 * button (WhatsApp) or replies YES (SMS) from the verified sender number; this
 * service, not the model, applies that decision.
 */
export class ChannelService {
  constructor(
    private readonly agent: BluckFliesAgent,
    private readonly confirmations: ConfirmationService,
    private readonly sessions: SessionRepository,
    private readonly auth: AuthService,
    private readonly events: ProcessedEventRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly secret: string,
    private readonly limits: RateLimiter,
    /** Opens a call-back ticket when the assistant is unavailable (outage or spending limit). */
    private readonly support?: SupportService,
  ) {}

  async handleInbound(channel: MessagingChannel, msg: InboundMessage, out: ChannelSender): Promise<void> {
    // Providers redeliver on timeouts: each message is handled once.
    if (!(await this.events.markIfNew(`${channel}:msg:${msg.id}`))) return;
    const ar = isArabic(msg.text ?? '');
    const reply = (text: string, buttons?: OutboundReply['buttons']) => out.send(msg.from, { text, ...(buttons ? { buttons } : {}) });

    if (!(await this.limits.consume(`${channel}-sender:${msg.from}`, SENDER_LIMIT)).allowed) {
      this.log.warn('channel.flood', { channel, from: maskPhone(msg.from) });
      return;
    }
    if (msg.kind === 'audio' || msg.kind === 'other') {
      await reply(
        'Please send your message as text. Voice notes are not supported here yet; on our website you can speak to BluckFlies.\nأرسل رسالتك كنص من فضلك. الرسائل الصوتية غير مدعومة هنا بعد؛ يمكنك التحدث مع بلك فلايز على موقعنا.',
      );
      return;
    }

    const sessionId = await this.sessionFor(channel, msg.from);
    try {
      const decision = await this.confirmationDecision(sessionId, msg);
      if (decision) {
        await this.applyDecision(channel, sessionId, decision, ar, reply);
        return;
      }
      const text = (msg.text ?? '').trim();
      if (!text) return;
      await this.agentTurn(channel, sessionId, text, ar, reply);
    } catch (err) {
      if (isAppError(err) && err.code === 'AGENT_UNAVAILABLE') {
        await reply(await this.assistantDown(channel, sessionId, msg, ar));
        return;
      }
      const message = isAppError(err) ? err.message : ar ? 'عذراً، حدث خطأ. حاول مرة أخرى بعد قليل.' : 'Sorry, something went wrong. Please try again in a moment.';
      if (!isAppError(err)) this.log.error('channel.failed', { channel, from: maskPhone(msg.from), err: err instanceof Error ? err.message : String(err) });
      await reply(message);
    }
  }

  /**
   * There is no step-by-step search on WhatsApp or SMS, so when the assistant is
   * down (provider outage or spending limit) a person calls back instead: one
   * desk ticket per conversation per day, with the sender's number.
   */
  private async assistantDown(channel: MessagingChannel, sessionId: string, msg: InboundMessage, ar: boolean): Promise<string> {
    const day = this.clock.now().toLocaleDateString('en-CA', { timeZone: 'Africa/Juba' });
    const first = this.support ? await this.events.markIfNew(`agent-down:${sessionId}:${day}`) : false;
    if (first && this.support) {
      const said = (msg.text ?? '').trim().slice(0, 300);
      await this.support.open(sessionId, 'callback_request', `${channel === 'sms' ? 'SMS' : 'WhatsApp'} traveller could not reach the assistant. They wrote: "${said}"`, { contactPhone: msg.from });
    }
    if (!this.support) {
      return ar ? 'المساعد غير متاح الآن. حاول مرة أخرى لاحقاً من فضلك.' : 'Our assistant is not available right now. Please try again later.';
    }
    return ar
      ? 'المساعد غير متاح الآن. طلبنا من موظف في بلك فلايز أن يتصل بك على هذا الرقم قريباً.'
      : 'Our assistant is not available right now. We have asked a BluckFlies agent to contact you on this number soon.';
  }

  private async agentTurn(channel: MessagingChannel, sessionId: string, text: string, ar: boolean, reply: (t: string, b?: OutboundReply['buttons']) => Promise<void>): Promise<void> {
    const before = new Set((await this.confirmations.listPending(sessionId)).map((c) => c.confirmationId));
    const turn = await this.agent.handle(sessionId, text, { channel });
    await reply(turn.reply);
    // New proposals get explicit Yes/No controls from the system, not from the model.
    const fresh = (await this.confirmations.listPending(sessionId)).filter((c) => !before.has(c.confirmationId));
    for (const c of fresh) {
      const question = c.kind === 'create_reservation' ? (ar ? 'هل تؤكد هذا الحجز؟' : 'Confirm this booking?') : ar ? 'هل تؤكد الإلغاء؟' : 'Confirm this cancellation?';
      const yes = ar ? '✓ نعم' : '✓ Yes';
      const no = ar ? '✗ لا' : '✗ No';
      const instruction =
        channel === 'sms' ? (ar ? '\nأرسل نعم للتأكيد أو لا للإلغاء.' : '\nReply YES to confirm or NO to cancel.') : '';
      await reply(`${question}\n${c.summary}${instruction}`, [
        { id: `cnf:${c.confirmationId}:yes`, title: yes },
        { id: `cnf:${c.confirmationId}:no`, title: no },
      ]);
    }
  }

  private async confirmationDecision(sessionId: string, msg: InboundMessage): Promise<{ id: string; approve: boolean } | undefined> {
    const button = /^cnf:(cnf_[a-f0-9]{32}):(yes|no)$/.exec(msg.buttonId ?? '');
    if (button?.[1]) return { id: button[1], approve: button[2] === 'yes' };
    const text = msg.text ?? '';
    const approve = YES.test(text) ? true : NO.test(text) ? false : undefined;
    if (approve === undefined) return undefined;
    const pending = await this.confirmations.listPending(sessionId);
    if (pending.length === 0) return undefined; // a plain "yes" in conversation goes to the agent
    if (pending.length > 1) throw new AppError('CONFLICT', isArabic(text) ? 'لديك أكثر من طلب بانتظار التأكيد. استخدم الأزرار.' : 'More than one request is waiting for your answer. Please use the buttons.');
    return { id: pending[0]!.confirmationId, approve };
  }

  private async applyDecision(channel: MessagingChannel, sessionId: string, d: { id: string; approve: boolean }, ar: boolean, reply: (t: string) => Promise<void>): Promise<void> {
    if (!d.approve) {
      await this.confirmations.decline(sessionId, d.id);
      await reply(ar ? 'حسناً. لم يتم حجز أو إلغاء أي شيء.' : 'OK. Nothing was booked or cancelled.');
      return;
    }
    const booking: BookingView = await this.confirmations.approve(sessionId, d.id);
    this.log.info('channel.confirmed', { channel, sessionId, pnr: booking.pnr, status: booking.status });
    // Same follow-up as the web app: the agent continues with payment or wraps up.
    const follow = booking.status === 'held' ? `I confirmed. My booking reference is ${booking.pnr}. How can I pay?` : `I confirmed the cancellation of ${booking.pnr}.`;
    await this.agentTurn(channel, sessionId, follow, ar, reply);
  }

  /** One session per channel and sender, linked to the sender's account. */
  private async sessionFor(channel: MessagingChannel, phone: string): Promise<string> {
    const channelKey = keyedHash(this.secret, channel, phone);
    const existing = await this.sessions.findByChannelKey(channelKey);
    const travellerId = await this.auth.accountForVerifiedPhone(phone);
    if (existing) {
      if (existing.travellerId !== travellerId) await this.sessions.setTraveller(existing.id, travellerId);
      return existing.id;
    }
    const now = this.clock.now().toISOString();
    const id = newId('ses');
    try {
      // The token is never handed out: this session is reachable only through the channel.
      await this.sessions.create({ id, tokenHash: hashToken(newSessionToken()), channel, channelKey, travellerId, createdAt: now, lastSeenAt: now });
      return id;
    } catch (err) {
      // Two first messages raced: use the session the other one created.
      if (err instanceof DuplicateKeyError) {
        const winner = await this.sessions.findByChannelKey(channelKey);
        if (winner) return winner.id;
      }
      throw err;
    }
  }
}
