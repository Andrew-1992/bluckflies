import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import type { ContactDetails } from '../src/domain/types.js';
import { createApp } from '../src/http/app.js';
import { SendError, type EmailMessage, type EmailSender, type SmsSender } from '../src/providers/notify/senders.js';
import { retryDelayMs } from '../src/services/notifications/NotificationService.js';
import { adult, CONTACT, FRIDAY, ONE_ADULT, ScriptedLlm, testContainer, text, toolCall } from './helpers.js';

const SID = 'ses_owner';

async function held(c: Container, contact: ContactDetails = CONTACT) {
  const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const offerId = r.offers[0]?.offerId ?? '';
  const p = await c.confirmations.proposeReservation(SID, offerId, [adult()], contact);
  return c.confirmations.approve(SID, p.confirmationId);
}

async function pay(c: Container, pnr: string, at: Date) {
  await c.payments.initiate(await c.bookings.getOwned(SID, pnr), 'zain_mgurush', '+211922222222');
  const booking = await c.bookings.getOwned(SID, pnr);
  const payment = await c.payments.latestForBooking(booking.id);
  const raw = JSON.stringify({ id: `evt_${pnr}`, type: 'payment.succeeded', data: { providerReference: payment?.providerReference, amountMinor: payment?.charge.amountMinor, currency: payment?.charge.currency } });
  await c.payments.handleSandboxWebhook(raw, c.payments.sign(raw, Math.floor(at.getTime() / 1000)));
}

class FlakyEmail implements EmailSender {
  readonly name = 'flaky';
  readonly delivers = true;
  readonly sent: EmailMessage[] = [];
  failures: Array<SendError | Error> = [];
  async send(m: EmailMessage) {
    const f = this.failures.shift();
    if (f) throw f;
    this.sent.push(m);
  }
}

class RecordingSms implements SmsSender {
  readonly name = 'rec';
  readonly delivers = true;
  readonly sent: Array<{ to: string; body: string }> = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
  }
}

describe('e-tickets and booking messages', () => {
  it('sends "seats held", then the e-ticket by email and SMS once paid', async () => {
    const email = new FlakyEmail();
    const sms = new RecordingSms();
    const { c, clock } = testContainer({ email, sms });
    const b = await held(c);
    await c.notifications.dispatch();
    expect(email.sent.map((m) => m.subject)).toEqual([`BluckFlies: seats held, booking ${b.pnr}`]);
    expect(email.sent[0]?.text).toMatch(/Pay before/);
    expect(sms.sent[0]?.to).toBe(CONTACT.phone);

    await pay(c, b.pnr, clock.now());
    await c.notifications.dispatch();
    const ticket = email.sent.find((m) => m.subject.includes('your ticket is ready'));
    const view = await c.bookings.view(SID, b.pnr);
    expect(view.status).toBe('ticketed');
    expect(ticket?.to).toBe(CONTACT.email);
    expect(ticket?.text).toContain(view.ticketNumbers[0] ?? 'missing');
    expect(ticket?.text).toContain(b.pnr);
    expect(sms.sent.some((s) => s.body.includes('ticket ready') && s.body.includes(view.ticketNumbers[0] ?? 'missing'))).toBe(true);
  });

  it('writes the messages in Arabic when the traveller speaks Arabic', async () => {
    const email = new FlakyEmail();
    const { c, clock } = testContainer({ email, sms: new RecordingSms() });
    const b = await held(c, { ...CONTACT, language: 'ar' });
    await pay(c, b.pnr, clock.now());
    await c.notifications.dispatch();
    expect(email.sent.at(-1)?.subject).toBe(`بلك فلايز: تذكرتك جاهزة ${b.pnr}`);
    expect(email.sent.at(-1)?.text).toMatch(/أرقام التذاكر/);
  });

  it('retries temporary failures with backoff and gives up on permanent ones', async () => {
    const email = new FlakyEmail();
    const { c, clock } = testContainer({ email, sms: new RecordingSms() });
    email.failures = [new SendError('HTTP 503', true)];
    await held(c);
    expect(await c.notifications.dispatch()).toMatchObject({ sent: 1, retried: 1 }); // SMS sent, email rescheduled
    expect(await c.notifications.dispatch()).toMatchObject({ sent: 0 }); // not due yet
    clock.advanceMinutes(1);
    expect(await c.notifications.dispatch()).toMatchObject({ sent: 1 });
    expect(email.sent).toHaveLength(1);

    email.failures = [new SendError('HTTP 422 invalid recipient', false)];
    const second = await held(c);
    expect(await c.notifications.dispatch()).toMatchObject({ failed: 1 });
    clock.advanceMinutes(120);
    await c.notifications.dispatch();
    expect(email.sent.some((m) => m.subject.includes(second.pnr))).toBe(false);
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(20)).toBe(60 * 60_000);
  });

  it('never queues the same message twice, and backfills messages missed by a crash', async () => {
    const email = new FlakyEmail();
    const { c, clock } = testContainer({ email, sms: new RecordingSms() });
    const b = await held(c);
    await pay(c, b.pnr, clock.now());
    await c.notifications.dispatch();
    const ticketMails = () => email.sent.filter((m) => m.subject.includes('ticket is ready')).length;
    expect(ticketMails()).toBe(1);
    // Backfill finds nothing missing, and re-raising the event changes nothing.
    expect(await c.notifications.backfill()).toEqual({ queued: 0 });
    const booking = await c.bookings.getOwned(SID, b.pnr);
    await c.notifications.onBooking('ticketed', booking);
    await c.notifications.dispatch();
    expect(ticketMails()).toBe(1);
  });

  it('backfills a ticketed booking that has no message yet', async () => {
    const email = new FlakyEmail();
    const sms = new RecordingSms();
    const { c, clock } = testContainer({ email, sms });
    const b = await held(c);
    await pay(c, b.pnr, clock.now());
    // Simulate the crash window: build a second container on the same store without messages.
    const { c: fresh } = testContainer({ email, sms, repositories: { ...c.repos, notifications: emptyOutbox() } });
    expect(await fresh.notifications.backfill()).toEqual({ queued: 1 });
  });
});

