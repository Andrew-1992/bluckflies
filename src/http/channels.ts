import express, { type Express } from 'express';
import type { Container } from '../container.js';
import { maskPhone, normalizePhone } from '../lib/phone.js';
import { TWILIO_SIGNATURE_HEADER, verifyTwilioSignature } from '../providers/channels/twilio.js';
import { parseWhatsAppWebhook, verifyWhatsAppSignature, WHATSAPP_SIGNATURE_HEADER } from '../providers/channels/whatsapp.js';
import type { ChannelSender, InboundMessage, MessagingChannel } from '../services/ChannelService.js';
import { rateLimit } from './middleware.js';

/**
 * Inbound WhatsApp and SMS webhooks. Both are verified against the raw request
 * before anything is read, then acknowledged at once: the agent can take longer
 * than the providers' webhook timeouts, so replies are sent asynchronously.
 * Redeliveries are harmless (message IDs are deduplicated).
 */
export function channelRoutes(app: Express, c: Container): void {
  const limiter = rateLimit(c.limits, { windowMs: 60_000, max: 300, key: (req) => `channel:${req.ip}` });

  const processLater = (channel: MessagingChannel, messages: InboundMessage[], sender: ChannelSender) => {
    const channels = c.channels;
    if (!channels) return;
    for (const m of messages) {
      setImmediate(() => {
        channels.handleInbound(channel, m, sender).catch((err: unknown) => {
          c.log.error('channel.unhandled', { channel, from: maskPhone(m.from), err: err instanceof Error ? err.message : String(err) });
        });
      });
    }
  };

  const wa = c.whatsapp;
  if (wa && c.channels) {
    // Meta's one-time subscription check.
    app.get('/api/webhooks/whatsapp', (req, res) => {
      const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === wa.verifyToken;
      if (!ok) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Verification failed.' } });
        return;
      }
      res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    });
    app.post('/api/webhooks/whatsapp', limiter, express.raw({ type: 'application/json', limit: '512kb' }), (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyWhatsAppSignature(raw, req.header(WHATSAPP_SIGNATURE_HEADER), wa.appSecret)) {
        c.log.warn('whatsapp.bad_signature', { ip: req.ip });
        res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid signature.' } });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON.' } });
        return;
      }
      res.sendStatus(200);
      processLater('whatsapp', parseWhatsAppWebhook(body), wa.sender);
    });
  }

  const sms = c.smsChannel;
  if (sms && c.channels) {
    app.post('/api/webhooks/sms', limiter, express.urlencoded({ extended: false, limit: '64kb' }), (req, res) => {
      const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      // Twilio signs the exact public URL it called.
      const url = `${c.config.PUBLIC_BASE_URL}/api/webhooks/sms`;
      if (!verifyTwilioSignature(sms.authToken, url, params, req.header(TWILIO_SIGNATURE_HEADER))) {
        c.log.warn('sms.bad_signature', { ip: req.ip });
        res.status(401).type('text/xml').send('<Response/>');
        return;
      }
      res.type('text/xml').send('<Response/>');
      const from = normalizePhone(params['From'] ?? '');
      const id = params['MessageSid'] ?? '';
      if (!from || !id) return;
      processLater('sms', [{ id, from, kind: 'text', text: (params['Body'] ?? '').slice(0, 2000) }], sms.sender);
    });
  }
}
