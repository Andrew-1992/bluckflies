import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelSender, OutboundReply } from '../../services/ChannelService.js';
import type { SmsSender } from '../notify/senders.js';

/**
 * Twilio SMS channel.
 * - Inbound: form-encoded webhook signed with X-Twilio-Signature
 *   (base64 HMAC-SHA1 of the full URL followed by each POST parameter name and
 *   value, sorted by name, keyed with the auth token).
 * - Outbound: the Messages API (TwilioSmsSender).
 */

export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = Buffer.from(createHmac('sha1', authToken).update(data).digest('base64'));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** SMS has no buttons: the YES/NO instruction is already in the text. Long replies are trimmed. */
export class SmsChannelSender implements ChannelSender {
  constructor(private readonly sms: SmsSender) {}
  async send(to: string, reply: OutboundReply): Promise<void> {
    const text = reply.text.length > 1500 ? `${reply.text.slice(0, 1490)}…` : reply.text;
    await this.sms.send(to, text);
  }
}
