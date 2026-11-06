import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { toCsv } from '../src/lib/csv.js';
import { parseCsv } from '../src/services/statements.js';
import { adult, CONTACT, FixedClock, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';

const SID = 'ses_owner';
const ADMIN = 'a'.repeat(40);
const admin = { authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Finance' };
const ENV = { ADMIN_API_TOKEN: ADMIN, BANK_NAME: 'KCB', BANK_ACCOUNT_NAME: 'BluckFlies Ltd', BANK_ACCOUNT_NUMBER: '1234567890', STAFF_REQUIRE_2FA: 'false', MANUAL_PAYMENT_MIN_MINUTES: '10' };

async function held(c: Container, destination: string) {
  const r = await c.search.search(SID, { origin: 'JUB', destination, departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
  const v = await c.confirmations.approve(SID, p.confirmationId);
  return c.bookings.getOwned(SID, v.pnr);
}
const paid = (c: Container, b: Awaited<ReturnType<typeof held>>) =>
  c.payments.settleManualPayment(b.id, { received: true, amount: { amountMinor: b.offer.totalPrice.amountCents, currency: 'USD' }, reference: 'REF' });

function parse(csv: string): string[][] {
  return parseCsv(csv);
}
const get = (app: ReturnType<typeof createApp>, path: string) => request(app).get(path).set(admin).buffer(true).parse((r, cb) => {
  let s = '';
  r.setEncoding('utf8');
  r.on('data', (d: string) => (s += d));
  r.on('end', () => cb(null, s));
});

describe('finance reports', () => {
  it('counts money on the day it was paid (Juba time), even after a later refund request', async () => {
    const clock = new FixedClock(new Date('2026-10-30T08:00:00Z')); // 10:00 in Juba
    const { c } = testContainer({ clock }, ENV);
    const app = createApp(c);
    const a = await held(c, 'NBO');
    await c.payments.initiate(a, 'bank_transfer', CONTACT.phone);
    await paid(c, a); // paid 30 Oct
    const b = await held(c, 'EBB');
    await c.payments.initiate(b, 'bank_transfer', CONTACT.phone); // never paid

    clock.advanceMinutes(15 * 60 + 40); // 30 Oct 23:40 UTC = 31 Oct 01:40 in Juba
    const cc = await held(c, 'ADD');
    await c.payments.initiate(cc, 'cash_office', CONTACT.phone);
    await paid(c, cc); // paid 31 Oct (Juba)
    await c.payments.requestRefund(a.id, a.offer.totalPrice); // refund owed, 31 Oct

    const daily = parse((await get(app, '/api/admin/reports/daily?from=2026-10-30&to=2026-10-31').expect(200)).body as string);
    const header = daily[0] ?? [];
    const col = (name: string) => header.indexOf(name);
    const row = (d: string) => daily.find((r) => r[0] === d) ?? [];
    const usd = (minor: number) => String(minor / 100);
    expect(row('2026-10-30')[col('Received bank_transfer (USD)')]).toBe(usd(a.offer.totalPrice.amountCents));
    expect(row('2026-10-30')[col('Requested that day, not yet paid (USD)')]).toBe(usd(b.offer.totalPrice.amountCents));
    expect(row('2026-10-31')[col('Received bank_transfer (USD)')]).toBe('0');
    expect(row('2026-10-31')[col('Received cash_office (USD)')]).toBe(usd(cc.offer.totalPrice.amountCents));
    expect(row('2026-10-31')[col('Refund requested, still owed (USD)')]).toBe(usd(a.offer.totalPrice.amountCents));
    expect(row('2026-10-30')[col('Bookings paid and ticketed')]).toBe('1');

    const ledger = (await get(app, '/api/admin/reports/payments?from=2026-10-30&to=2026-10-30').expect(200));
    expect(ledger.headers['content-disposition']).toBe('attachment; filename="bluckflies-payments-2026-10-30-to-2026-10-30.csv"');
    expect(ledger.headers['cache-control']).toBe('private, no-store');
    const rows = parse(ledger.body as string);
    const pnrCol = (rows[0] ?? []).indexOf('Booking code');
    expect(rows.slice(1).map((r) => r[pnrCol]).sort()).toEqual([a.pnr, b.pnr].sort()); // paid/created on the 30th
    const aRow = rows.find((r) => r[pnrCol] === a.pnr) ?? [];
    expect(aRow[(rows[0] ?? []).indexOf('Paid (Juba)')]).toBe('2026-10-30 10:00');
    expect(aRow[(rows[0] ?? []).indexOf('Payment status')]).toBe('refund_requested');

    const owed = parse((await get(app, '/api/admin/reports/refunds-owed').expect(200)).body as string);
    expect(owed).toHaveLength(2);
    expect(owed[1]?.[2]).toBe(a.pnr);
    expect(owed[1]?.[7]).toBe('Staff (manual)');
  });

  it('only admins can download, with valid date ranges', async () => {
    const { c } = testContainer({}, ENV);
    const app = createApp(c);
    await c.staff.create('t', { email: 'agent@bluckflies.com', name: 'Agent', role: 'agent', password: 'correct horse battery' });
    const token = (await request(app).post('/api/staff/login').send({ email: 'agent@bluckflies.com', password: 'correct horse battery' })).body.token;
    await request(app).get('/api/admin/reports/daily?from=2026-10-01&to=2026-10-31').set('authorization', `Bearer ${token}`).expect(403);
    await request(app).get('/api/admin/reports/daily').set(admin).expect(400);
    await request(app).get('/api/admin/reports/daily?from=2026-10-31&to=2026-10-01').set(admin).expect(400);
    await request(app).get('/api/admin/reports/daily?from=2025-01-01&to=2026-10-31').set(admin).expect(400);
    await request(app).get('/api/admin/reports/everything?from=2026-10-01&to=2026-10-31').set(admin).expect(400);
  });

  it('writes CSV that spreadsheets cannot run as formulas', () => {
    const csv = toCsv(['a', 'b', 'c'], [['=HYPERLINK("http://x","click")', '+211912345678', 'Deng, "Akol"'], [412.5, undefined, '@SUM(A1)']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csv).toContain(`'+211912345678`);
    expect(csv).toContain('"Deng, ""Akol"""');
    expect(csv).toContain(`412.5,,'@SUM(A1)`);
  });
});
