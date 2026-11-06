import type { Booking } from '../../domain/types.js';
import type { Clock } from '../../lib/clock.js';
import { newId } from '../../lib/ids.js';
import type { Logger } from '../../lib/logger.js';
import { maskPhone } from '../../lib/phone.js';
import { SendError, type EmailSender, type SmsSender } from '../../providers/notify/senders.js';
import type { BookingRepository, NotificationChannel, NotificationRecord, NotificationRepository, SupportTicketRecord } from '../../repositories/types.js';
import { renderBookingEvent, type BookingEventKind } from './templates.js';

const MAX_ATTEMPTS = 8;
const BACKFILL_WINDOW_MS = 3 * 24 * 60 * 60_000;

/** Receives booking lifecycle events (decouples booking/payment services from messaging). */
export interface BookingEvents {
  onBooking(kind: BookingEventKind, booking: Booking): Promise<void>;
}

/** Backoff: 30s, 1m, 2m, 4m … capped at 1h. */
export const retryDelayMs = (attempts: number): number => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);

export interface NotificationOptions {
  siteUrl: string;
  /** Staff who receive an alert for every new support request. */
  supportAlertEmails: readonly string[];
  supportAlertPhones: readonly string[];
  /** Signed link to the printable e-ticket, added to e-ticket messages. */
  eticketLink?: (bookingId: string) => string;
  /**
   * Approved WhatsApp templates per booking event, and the template language
   * codes. Booking messages go to WhatsApp (instead of SMS) for travellers who
   * booked on WhatsApp, when the event has a template.
   */
  whatsappTemplates?: { held?: string; ticketed?: string; refunded?: string; languages: { en: string; ar: string } };
  /** The WhatsApp number of the traveller behind a booking, if they booked on WhatsApp. */
  whatsappRecipient?: (b: Booking) => Promise<string | undefined>;
}

/** What WhatsApp needs to send a template; implemented by WhatsAppSender. */
export interface WhatsAppTemplateSender {
  sendTemplate(to: string, template: { name: string; language: string; params: readonly string[] }): Promise<void>;
}

/**
 * Transactional outbox for traveller and staff messages. Events only *queue*
 * messages (idempotently, by dedupe key); a background job delivers them with
 * retries. A provider outage delays messages but never loses them, and a
 * backfill pass re-queues anything missed between a state change and a crash.
 */
export class NotificationService implements BookingEvents {
  constructor(
    private readonly repo: NotificationRepository,
    private readonly bookings: BookingRepository,
    private readonly senders: { email?: EmailSender | undefined; sms?: SmsSender | undefined; whatsapp?: WhatsAppTemplateSender | undefined },
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: NotificationOptions,
  ) {}

  async onBooking(kind: BookingEventKind, b: Booking): Promise<void> {
    const lang = b.contact.language ?? 'en';
    const m = renderBookingEvent(kind, b, { lang, siteUrl: this.opts.siteUrl, ...(kind === 'ticketed' && this.opts.eticketLink ? { eticketUrl: this.opts.eticketLink(b.id) } : {}) });
    await this.queue(`${kind}:${b.id}:email`, 'email', b.contact.email, m.subject, m.email);
    // Travellers who booked on WhatsApp get the message there (an approved template, so it is
    // delivered even outside WhatsApp's 24-hour window); everyone else by SMS.
    const template = this.opts.whatsappTemplates?.[kind];
    const waTo = template && this.senders.whatsapp ? await this.opts.whatsappRecipient?.(b).catch(() => undefined) : undefined;
    if (template && waTo) {
      const payload = JSON.stringify({
        name: template,
        language: this.opts.whatsappTemplates?.languages[lang] ?? lang,
        params: m.whatsappParams,
        // If WhatsApp finally refuses (e.g. template not approved), the SMS goes instead.
        fallback: { to: b.contact.phone, subject: m.subject, sms: m.sms },
      });
      if (await this.queue(`${kind}:${b.id}:whatsapp`, 'whatsapp', waTo, template, payload)) return;
    }
    await this.queue(`${kind}:${b.id}:sms`, 'sms', b.contact.phone, m.subject, m.sms);
  }

  async onSupportTicket(t: SupportTicketRecord, context: { pnr?: string; phone?: string }): Promise<void> {
    const subject = `BluckFlies support: ${t.reason.replace(/_/g, ' ')}${context.pnr ? ` (${context.pnr})` : ''}`;
    const body = `New support request ${t.id}\nReason: ${t.reason}\n${context.pnr ? `Booking: ${context.pnr}\n` : ''}${context.phone ? `Traveller phone: ${context.phone}\n` : ''}\n${t.summary}\n\nOpen the support desk: ${this.opts.siteUrl}/desk.html`;
    for (const to of this.opts.supportAlertEmails) await this.queue(`support:${t.id}:email:${to}`, 'email', to, subject, body);
    const sms = `BluckFlies support ${t.reason.replace(/_/g, ' ')}${context.pnr ? ` ${context.pnr}` : ''}: ${t.summary.slice(0, 100)}`;
    for (const to of this.opts.supportAlertPhones) await this.queue(`support:${t.id}:sms:${to}`, 'sms', to, subject, sms);
  }