function emptyOutbox(): Container['repos']['notifications'] {
  const rows: Parameters<Container['repos']['notifications']['enqueue']>[0][] = [];
  return {
    enqueue: async (n) => (rows.some((r) => r.dedupeKey === n.dedupeKey) ? false : (rows.push(n), true)),
    due: async () => [],
    markSent: async () => undefined,
    markAttemptFailed: async () => undefined,
    existingKeys: async (keys) => new Set(rows.filter((r) => keys.includes(r.dedupeKey)).map((r) => r.dedupeKey)),
    deleteFinishedBefore: async () => 0,
  };
}

describe('return trips and chat history', () => {
  it('returns every search in a turn, so outbound and return both reach the screen', async () => {
    const llm = new ScriptedLlm([
      { content: [
          { type: 'tool_use', id: 'tu_out', name: 'search_flights', input: { origin: 'JUB', destination: 'NBO', departure_date: FRIDAY } },
          { type: 'tool_use', id: 'tu_back', name: 'search_flights', input: { origin: 'NBO', destination: 'JUB', departure_date: '2026-11-13' } },
        ], stopReason: 'tool_use' },
      text('Here are flights out on Friday and back the following Friday.'),
    ]);
    const { c } = testContainer({ llm });
    const app = createApp(c);
    const token = (await request(app).post('/api/sessions').expect(201)).body.token as string;
    const auth = { authorization: `Bearer ${token}` };
    const res = await request(app).post('/api/chat').set(auth).send({ message: 'Juba to Nairobi Friday, back the next Friday' }).expect(200);
    expect(res.body.searches.map((s: { origin: { code: string } }) => s.origin.code)).toEqual(['JUB', 'NBO']);

    // After a refresh the conversation comes back as text, without tool internals.
    const history = await request(app).get('/api/chat/history').set(auth).expect(200);
    expect(history.body.messages).toEqual([
      { role: 'traveller', text: 'Juba to Nairobi Friday, back the next Friday' },
      { role: 'agent', text: 'Here are flights out on Friday and back the following Friday.' },
    ]);
    expect(JSON.stringify(history.body)).not.toMatch(/tool_use|offerId|off_/);
  });

  it('records the traveller language on the booking for messages', async () => {
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
          contact_phone: CONTACT.phone,
          contact_email: CONTACT.email,
          contact_language: 'ar',
        });
      },
      text('راجع التفاصيل واضغط تأكيد.'),
    ]);
    const { c } = testContainer({ llm });
    await c.agent?.handle(SID, 'أريد رحلة من جوبا إلى نيروبي');
    const [pending] = await c.confirmations.listPending(SID);
    const view = await c.confirmations.approve(SID, pending?.confirmationId ?? '');
    expect((await c.bookings.getOwned(SID, view.pnr)).contact.language).toBe('ar');
  });
});
