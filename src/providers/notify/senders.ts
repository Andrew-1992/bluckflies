import type { Logger } from '../../lib/logger.js';
import { maskPhone } from '../../lib/phone.js';

/**
 * Outbound email and SMS. Senders throw `SendError`; `retryable` tells the
 * outbox whether trying again later can help (network, 5xx, rate limits)
 * or not (invalid recipient, bad credentials).
 */
export class SendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SendError';
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  readonly name: string;
  /** False for development senders that only log. */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<void>;
}

export interface SmsSender {
  readonly name: string;
  readonly delivers: boolean;
  send(to: string, body: string): Promise<void>;
}

const TIMEOUT_MS = 15_000;

async function post(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new SendError(`${what}: network error (${err instanceof Error ? err.name : 'unknown'})`, true);
  }
  if (res.ok) return res;
  // 408/429/5xx are worth retrying; other 4xx mean the request itself is wrong.
  const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  throw new SendError(`${what}: HTTP ${res.status} ${detail}`, retryable);
}

/** Email through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';
  readonly delivers = true;
  constructor(private readonly opts: { apiKey: string; from: string; baseUrl?: string }) {}
  async send(m: EmailMessage): Promise<void> {
    await post(`${this.opts.baseUrl ?? 'https://api.resend.com'}/emails`, {
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.opts.from, to: [m.to], subject: m.subject, text: m.text }),
    }, 'Resend');
  }
}

/** SMS through Twilio's Messages API. */
export class TwilioSmsSender implements SmsSender {
  readonly name = 'twilio';
  readonly delivers = true;
  constructor(private readonly opts: { accountSid: string; authToken: string; from: string; baseUrl?: string }) {}
  async send(to: string, body: string): Promise<void> {
    const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64');
    await post(`${this.opts.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`, {
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      // A Messaging Service SID (MG…) lets Twilio pick a sender valid for the destination country.
      body: new URLSearchParams({ To: to, Body: body, ...(this.opts.from.startsWith('MG') ? { MessagingServiceSid: this.opts.from } : { From: this.opts.from }) }).toString(),
    }, 'Twilio');
  }
}

/** Development only: logs instead of sending. Never used in production (see config). */
export class LogEmailSender implements EmailSender {
  readonly name = 'log';
  readonly delivers = false;
  readonly sent: EmailMessage[] = [];
  constructor(private readonly log: Logger) {}
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
    this.log.info('email.dev_logged', { to: m.to.replace(/^(.).*(@.*)$/, '$1***$2'), subject: m.subject, body: m.text });
  }
}

/** Development only: logs instead of sending (login codes appear in the server log). */
export class LogSmsSender implements SmsSender {
  readonly name = 'log';
  readonly delivers = false;
  readonly sent: Array<{ to: string; body: string }> = [];
  constructor(private readonly log: Logger) {}
  async send(to: string, body: string): Promise<void> {
    this.sent.push({ to, body });
    this.log.info('sms.dev_logged', { to: maskPhone(to), body });
  }
}
