import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { safeEqualHex } from '../../lib/ids.js';
import type { Logger } from '../../lib/logger.js';
import { maskPhone } from '../../lib/phone.js';
import type { ChannelSender, InboundMessage, OutboundReply } from '../../services/ChannelService.js';
import { SendError } from '../notify/senders.js';

/**
 * WhatsApp Business Cloud API (Meta).
 * - Inbound: webhook signed with the app secret (X-Hub-Signature-256: sha256=<hex HMAC of the raw body>).
 * - Outbound: POST /{phone-number-id}/messages with a system-user access token.
 * Replies are sent inside the 24-hour customer-service window opened by the traveller's message.
 */

export const WHATSAPP_SIGNATURE_HEADER = 'x-hub-signature-256';

export function verifyWhatsAppSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  const m = /^sha256=([a-f0-9]{64})$/.exec(header ?? '');
  if (!m?.[1]) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest('hex');
  return safeEqualHex(expected, m[1]);
}

const Webhook = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            messages: z
              .array(
                z.object({
                  id: z.string(),
                  from: z.string().regex(/^\d{8,15}$/),
                  type: z.string(),
                  text: z.object({ body: z.string() }).optional(),
                  interactive: z
                    .object({
                      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
                      list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
                    })
                    .optional(),
                  button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
                }),
              )
              .optional(),
          }),
        }),
      ),
    }),
  ),
});

/** Extracts traveller messages; status updates (sent/delivered/read) are ignored. */
export function parseWhatsAppWebhook(body: unknown): InboundMessage[] {
  const parsed = Webhook.safeParse(body);
  if (!parsed.success || parsed.data.object !== 'whatsapp_business_account') return [];
  const out: InboundMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const m of change.value.messages ?? []) {
        const from = `+${m.from}`;
        if (m.type === 'text' && m.text) out.push({ id: m.id, from, kind: 'text', text: m.text.body.slice(0, 2000) });
        else if (m.type === 'interactive' && (m.interactive?.button_reply || m.interactive?.list_reply)) {
          const r = m.interactive.button_reply ?? m.interactive.list_reply;
          out.push({ id: m.id, from, kind: 'button', buttonId: r?.id ?? '', text: r?.title ?? '' });
        } else if (m.type === 'button' && m.button) out.push({ id: m.id, from, kind: 'button', buttonId: m.button.payload ?? '', text: m.button.text ?? '' });
        else if (m.type === 'audio') out.push({ id: m.id, from, kind: 'audio' });
        else out.push({ id: m.id, from, kind: 'other' });
      }
    }
  }
  return out;
}

const TEXT_LIMIT = 4096;
const BODY_WITH_BUTTONS_LIMIT = 1024;

/** HMAC-SHA256 of the access token keyed with the app secret, as Meta's Graph API expects. */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

export class WhatsAppSender implements ChannelSender {
  constructor(
    /** appSecret adds Meta's appsecret_proof, required when the app enables "Require app secret". */
    private readonly opts: { accessToken: string; phoneNumberId: string; apiVersion: string; appSecret?: string; baseUrl?: string },
    private readonly log: Logger,
  ) {}

  async send(to: string, reply: OutboundReply): Promise<void> {
    const payload =
      reply.buttons && reply.buttons.length > 0 && reply.text.length <= BODY_WITH_BUTTONS_LIMIT
        ? {
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: reply.text },
              action: { buttons: reply.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
            },
          }
        : { type: 'text', text: { body: reply.text.slice(0, TEXT_LIMIT), preview_url: false } };
    await this.post(to, payload);
  }

  /**
   * An approved message template: the only kind WhatsApp delivers when the
   * traveller has not written in the last 24 hours (e.g. an e-ticket after a
   * bank deposit the next day). `params` fill {{1}}, {{2}}, … in the body.
   */
  async sendTemplate(to: string, template: { name: string; language: string; params: readonly string[] }): Promise<void> {
    await this.post(to, {
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(template.params.length ? { components: [{ type: 'body', parameters: template.params.map((text) => ({ type: 'text', text: text.slice(0, 1000) || '-' })) }] } : {}),
      },
    });
  }

  private async post(to: string, payload: Record<string, unknown>): Promise<void> {
    const recipient = to.replace(/^\+/, '');
    const url = `${this.opts.baseUrl ?? 'https://graph.facebook.com'}/${this.opts.apiVersion}/${encodeURIComponent(this.opts.phoneNumberId)}/messages${this.opts.appSecret ? `?appsecret_proof=${appSecretProof(this.opts.accessToken, this.opts.appSecret)}` : ''}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, ...payload }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new SendError(`WhatsApp: network error (${err instanceof Error ? err.name : 'unknown'})`, true);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      this.log.error('whatsapp.send_failed', { to: maskPhone(to), status: res.status, detail });
      throw new SendError(`WhatsApp: HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    }
  }
}
