import { createHmac } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { hashToken } from '../src/lib/ids.js';
import { keyedHash, normalizePhone } from '../src/lib/phone.js';
import { verifyTwilioSignature } from '../src/providers/channels/twilio.js';
import { parseWhatsAppWebhook, verifyWhatsAppSignature } from '../src/providers/channels/whatsapp.js';
import type { SmsSender } from '../src/providers/notify/senders.js';
import type { ChannelSender, OutboundReply } from '../src/services/ChannelService.js';
import { adult, CONTACT, FRIDAY, ONE_ADULT, ScriptedLlm, testContainer, text, toolCall } from './helpers.js';

const ADMIN = 'a'.repeat(40);
const staff = { authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Mary Akol' };

class RecordingSms implements SmsSender {
  readonly name = 'rec';
  readonly delivers = true;
  readonly sent: Array<{ to: string; body: string }> = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
  }
  lastCode(): string {
    return /(\d{6})/.exec(this.sent.at(-1)?.body ?? '')?.[1] ?? '';
  }
}

class RecordingChannel implements ChannelSender {
  readonly sent: Array<{ to: string; reply: OutboundReply }> = [];
  async send(to: string, reply: OutboundReply) {
    this.sent.push({ to, reply });
  }
}

async function session(app: ReturnType<typeof createApp>) {
  const token = (await request(app).post('/api/sessions').expect(201)).body.token as string;
  return { authorization: `Bearer ${token}` };
}

