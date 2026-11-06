import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { createAlertingLogger } from '../src/lib/alertingLogger.js';
import { silentLogger } from '../src/lib/logger.js';
import { SandboxFlightProvider } from '../src/providers/flights/SandboxFlightProvider.js';
import type { EmailSender, SmsSender } from '../src/providers/notify/senders.js';
import type { LlmClient } from '../src/agent/llm.js';
import { adult, CONTACT, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';

const SID = 'ses_owner';
const OPS = { OPS_ALERT_EMAILS: 'ops@bluckflies.com', OPS_ALERT_PHONES: '+211955000999', BANK_NAME: 'KCB', BANK_ACCOUNT_NAME: 'BluckFlies Ltd', BANK_ACCOUNT_NUMBER: '1234567890' };

class RecordingEmail implements EmailSender {
  readonly name = 'recording';
  readonly delivers = true;
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(m: { to: string; subject: string; text: string }) {
    this.sent.push(m);
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

/** Lets alert work queued by fire-and-forget log hooks finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('operations alerts', () => {
  it('alerts the operations team once, and opens a desk ticket, when a paid booking cannot be ticketed', async () => {
    const flights = new SandboxFlightProvider();
    const email = new RecordingEmail();
    const sms = new RecordingSms();
    const { c, clock } = testContainer({ flights, email, sms }, OPS);
    const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
    const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
    const view = await c.confirmations.approve(SID, p.confirmationId);
    const booking = await c.bookings.getOwned(SID, view.pnr);
    await c.payments.initiate(booking, 'bank_transfer', CONTACT.phone);

    flights.failNextIssuances = 100; // supplier down
    await c.payments.settleManualPayment(booking.id, { received: true, amount: { amountMinor: booking.offer.totalPrice.amountCents, currency: 'USD' }, reference: 'FT1' });
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('ticketing');

    clock.advanceMinutes(30);
    await c.reconciliation.run();
    await settle();
    clock.advanceMinutes(10);
    await c.reconciliation.run(); // still failing: no second alert
    await settle();
    await c.notifications.dispatch();

    const alerts = email.sent.filter((m) => m.to === 'ops@bluckflies.com');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subject).toBe(`[BluckFlies ALERT] Paid booking not ticketed (${booking.pnr})`);
    expect(alerts[0]?.text).toMatch(/issue or refund/);
    expect(alerts[0]?.text).not.toContain(CONTACT.phone);
    expect(sms.sent.filter((s) => s.to === '+211955000999')).toHaveLength(1);
    const tickets = (await c.repos.tickets.list({ limit: 20 })).filter((t) => t.reason === 'system_alert');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.bookingId).toBe(booking.id);
  });

  it('turns AI provider failures into a clear "assistant unavailable" answer and one alert per hour', async () => {
    const failing: LlmClient = {
      createMessage: async () => {
        throw Object.assign(new Error('Your credit balance is too low'), { status: 400 });
      },
    };
    const email = new RecordingEmail();
    const { c, clock } = testContainer({ llm: failing, email }, OPS);
    const app = createApp(c);
    const token = (await request(app).post('/api/sessions').expect(201)).body.token as string;
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'Juba to Nairobi' }).expect(503);
      expect(res.body.error.code).toBe('AGENT_UNAVAILABLE');
      expect(res.body.error.message).toMatch(/step by step/);
    }
    await settle();
    clock.advanceMinutes(61);
    await request(app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'Hello' }).expect(503);
    await settle();
    await c.notifications.dispatch();
    const subjects = email.sent.filter((m) => m.to === 'ops@bluckflies.com').map((m) => m.subject);
    expect(subjects).toEqual(['[BluckFlies ALERT] AI assistant unavailable', '[BluckFlies ALERT] AI assistant unavailable']);
  });

  it('never alerts about failures of alert messages themselves, and a broken alert sink never breaks the caller', async () => {
    const email = new RecordingEmail();
    const { c } = testContainer({ email }, OPS);
    const sink = createAlertingLogger(silentLogger);
    sink.attach(() => {
      throw new Error('sink exploded');
    });
    expect(() => sink.error('payment.amount_mismatch', { paymentId: 'pay_1' })).not.toThrow();

    // A failed alert email must not raise another alert (no loops).
    const log = createAlertingLogger(silentLogger);
    const raised: string[] = [];
    log.attach((event, ctx) => raised.push(`${event}:${String(ctx['key'])}`));
    log.error('notification.failed', { key: 'alert:duffel.auth_failed:2026-10-30T10:email:ops@bluckflies.com' });
    expect(raised).toHaveLength(1); // the sink sees it…
    c.alerts.onLog('notification.failed', { key: 'alert:duffel.auth_failed:x' });
    await settle();
    await c.notifications.dispatch();
    expect(email.sent).toHaveLength(0); // …but AlertService ignores it
  });
});
