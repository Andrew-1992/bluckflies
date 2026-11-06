import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import type { EmailSender } from '../src/providers/notify/senders.js';
import { adult, CONTACT, FixedClock, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';

/**
 * Refunds the payment provider cannot make (bank transfer, office cash) are
 * paid by staff. Before this, nothing could record them: the payment stayed
 * "refund requested" for ever and the traveller never heard it was done.
 */
const SID = 'ses_owner';
const ADMIN = 'a'.repeat(40);
const desk = { authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Mary Akol' };
const ENV = {
  ADMIN_API_TOKEN: ADMIN,
  STAFF_REQUIRE_2FA: 'false',
  BANK_NAME: 'KCB Bank South Sudan',
  BANK_ACCOUNT_NAME: 'BluckFlies Ltd',
  BANK_ACCOUNT_NUMBER: '1234567890',
  CASH_OFFICES: 'BluckFlies Juba | Hai Malakal, Juba | Mon-Sat 08:00-17:00',
};

class RecordingEmail implements EmailSender {
  readonly name = 'recording';
  readonly delivers = true;
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(m: { to: string; subject: string; text: string }) {
    this.sent.push(m);
  }
}

/** Cash paid at the office after the seat hold ended: the money must go back, by hand. */
async function lateCashPayment(c: Container, clock: FixedClock) {
  const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
  const b = await c.bookings.getOwned(SID, (await c.confirmations.approve(SID, p.confirmationId)).pnr);
  await c.payments.initiate(b, 'cash_office', CONTACT.phone);
  clock.advanceMinutes(24 * 60); // the seat hold has ended
  expect((await c.bookings.getOwned(SID, b.pnr)).status).toBe('expired');
  await c.payments.settleManualPayment(b.id, { received: true, amount: { amountMinor: b.offer.totalPrice.amountCents, currency: 'USD' }, reference: 'R-0042' });
  const ticket = (await c.repos.tickets.list({ limit: 50 })).find((t) => t.bookingId === b.id && t.reason === 'payment_issue');
  if (!ticket) throw new Error('no refund ticket');
  return { booking: b, ticketId: ticket.id };
}

describe('refunds paid by hand', () => {
  it('records the refund from the desk ticket, marks the booking refunded and tells the traveller', async () => {
    const email = new RecordingEmail();
    const { c, clock } = testContainer({ email }, ENV);
    const app = createApp(c);
    const { booking, ticketId } = await lateCashPayment(c, clock);

    const before = (await request(app).get(`/api/admin/tickets/${ticketId}`).set(desk).expect(200)).body;
    expect(before.payment).toMatchObject({ status: 'refund_requested', refundByHand: true });

    await request(app).post(`/api/admin/tickets/${ticketId}/refund-paid`).set(desk).send({ reference: 'RF-0007', note: 'Paid at Hai Malakal office' }).expect(200);

    const after = (await request(app).get(`/api/admin/tickets/${ticketId}`).set(desk).expect(200)).body;
    expect(after.payment).toMatchObject({ status: 'refunded', refundByHand: false });
    expect(after.ticket.status).toBe('resolved');
    expect(after.notes).toContainEqual(expect.objectContaining({ author: 'Mary Akol (admin token)', body: 'Refund paid by hand (cash office), reference RF-0007. Paid at Hai Malakal office' }));
    expect((await c.bookings.getOwned(SID, booking.pnr)).status).toBe('refunded');
    const payment = await c.payments.latestForBooking(booking.id);
    expect(payment?.refundReference).toMatch(/^manual:pay_\w+:RF-0007$/);
    expect(payment?.refundedAt).toBeDefined();

    await c.notifications.dispatch();
    expect(email.sent.some((m) => m.to === CONTACT.email && /refund/i.test(m.subject))).toBe(true);

    // Twice is refused: the refund is already recorded.
    const again = await request(app).post(`/api/admin/tickets/${ticketId}/refund-paid`).set(desk).send({ reference: 'RF-0007' }).expect(409);
    expect(again.body.error.message).toMatch(/no refund waiting/);
    // The refund no longer shows as owed.
    const owed = await c.reports.csv('refunds-owed', '', '');
    expect(owed.body).not.toContain(booking.pnr);
  });

  it('needs a reference, and partner agents cannot record refunds', async () => {
    const { c, clock } = testContainer({}, ENV);
    const app = createApp(c);
    const { ticketId } = await lateCashPayment(c, clock);
    await request(app).post(`/api/admin/tickets/${ticketId}/refund-paid`).set(desk).send({}).expect(400);
    await c.staff.create('t', { email: 'partner@nile.example', name: 'Nile Travel', role: 'partner', password: 'correct horse battery' });
    const token = (await request(app).post('/api/staff/login').send({ email: 'partner@nile.example', password: 'correct horse battery' })).body.token as string;
    await request(app).post(`/api/admin/tickets/${ticketId}/refund-paid`).set('authorization', `Bearer ${token}`).send({ reference: 'RF-1' }).expect(403);
  });

  it('refuses refunds the payment provider makes itself', async () => {
    const { c } = testContainer({}, ENV);
    const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
    const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
    const b = await c.bookings.getOwned(SID, (await c.confirmations.approve(SID, p.confirmationId)).pnr);
    await expect(c.payments.completeManualRefund(b.id, 'X')).rejects.toThrow(/no refund waiting/);
  });
});
