import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { parseCashOffices } from '../src/providers/payments/CashOfficePaymentProvider.js';
import { mentionsCode, parseCsv, parseStatement } from '../src/services/statements.js';
import { adult, CONTACT, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';

const SID = 'ses_owner';
const ADMIN = 'a'.repeat(40);
const desk = { authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Mary Akol' };
const ENV = {
  ADMIN_API_TOKEN: ADMIN,
  BANK_NAME: 'KCB Bank South Sudan',
  BANK_ACCOUNT_NAME: 'BluckFlies Ltd',
  BANK_ACCOUNT_NUMBER: '1234567890',
  CASH_OFFICES: 'BluckFlies Juba | Hai Malakal, Juba | Mon-Sat 08:00-17:00; Nile Travel (partner) | Konyo Konyo market, Juba | Daily 09:00-18:00',
};

async function heldBooking(c: Container, destination = 'NBO') {
  const r = await c.search.search(SID, { origin: 'JUB', destination, departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
  const view = await c.confirmations.approve(SID, p.confirmationId);
  return c.bookings.getOwned(SID, view.pnr);
}

const usd = (minor: number) => (minor / 100).toFixed(2);
const ticketFor = async (c: Container, bookingId: string) => (await c.repos.tickets.list({ limit: 50 })).find((t) => t.bookingId === bookingId)?.id ?? '';

// ------------------------------------------------------------- office cash

describe('cash at a BluckFlies office or partner agent', () => {
  it('lists the offices for the traveller and puts the payment on the desk', async () => {
    const { c } = testContainer({}, ENV);
    const booking = await heldBooking(c);
    const view = await c.payments.initiate(booking, 'cash_office', CONTACT.phone);
    expect(view.provider).toBe('cash_office');
    expect(view.cashOffices).toEqual([
      { name: 'BluckFlies Juba', address: 'Hai Malakal, Juba', hours: 'Mon-Sat 08:00-17:00' },
      { name: 'Nile Travel (partner)', address: 'Konyo Konyo market, Juba', hours: 'Daily 09:00-18:00' },
    ]);
    expect(view.instructions).toContain(`booking code ${booking.pnr}`);
    const ticket = (await c.repos.tickets.list({ limit: 10 })).find((t) => t.reason === 'cash_office');
    expect(ticket?.summary).toMatch(/receipt/);
  });

  it('staff confirm with the receipt number; the booking is ticketed and the note names the receipt', async () => {
    const { c } = testContainer({}, ENV);
    const app = createApp(c);
    const booking = await heldBooking(c);
    await c.payments.initiate(booking, 'cash_office', CONTACT.phone);
    const ticketId = await ticketFor(c, booking.id);
    const res = await request(app).post(`/api/admin/tickets/${ticketId}/manual-payment`).set(desk).send({ received: true, amountUsd: usd(booking.offer.totalPrice.amountCents), reference: 'RCPT-000417' }).expect(200);
    expect(res.body).toEqual({ bookingStatus: 'ticketed', paymentStatus: 'succeeded' });
    const detail = (await request(app).get(`/api/admin/tickets/${ticketId}`).set(desk).expect(200)).body;
    expect(detail.notes.map((n: { body: string }) => n.body).join('\n')).toMatch(/Cash payment RECEIVED: USD .*receipt RCPT-000417/);
  });

  it('refuses bank and cash when too little hold time is left, but still allows card', async () => {
    const { c, clock } = testContainer({}, { ...ENV, MANUAL_PAYMENT_MIN_MINUTES: '45' });
    const booking = await heldBooking(c); // 60-minute hold
    clock.advanceMinutes(20); // 40 minutes left
    await expect(c.payments.initiate(booking, 'cash_office', CONTACT.phone)).rejects.toThrow(/Only 40 minutes are left/);
    await expect(c.payments.initiate(booking, 'bank_transfer', CONTACT.phone)).rejects.toThrow(/Pay by card now/);
    expect((await c.payments.initiate(booking, 'card', CONTACT.phone)).method).toBe('card');
  });

  it('validates the office list in configuration', () => {
    expect(parseCashOffices('A | B | C')).toEqual([{ name: 'A', address: 'B', hours: 'C' }]);
    expect(() => parseCashOffices('Only a name')).toThrow(/name \| address \| opening hours/);
    expect(() => loadConfig({ NODE_ENV: 'development', PAYMENT_WEBHOOK_SECRET: 'p'.repeat(40), CASH_OFFICES: 'A | B' })).toThrow(/CASH_OFFICES/);
  });
});

// --------------------------------------------------------- statement import

describe('bank statement matching', () => {
  async function setup() {
    const { c } = testContainer({}, ENV);
    const app = createApp(c);
    const a = await heldBooking(c);
    const b = await heldBooking(c, 'EBB');
    const other = await heldBooking(c, 'ADD');
    for (const bk of [a, b, other]) await c.payments.initiate(bk, 'bank_transfer', CONTACT.phone);
    return { c, app, a, b, other };
  }

  const statement = (rows: string[]) => ['Date,Description,Reference,Debit,Credit,Currency', ...rows].join('\r\n');

  it('previews exact matches without changing anything, then confirms only the selected lines', async () => {
    const { c, app, a, b, other } = await setup();
    const csv = statement([
      `2026-10-30,"CASH DEPOSIT JUBA BRANCH, REF ${a.pnr}",FT001,,${usd(a.offer.totalPrice.amountCents)},USD`,
      `2026-10-30,Transfer from Deng ${b.pnr},FT002,,"${(Number(usd(b.offer.totalPrice.amountCents)) - 10).toLocaleString('en-US', { minimumFractionDigits: 2 })}",USD`,
      `2026-10-30,Office rent,FT003,1500.00,,USD`,
      `2026-10-30,Unknown deposit,FT004,,250.00,USD`,
      `2026-10-30,Second deposit ${a.pnr},FT005,,${usd(a.offer.totalPrice.amountCents)},USD`,
    ]);
    const preview = (await request(app).post('/api/admin/payments/bank-statement').set(desk).set('content-type', 'text/csv').send(csv).expect(200)).body;
    expect(preview).toMatchObject({ linesRead: 5, unrelatedCredits: 1, applied: 0, columns: { amount: 'Credit', reference: 'Reference' } });
    const byPnr = (pnr: string) => preview.matches.filter((m: { pnr: string }) => m.pnr === pnr);
    expect(byPnr(a.pnr).map((m: { status: string }) => m.status)).toEqual(['match', 'duplicate']);
    expect(byPnr(b.pnr)[0]).toMatchObject({ status: 'amount_differs', bankReference: 'FT002' });
    expect(byPnr(other.pnr)).toEqual([]);
    expect((await c.bookings.view(SID, a.pnr)).status).toBe('payment_pending'); // preview changes nothing

    // Apply: the exact match plus (deliberately) the mismatched line; only the exact one is confirmed.
    const ids = [byPnr(a.pnr)[0].lineId, byPnr(b.pnr)[0].lineId].join(',');
    const applied = (await request(app).post(`/api/admin/payments/bank-statement?apply=${ids}`).set(desk).set('content-type', 'text/csv').send(csv).expect(200)).body;
    expect(applied.applied).toBe(1);
    expect((await c.bookings.view(SID, a.pnr)).status).toBe('ticketed');
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending');
    expect(applied.matches.find((m: { pnr: string; status: string }) => m.pnr === b.pnr)?.error).toMatch(/Not applied/);

    // The desk ticket records who confirmed it and the bank reference.
    const ticketId = await ticketFor(c, a.id);
    const detail = (await request(app).get(`/api/admin/tickets/${ticketId}`).set(desk).expect(200)).body;
    expect(detail.ticket.status).toBe('resolved');
    expect(detail.notes.map((n: { author: string; body: string }) => `${n.author}: ${n.body}`).join('\n')).toMatch(/Mary Akol \(admin token\): Bank transfer RECEIVED: USD .*bank reference FT001.*bank statement import/);

    // Importing the same statement again cannot confirm twice.
    const again = (await request(app).post(`/api/admin/payments/bank-statement?apply=${byPnr(a.pnr)[0].lineId}`).set(desk).set('content-type', 'text/csv').send(csv).expect(200)).body;
    expect(again.applied).toBe(0);
    expect(again.matches.find((m: { pnr: string }) => m.pnr === a.pnr)?.status).toBe('already_confirmed');
  });

  it('rejects files it cannot read, with a clear reason', async () => {
    const { app } = await setup();
    const bad = await request(app).post('/api/admin/payments/bank-statement').set(desk).set('content-type', 'text/csv').send('Date,Description\n2026-10-30,hello\n').expect(400);
    expect(bad.body.error.message).toMatch(/amount column/);
    await request(app).post('/api/admin/payments/bank-statement').set(desk).set('content-type', 'text/csv').send('x').expect(400);
    await request(app).post('/api/admin/payments/bank-statement?apply=not-an-id').set(desk).set('content-type', 'text/csv').send('a,b').expect(400);
    await request(app).post('/api/admin/payments/bank-statement').set('content-type', 'text/csv').send('a,b').expect(401);
  });

  it('parses quoted CSV and signed amounts, and finds booking codes only as whole words', () => {
    expect(parseCsv('a,"b, ""c""",d\r\n1,2,3\n')).toEqual([['a', 'b, "c"', 'd'], ['1', '2', '3']]);
    const s = parseStatement('Posting Date,Narration,Amount\n2026-10-30,DEP ABC234,412.50\n2026-10-30,FEE,-5.00\n2026-10-30,REF (12.00),(12.00)\n');
    expect(s.lines.map((l) => l.creditMinor)).toEqual([41250, undefined, undefined]);
    expect(mentionsCode('DEPOSIT ABC234 JUBA', 'ABC234')).toBe(true);
    expect(mentionsCode('XABC2345', 'ABC234')).toBe(false);
  });
});