async function heldBookingFor(c: Container, sid: string) {
  const r = await c.search.search(sid, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation(sid, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
  return c.confirmations.approve(sid, p.confirmationId);
}

// ------------------------------------------------------------------ desk

describe('support desk', () => {
  it('turns "talk to a person" about a booking into a ticket staff can work, with an alert', async () => {
    const sms = new RecordingSms();
    const { c } = testContainer({ sms }, { ADMIN_API_TOKEN: ADMIN, SUPPORT_ALERT_PHONES: '+211955000111' });
    const booking = await heldBookingFor(c, 'ses_owner');
    const ticket = await c.support.open('ses_owner', 'change_request', 'Traveller wants to move to Saturday.', { bookingId: booking.bookingId });
    await c.notifications.dispatch();
    expect(sms.sent.find((s) => s.to === '+211955000111')?.body).toMatch(new RegExp(`change request ${booking.pnr}`));

    const app = createApp(c);
    await request(app).get('/api/admin/tickets').expect(401);
    const list = await request(app).get('/api/admin/tickets?status=open').set(staff).expect(200);
    expect(list.body.tickets.map((t: { id: string }) => t.id)).toContain(ticket.ticketId);

    const detail = await request(app).get(`/api/admin/tickets/${ticket.ticketId}`).set(staff).expect(200);
    expect(detail.body.booking).toMatchObject({ pnr: booking.pnr, contact: { phone: CONTACT.phone } });
    expect(JSON.stringify(detail.body)).not.toContain('R00123456'); // no passport numbers on the desk

    // Changes need a staff name for the audit trail.
    await request(app).patch(`/api/admin/tickets/${ticket.ticketId}`).set({ authorization: staff.authorization }).send({ status: 'in_progress' }).expect(400);
    const upd = await request(app).patch(`/api/admin/tickets/${ticket.ticketId}`).set(staff).send({ status: 'in_progress', assignee: 'Mary Akol' }).expect(200);
    expect(upd.body.ticket).toMatchObject({ status: 'in_progress', assignee: 'Mary Akol' });

    await request(app).post(`/api/admin/tickets/${ticket.ticketId}/messages`).set(staff).send({ text: 'Saturday is available for USD 40 more. Reply to confirm.' }).expect(201);
    await c.notifications.dispatch();
    expect(sms.sent.at(-1)).toEqual({ to: CONTACT.phone, body: 'BluckFlies: Saturday is available for USD 40 more. Reply to confirm.' });

    const done = await request(app).patch(`/api/admin/tickets/${ticket.ticketId}`).set(staff).send({ status: 'resolved' }).expect(200);
    expect(done.body.ticket.resolvedAt).toBeTruthy();
    const notes = (await request(app).get(`/api/admin/tickets/${ticket.ticketId}`).set(staff).expect(200)).body.notes;
    expect(notes.map((n: { author: string; body: string }) => `${n.author}: ${n.body}`)).toEqual([
      'Mary Akol (admin token): status → in_progress, assignee → Mary Akol',
      'Mary Akol (admin token): SMS to traveller: Saturday is available for USD 40 more. Reply to confirm.',
      'Mary Akol (admin token): status → resolved',
    ]);
  });

  it('lets the agent attach only the traveller\'s own booking to a change request', async () => {
    const llm = new ScriptedLlm([
      (req) => toolCall('handoff_to_human', { reason: 'change_request', summary: 'Move the flight to Saturday please.', booking_reference: (req.messages[0]?.content as string).slice(-6) }),
      text('A BluckFlies agent will contact you.'),
      () => toolCall('handoff_to_human', { reason: 'change_request', summary: 'Someone else wants this booking.', booking_reference: pnr }),
      text('I could not find that booking.'),
    ]);
    const { c } = testContainer({ llm });
    const booking = await heldBookingFor(c, 'ses_owner');
    const pnr = booking.pnr;
    await c.agent?.handle('ses_owner', `Change my booking ${pnr}`);
    const [ticket] = await c.support.list('open');
    expect((await c.support.detail(ticket?.id ?? '')).booking?.pnr).toBe(pnr);

    await c.agent?.handle('ses_intruder', `Change booking ${pnr}`);
    expect(await c.support.list('open')).toHaveLength(1); // the intruder's request was refused (NOT_FOUND)
  });
});

// -------------------------------------------------------------- accounts

describe('phone login', () => {
  it('logs in with an SMS code, and bookings follow the traveller to another device', async () => {
    const sms = new RecordingSms();
    const { c } = testContainer({ sms });
    const app = createApp(c);
    const phoneA = await session(app);

    // Book on device A while anonymous.
    const sidA = (await c.sessions.findByTokenHash(hashOf(phoneA)))?.id ?? '';
    const booking = await heldBookingFor(c, sidA);

    const start = await request(app).post('/api/auth/otp/start').set(phoneA).send({ phone: '0912 345 678' }).expect(202);
    expect(start.body.phone).toBe('+211****678');
    expect(sms.sent.at(-1)?.to).toBe('+211912345678');
    await request(app).post('/api/auth/otp/verify').set(phoneA).send({ challengeId: start.body.challengeId, code: sms.lastCode() }).expect(200);

    // Device B logs in with the same number and sees the booking.
    const phoneB = await session(app);
    expect((await request(app).get('/api/bookings').set(phoneB).expect(200)).body.bookings).toHaveLength(0);
    const startB = await request(app).post('/api/auth/otp/start').set(phoneB).send({ phone: '+211912345678' }).expect(202);
    const verified = await request(app).post('/api/auth/otp/verify').set(phoneB).send({ challengeId: startB.body.challengeId, code: sms.lastCode() }).expect(200);
    expect(verified.body.account.phone).toBe('+211****678');
    const seen = (await request(app).get('/api/bookings').set(phoneB).expect(200)).body.bookings;
    expect(seen.map((b: { pnr: string }) => b.pnr)).toEqual([booking.pnr]);
    await request(app).get(`/api/bookings/${booking.pnr}`).set(phoneB).expect(200);

    // Logout ends the session; the booking stays with the account.
    await request(app).post('/api/auth/logout').set(phoneB).expect(204);
    await request(app).get('/api/bookings').set(phoneB).expect(401);
  });

  it('limits guesses, is single use, and only works for the session that asked', async () => {
    const sms = new RecordingSms();
    const { c, clock } = testContainer({ sms });
    const app = createApp(c);
    const a = await session(app);
    const other = await session(app);
    const start = await request(app).post('/api/auth/otp/start').set(a).send({ phone: '+211912000001' }).expect(202);
    const code = sms.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';

    await request(app).post('/api/auth/otp/verify').set(other).send({ challengeId: start.body.challengeId, code }).expect(400);
    for (let i = 0; i < 4; i++) {
      const r = await request(app).post('/api/auth/otp/verify').set(a).send({ challengeId: start.body.challengeId, code: wrong }).expect(400);
      expect(r.body.error.message).toMatch(/tries left/);
    }
    const last = await request(app).post('/api/auth/otp/verify').set(a).send({ challengeId: start.body.challengeId, code: wrong }).expect(400);
    expect(last.body.error.message).toMatch(/Too many wrong codes/);
    await request(app).post('/api/auth/otp/verify').set(a).send({ challengeId: start.body.challengeId, code }).expect(400); // locked even with the right code

    const again = await request(app).post('/api/auth/otp/start').set(a).send({ phone: '+211912000001' }).expect(202);
    const good = sms.lastCode();
    await request(app).post('/api/auth/otp/verify').set(a).send({ challengeId: again.body.challengeId, code: good }).expect(200);
    await request(app).post('/api/auth/otp/verify').set(a).send({ challengeId: again.body.challengeId, code: good }).expect(400); // single use

    const third = await request(app).post('/api/auth/otp/start').set(a).send({ phone: '+211912000001' }).expect(202);
    clock.advanceMinutes(11);
    await request(app).post('/api/auth/otp/verify').set(a).send({ challengeId: third.body.challengeId, code: sms.lastCode() }).expect(400); // expired
    // Three codes per number per 15 minutes (counted per phone, not per session or IP).
    clock.advanceMinutes(-11);
    const r = await request(app).post('/api/auth/otp/start').set(other).send({ phone: '+211912000001' }).expect(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
  });

  it('stores only hashes of codes and encrypted phone numbers', async () => {
    const sms = new RecordingSms();
    const { c } = testContainer({ sms });
    const res = await c.auth.start('ses_a', '+211912000002');
    const stored = await c.repos.otp.find(res.challengeId);
    expect(stored?.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.codeHash).not.toContain(sms.lastCode());
    expect(normalizePhone('0912000002')).toBe('+211912000002');
    expect(normalizePhone('00256 772 123456')).toBe('+256772123456');
    expect(normalizePhone('12')).toBeUndefined();
  });
});

// -------------------------------------------------------------- channels

const AUTH_SECRET = 'k'.repeat(40);
const WA = { AUTH_SECRET, WHATSAPP_ACCESS_TOKEN: 'EAAG'.padEnd(30, 'x'), WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_APP_SECRET: 's'.repeat(32), WHATSAPP_VERIFY_TOKEN: 'v'.repeat(20) };

function waBody(from: string, message: object) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from, ...message }] } }] }] });
}
const sign = (raw: string) => `sha256=${createHmac('sha256', WA.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;
/** Webhooks reply at once and work in the background: wait for the work to show. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for background work');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('WhatsApp and SMS', () => {
  it('verifies the webhook, books through Yes/No buttons, and never lets the model approve', async () => {
    let offerId = '';
    const llm = new ScriptedLlm([
      toolCall('search_flights', { origin: 'JUB', destination: 'NBO', departure_date: FRIDAY }),
      (req) => {
        const last = req.messages.at(-1);
        const block = Array.isArray(last?.content) ? last.content[0] : undefined;
        offerId = JSON.parse(block && 'content' in block ? block.content : '{}').offers[0].offerId;
        return toolCall('propose_reservation', {
          offer_id: offerId,
          passengers: [{ type: 'adult', given_name: 'Akol', family_name: 'Deng', gender: 'm', date_of_birth: '1990-05-12', nationality: 'SS', passport_number: 'R00123456', passport_expiry: '2030-01-01' }],
          contact_phone: '+211912345678',
          contact_email: 'akol@example.com',
        });
      },
      text('Please check the details below and tap Yes to confirm.'),
      text('Your seats are held. You can pay by card or MTN MoMo.'),
    ]);
    const wa = new RecordingChannel();
    const { c } = testContainer({ llm, whatsappSender: wa }, WA);
    const app = createApp(c);

    await request(app).get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '42' }).expect(403);
    const ok = await request(app).get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': WA.WHATSAPP_VERIFY_TOKEN, 'hub.challenge': '42' }).expect(200);
    expect(ok.text).toBe('42');

    const first = waBody('211912345678', { id: 'wamid.1', type: 'text', text: { body: 'Juba to Nairobi Friday, Akol Deng' } });
    await request(app).post('/api/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', 'sha256=' + '0'.repeat(64)).send(first).expect(401);
    await request(app).post('/api/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(first)).send(first).expect(200);
    // A redelivery of the same message is ignored.
    await request(app).post('/api/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(first)).send(first).expect(200);
    await until(() => wa.sent.length >= 2);
    await new Promise((r) => setTimeout(r, 50)); // give a (wrongly) repeated turn time to show up

    expect(wa.sent[0]?.reply.text).toBe('Please check the details below and tap Yes to confirm.');
    const buttons = wa.sent[1]?.reply.buttons ?? [];
    expect(buttons.map((b) => b.title)).toEqual(['✓ Yes', '✗ No']);
    expect(llm.requests).toHaveLength(3); // the redelivery did not start another turn
    expect(llm.requests[0]?.system).toContain('## WhatsApp conversation');

    // Nothing is booked until the traveller taps Yes.
    const sessionId = (await c.repos.sessions.findByChannelKey(keyedHash(AUTH_SECRET, 'whatsapp', '+211912345678')))?.id ?? '';
    expect(await c.bookings.list(sessionId)).toHaveLength(0);
    const tap = waBody('211912345678', { id: 'wamid.2', type: 'interactive', interactive: { button_reply: { id: buttons[0]?.id ?? '', title: '✓ Yes' } } });
    await request(app).post('/api/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(tap)).send(tap).expect(200);
    await until(() => wa.sent.length >= 3);
    const bookings = await c.bookings.list(sessionId);
    expect(bookings.map((b) => b.status)).toEqual(['held']);
    expect(wa.sent.at(-1)?.reply.text).toBe('Your seats are held. You can pay by card or MTN MoMo.');
    // The sender's number is their account: their bookings appear after phone login on the web too.
    expect((await c.repos.sessions.findById(sessionId))?.travellerId).toBeTruthy();
  });

  it('asks for text when a voice note arrives', async () => {
    const wa = new RecordingChannel();
    const { c } = testContainer({ llm: new ScriptedLlm([]), whatsappSender: wa }, WA);
    const app = createApp(c);
    const body = waBody('211912345678', { id: 'wamid.v', type: 'audio' });
    await request(app).post('/api/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sign(body)).send(body).expect(200);
    await until(() => wa.sent.length >= 1);
    expect(wa.sent[0]?.reply.text).toMatch(/send your message as text[\s\S]*أرسل رسالتك كنص/);
  });

  it('accepts only Twilio-signed SMS and answers by SMS', async () => {
    const sms = new RecordingSms();
    const llm = new ScriptedLlm([text('Hello! Where would you like to fly?')]);
    const env = { TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 't'.repeat(32), TWILIO_FROM: '+15005550006', SMS_CHANNEL_ENABLED: 'true', PUBLIC_BASE_URL: 'https://bluckflies.example' };
    const { c } = testContainer({ llm, sms }, env);
    const app = createApp(c);
    const params = { MessageSid: 'SM1', From: '+211912345678', Body: 'Hi' };
    const signature = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update('https://bluckflies.example/api/webhooks/sms' + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join('')).digest('base64');
    await request(app).post('/api/webhooks/sms').type('form').set('x-twilio-signature', 'bad').send(params).expect(401);
    await request(app).post('/api/webhooks/sms').type('form').set('x-twilio-signature', signature).send(params).expect(200);
    await until(() => sms.sent.length >= 1);
    expect(sms.sent).toEqual([{ to: '+211912345678', body: 'Hello! Where would you like to fly?' }]);
    expect(llm.requests[0]?.system).toContain('## SMS conversation');
  });

  it('parses and verifies provider payloads strictly', () => {
    expect(parseWhatsAppWebhook({ object: 'page', entry: [] })).toEqual([]);
    expect(parseWhatsAppWebhook(JSON.parse(waBody('211912345678', { id: 'x', type: 'text', text: { body: 'hi' } })))).toEqual([{ id: 'x', from: '+211912345678', kind: 'text', text: 'hi' }]);
    const raw = Buffer.from('{"a":1}');
    expect(verifyWhatsAppSignature(raw, sign('{"a":1}'), WA.WHATSAPP_APP_SECRET)).toBe(true);
    expect(verifyWhatsAppSignature(raw, sign('{"a":2}'), WA.WHATSAPP_APP_SECRET)).toBe(false);
    expect(verifyTwilioSignature('tok', 'https://x/y', { A: '1' }, undefined)).toBe(false);
  });
});

describe('configuration', () => {
  const base = { PAYMENT_WEBHOOK_SECRET: 'x'.repeat(40) };
  it('requires complete provider settings', () => {
    expect(() => loadConfig({ ...base, TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}` })).toThrow(/TWILIO_.*together/);
    expect(() => loadConfig({ ...base, SMS_CHANNEL_ENABLED: 'true' })).toThrow(/SMS_CHANNEL_ENABLED needs/);
    expect(() => loadConfig({ ...base, WHATSAPP_ACCESS_TOKEN: 'EAAG'.padEnd(30, 'x') })).toThrow(/WHATSAPP_.*together/);
    expect(() => loadConfig({ ...base, RESEND_API_KEY: 're_abc' })).toThrow(/EMAIL_FROM together/);
    expect(loadConfig({ ...base, SUPPORT_ALERT_EMAILS: 'a@b.co, c@d.co' }).SUPPORT_ALERT_EMAILS).toEqual(['a@b.co', 'c@d.co']);
    expect(() => loadConfig({ ...base, SUPPORT_ALERT_PHONES: '0912' })).toThrow(/E\.164/);
  });
});

function hashOf(h: { authorization: string }): string {
  return hashToken(h.authorization.slice(7));
}