  /** An operations alert (AlertService): one email/SMS per recipient, deduplicated by the alert key. */
  async opsAlert(key: string, subject: string, body: string, sms: string, to: { emails: readonly string[]; phones: readonly string[] }): Promise<void> {
    for (const email of to.emails) await this.queue(`${key}:email:${email}`, 'email', email, subject, body);
    for (const phone of to.phones) await this.queue(`${key}:sms:${phone}`, 'sms', phone, subject, sms);
  }

  /** A one-off message from staff to a traveller (e.g. about a change request). */
  async staffMessage(ticketId: string, noteId: string, phone: string, text: string): Promise<boolean> {
    return this.queue(`staff:${ticketId}:${noteId}`, 'sms', phone, 'BluckFlies support', `BluckFlies: ${text}`);
  }

  private async smsFallback(n: { dedupeKey: string; body: string }): Promise<void> {
    const f = parseFallback(n.body);
    if (f) await this.queue(`${n.dedupeKey}:sms-fallback`, 'sms', f.to, f.subject, f.sms).catch(() => false);
  }

  /** True when this deployment can actually deliver on `channel`. */
  canDeliver(channel: NotificationChannel): boolean {
    return Boolean(channel === 'email' ? this.senders.email : channel === 'sms' ? this.senders.sms : this.senders.whatsapp);
  }

  private async queue(dedupeKey: string, channel: NotificationChannel, recipient: string, subject: string, body: string): Promise<boolean> {
    if (!this.canDeliver(channel)) return false; // channel not configured: nothing to queue
    const now = this.clock.now().toISOString();
    const record: NotificationRecord = { id: newId('ntf'), dedupeKey, channel, recipient, subject, body, status: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now };
    return this.repo.enqueue(record);
  }

  /** Background job: delivers due messages. */
  async dispatch(limit = 25): Promise<{ sent: number; retried: number; failed: number }> {
    const due = await this.repo.due(this.clock.now(), limit);
    const result = { sent: 0, retried: 0, failed: 0 };
    for (const n of due) {
      try {
        if (n.channel === 'email') await this.senders.email?.send({ to: n.recipient, subject: n.subject, text: n.body });
        else if (n.channel === 'whatsapp') await this.senders.whatsapp?.sendTemplate(n.recipient, parseTemplate(n.body));
        else await this.senders.sms?.send(n.recipient, n.body);
        await this.repo.markSent(n.id, this.clock.now().toISOString());
        result.sent++;
      } catch (err) {
        const attempts = n.attempts + 1;
        const retryable = !(err instanceof SendError) || err.retryable;
        const final = !retryable || attempts >= MAX_ATTEMPTS;
        const message = err instanceof Error ? err.message : String(err);
        await this.repo.markAttemptFailed(n.id, {
          attempts,
          nextAttemptAt: new Date(this.clock.now().getTime() + retryDelayMs(attempts)).toISOString(),
          error: message,
          final,
        });
        const to = n.channel === 'email' ? n.recipient.replace(/^(.).*(@.*)$/, '$1***$2') : maskPhone(n.recipient);
        if (final && n.channel === 'whatsapp') await this.smsFallback(n);
        if (final) {
          this.log.error('notification.failed', { id: n.id, key: n.dedupeKey, channel: n.channel, to, attempts, err: message });
          result.failed++;
        } else {
          this.log.warn('notification.retry', { id: n.id, channel: n.channel, attempts, err: message });
          result.retried++;
        }
      }
    }
    return result;
  }

  /**
   * Background job: queues ticket and refund messages for bookings whose state
   * changed recently but have no message yet (crash between the state change
   * and queueing). Dedupe keys make this safe to run any number of times.
   */
  async backfill(limit = 200): Promise<{ queued: number }> {
    const since = new Date(this.clock.now().getTime() - BACKFILL_WINDOW_MS);
    const recent = await this.bookings.findRecentByStatus(['ticketed', 'refunded'], since, limit);
    const kindOf = (b: Booking): BookingEventKind => (b.status === 'ticketed' ? 'ticketed' : 'refunded');
    const channels = (['email', 'sms'] as const).filter((c) => this.canDeliver(c));
    const keys = recent.flatMap((b) => channels.map((c) => `${kindOf(b)}:${b.id}:${c}`));
    const existing = await this.repo.existingKeys(keys);
    let queued = 0;
    for (const b of recent) {
      if (channels.every((c) => existing.has(`${kindOf(b)}:${b.id}:${c}`))) continue;
      await this.onBooking(kindOf(b), b);
      queued++;
    }
    if (queued) this.log.warn('notification.backfilled', { queued });
    return { queued };
  }
}

/** The SMS to send if a WhatsApp template message cannot be delivered. */
function parseFallback(body: string): { to: string; subject: string; sms: string } | undefined {
  try {
    const f = (JSON.parse(body) as { fallback?: { to?: unknown; subject?: unknown; sms?: unknown } }).fallback;
    return f && typeof f.to === 'string' && typeof f.subject === 'string' && typeof f.sms === 'string' ? { to: f.to, subject: f.subject, sms: f.sms } : undefined;
  } catch {
    return undefined;
  }
}

/** Template payloads are stored as JSON in the outbox body. */
function parseTemplate(body: string): { name: string; language: string; params: string[] } {
  const v = JSON.parse(body) as { name?: unknown; language?: unknown; params?: unknown };
  if (typeof v.name !== 'string' || typeof v.language !== 'string' || !Array.isArray(v.params)) throw new SendError('Invalid WhatsApp template payload', false);
  return { name: v.name, language: v.language, params: v.params.map(String) };
}
