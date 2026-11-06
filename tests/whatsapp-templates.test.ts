import { describe, expect, it, vi } from 'vitest';
import type { Container } from '../src/container.js';
import { hashToken, newId, newSessionToken } from '../src/lib/ids.js';
import { createLogger } from '../src/lib/logger.js';
import { WhatsAppSender } from '../src/providers/channels/whatsapp.js';
import { SendError, type SmsSender } from '../src/providers/notify/senders.js';
import type { WhatsAppTemplateSender } from '../src/services/notifications/NotificationService.js';
import { adult, CONTACT, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';

const TEMPLATES = {
  WHATSAPP_TEMPLATE_HELD: 'bluckflies_seats_held',
  WHATSAPP_TEMPLATE_TICKETED: 'bluckflies_ticket_issued',
  WHATSAPP_TEMPLATE_REFUNDED: 'bluckflies_refund_done',
  WHATSAPP_TEMPLATE_LANG_EN: 'en_US',
  BANK_NAME: 'KCB',
  BANK_ACCOUNT_NAME: 'BluckFlies Ltd',
  BANK_ACCOUNT_NUMBER: '1234567890',
  AUTH_SECRET: 's'.repeat(40),
  PUBLIC_BASE_URL: 'https://bluckflies.example',
};
const WA_PHONE = '+211955123456';

class RecordingTemplates implements WhatsAppTemplateSender {
  readonly sent: Array<{ to: string; name: string; language: string; params: readonly string[] }> = [];
  fail = false;
  async sendTemplate(to: string, t: { name: string; language: string; params: readonly string[] }) {
    if (this.fail) throw new SendError('WhatsApp: HTTP 400 (template not approved)', false);
    this.sent.push({ to, ...t });
  }
}
class RecordingSms implements SmsSender {
  readonly name = 'recording';
  readonly delivers = true;
  readonly sent: Array<{ to: string; body: string }> = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
  }
}

/** A session as ChannelService creates it for a WhatsApp sender, linked to their account. */
async function whatsappSession(c: Container): Promise<string> {
  const now = new Date().toISOString();
  const traveller = await c.repos.travellers.upsertByPhone({ id: newId('trv'), phoneHash: hashToken(`wa:${WA_PHONE}`), phone: WA_PHONE, at: now });
  const id = newId('ses');
  await c.repos.sessions.create({ id, tokenHash: hashToken(newSessionToken()), createdAt: now, lastSeenAt: now, channel: 'whatsapp', channelKey: hashToken(`key:${WA_PHONE}`), travellerId: traveller.id });
  return id;
}

async function book(c: Container, sid: string, language: 'en' | 'ar' = 'en') {
  const r = await c.search.search(sid, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation(sid, r.offers[0]?.offerId ?? '', [adult()], { ...CONTACT, language });
  const v = await c.confirmations.approve(sid, p.confirmationId);
  return c.bookings.getOwned(sid, v.pnr);
}

describe('booking messages on WhatsApp', () => {
  it('sends approved templates (in the traveller’s language) instead of SMS to people who booked on WhatsApp', async () => {
    const wa = new RecordingTemplates();
    const sms = new RecordingSms();
    const { c } = testContainer({ whatsappTemplates: wa, sms }, TEMPLATES);
    const sid = await whatsappSession(c);
    const b = await book(c, sid, 'ar');
    await c.payments.initiate(b, 'bank_transfer', CONTACT.phone);
    await c.payments.settleManualPayment(b.id, { received: true, amount: { amountMinor: b.offer.totalPrice.amountCents, currency: 'USD' }, reference: 'FT1' });
    await c.notifications.dispatch();

    expect(wa.sent.map((m) => [m.to, m.name, m.language])).toEqual([
      [WA_PHONE, 'bluckflies_seats_held', 'ar'],
      [WA_PHONE, 'bluckflies_ticket_issued', 'ar'],
    ]);
    const ticketed = wa.sent[1]?.params ?? [];
    expect(ticketed[0]).toBe(b.pnr);
    expect(ticketed[2]).toMatch(/^\d{13}$/); // ticket number
    expect(ticketed[3]).toMatch(/^https:\/\/bluckflies\.example\/e\//); // e-ticket link
    expect(sms.sent.filter((s) => s.to === CONTACT.phone)).toEqual([]); // no duplicate SMS
  });

  it('keeps SMS for web bookings, and when no templates are configured', async () => {
    const wa = new RecordingTemplates();
    const sms = new RecordingSms();
    const { c } = testContainer({ whatsappTemplates: wa, sms }, TEMPLATES);
    await book(c, 'ses_owner');
    await c.notifications.dispatch();
    expect(wa.sent).toEqual([]);
    expect(sms.sent.filter((s) => s.to === CONTACT.phone)).toHaveLength(1);

    // A WhatsApp booker, but no templates configured: SMS as before.
    const wa2 = new RecordingTemplates();
    const sms2 = new RecordingSms();
    const plain = testContainer({ whatsappTemplates: wa2, sms: sms2 });
    const sid = await whatsappSession(plain.c);
    const b = await book(plain.c, sid);
    await plain.c.notifications.dispatch();
    expect(wa2.sent).toEqual([]);
    const texts = sms2.sent.filter((s) => s.to === CONTACT.phone);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.body).toContain(b.pnr);
  });

  it('falls back to SMS when WhatsApp refuses the template (e.g. not approved yet)', async () => {
    const wa = new RecordingTemplates();
    wa.fail = true;
    const sms = new RecordingSms();
    const { c } = testContainer({ whatsappTemplates: wa, sms }, TEMPLATES);
    const sid = await whatsappSession(c);
    const b = await book(c, sid);
    await c.notifications.dispatch(); // WhatsApp refused: final failure, SMS fallback queued
    await c.notifications.dispatch();
    const fallback = sms.sent.filter((s) => s.to === CONTACT.phone);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.body).toContain(b.pnr);
  });

  it('sends the documented Cloud API template payload', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const sender = new WhatsAppSender({ accessToken: 'EAAG-token-123456789012', phoneNumberId: '123456789012345', apiVersion: 'v21.0' }, createLogger('error'));
      await sender.sendTemplate('+211955123456', { name: 'bluckflies_ticket_issued', language: 'en_US', params: ['ABC234', 'Juba → Nairobi', '9990001112223', 'https://x/e/1'] });
      const body = JSON.parse(String(spy.mock.calls[0]?.[1]?.body));
      expect(body).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '211955123456',
        type: 'template',
        template: {
          name: 'bluckflies_ticket_issued',
          language: { code: 'en_US' },
          components: [{ type: 'body', parameters: ['ABC234', 'Juba → Nairobi', '9990001112223', 'https://x/e/1'].map((text) => ({ type: 'text', text })) }],
        },
      });
    } finally {
      spy.mockRestore();
    }
  });
});
