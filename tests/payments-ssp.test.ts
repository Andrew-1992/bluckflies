import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { convertCharge, formatRate, parseRate, proportionalRefund } from '../src/lib/fx.js';
import { SandboxFlightProvider } from '../src/providers/flights/SandboxFlightProvider.js';
import { referenceIdFor } from '../src/providers/payments/momo/MomoPaymentProvider.js';
import { createMemoryRepositories, MemorySupportTicketRepository } from '../src/repositories/memory.js';
import { adult, CONTACT, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';
import { FakeMomo, MOMO } from './support/fakeMomo.js';
import { testDb } from './support/testDb.js';

const SID = 'ses_owner';
const ADMIN = 'admin-token-'.padEnd(40, 'x');

async function heldBooking(c: Container, cabin: 'economy' | 'business' = 'economy') {
  const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin, maxStops: 0, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
  return c.confirmations.approve(SID, p.confirmationId);
}

/** SSP the payer should be charged at the fixture rate of 4600/USD, rounded up to whole pounds. */
const sspMinorFor = (usdCents: number) => Math.ceil((usdCents * 4600) / 100) * 100;

async function supportTickets(c: Container): Promise<number> {
  const pg = testDb();
  if (pg) return (await pg.db.supportTicket.count()) as number;
  return c.repos.tickets instanceof MemorySupportTicketRepository ? c.repos.tickets.rows.length : -1;
}

describe('exchange-rate arithmetic', () => {
  it('converts USD fares to whole SSP, rounding up, with an optional markup', () => {
    expect(convertCharge({ amountCents: 32000, currency: 'USD' }, { currency: 'SSP', perUsd: '4600', markupBps: 0 })).toEqual({ amountMinor: 147_200_000, currency: 'SSP' });
    // 320 × 4600 × 1.015 = 1,494,080 SSP
    expect(convertCharge({ amountCents: 32000, currency: 'USD' }, { currency: 'SSP', perUsd: '4600', markupBps: 150 }).amountMinor).toBe(149_408_000);
    // 0.01 × 4600.5 = 46.005 → 47 (never undercollect)
    expect(convertCharge({ amountCents: 1, currency: 'USD' }, { currency: 'SSP', perUsd: '4600.5', markupBps: 0 }).amountMinor).toBe(4_700);
  });

  it('refunds a proportional share, rounding down; a full refund returns exactly the charge', () => {
    const charge = { amountMinor: 147_200_000, currency: 'SSP' };
    const paid = { amountCents: 32000, currency: 'USD' as const };
    expect(proportionalRefund(charge, paid, { amountCents: 27000, currency: 'USD' })).toEqual({ amountMinor: 124_200_000, currency: 'SSP' });
    expect(proportionalRefund({ amountMinor: 1001, currency: 'SSP' }, paid, { amountCents: 16000, currency: 'USD' }).amountMinor).toBe(500);
    expect(proportionalRefund(charge, paid, paid)).toEqual(charge);
  });

  it('accepts only plain positive decimals as rates', () => {
    expect(formatRate(parseRate('4612.500'))).toBe('4612.5');
    for (const bad of ['1e3', '-1', '0', '4600.1234567', ' ', 'abc']) expect(() => parseRate(bad), bad).toThrow();
  });
});

describe('exchange-rate management', () => {
  it('refuses SSP charges on a stale rate and keeps card available', async () => {
    const { c } = testContainer({}, { SSP_RATE_AS_OF: '2026-10-28T00:00:00Z' }); // 58 hours old
    const b = await heldBooking(c);
    await expect(c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringMatching(/Card payment in USD is available/),
    });
    await expect(c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678')).resolves.toMatchObject({ provider: 'sandbox_card' });
  });

  it('uses the newest rate, guards against typos, and rejects future or old dates', async () => {
    const { c } = testContainer();
    await c.fx.setRate({ currency: 'SSP', perUsd: '4700', asOf: '2026-10-30T09:00:00Z', source: 'Bank of South Sudan daily rate' });
    expect((await c.fx.current('SSP'))?.perUsd).toBe('4700');
    await expect(c.fx.setRate({ currency: 'SSP', perUsd: '47000', asOf: '2026-10-30T09:30:00Z', source: 'BoSS' })).rejects.toThrow(/differs .* by 900\.0%.*confirmLargeChange/);
    await c.fx.setRate({ currency: 'SSP', perUsd: '7100', asOf: '2026-10-30T09:30:00Z', source: 'BoSS', confirmLargeChange: true });
    expect((await c.fx.current('SSP'))?.perUsd).toBe('7100');
    await expect(c.fx.setRate({ currency: 'SSP', perUsd: '7100', asOf: '2026-10-31T09:30:00Z', source: 'BoSS' })).rejects.toThrow(/future/);
    await expect(c.fx.setRate({ currency: 'SSP', perUsd: '7100', asOf: '2026-10-01T09:30:00Z', source: 'BoSS' })).rejects.toThrow(/7 days/);
    await expect(c.fx.setRate({ currency: 'USD', perUsd: '1', asOf: '2026-10-30T09:30:00Z', source: 'BoSS' })).rejects.toThrow(/other than USD/);
  });

  it('exposes rates through the admin API only with the admin token', async () => {
    const { c } = testContainer({}, { ADMIN_API_TOKEN: ADMIN });
    const app = createApp(c);
    const body = { currency: 'SSP', perUsd: '4650.25', asOf: '2026-10-30T09:00:00Z', source: 'BoSS official rate' };
    await request(app).post('/api/admin/fx-rates').send(body).expect(401);
    await request(app).post('/api/admin/fx-rates').set('authorization', `Bearer ${ADMIN}y`).send(body).expect(401);
    const ok = await request(app).post('/api/admin/fx-rates').set({ authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Finance Officer' }).send(body).expect(201);
    expect(ok.body.rate).toMatchObject({ currency: 'SSP', perUsd: '4650.25' });
    const got = await request(app).get('/api/admin/fx-rates/ssp').set({ authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Finance Officer' }).expect(200);
    expect(got.body.current.perUsd).toBe('4650.25');
    expect(got.body.history).toHaveLength(1);
    await request(app).post('/api/admin/fx-rates').set({ authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Finance Officer' }).send({ ...body, perUsd: '465025' }).expect(400);
  });

  it('shows indicative SSP prices with the rate date', async () => {
    const { c } = testContainer();
    const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 0, sortBy: 'cheapest' });
    expect(r.offers[0]?.priceIndicativeSsp).toMatch(/^≈ SSP [\d,]+ \(rate of 2026-10-30\)$/);
  });
});

describe('SSP charging (sandbox mobile money)', () => {
  it('locks the SSP amount and rate on the payment and shows them to the traveller', async () => {
    const { c } = testContainer();
    const b = await heldBooking(c);
    const view = await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    expect(p?.charge).toEqual({ amountMinor: sspMinorFor(p?.amount.amountCents ?? 0), currency: 'SSP' });
    expect(p?.fx).toMatchObject({ currency: 'SSP', perUsd: '4600', source: 'test fixture', markupBps: 0 });
    expect(view.charge).toMatch(/^SSP [\d,]+$/);
    expect(view.exchangeRate).toBe('4600 SSP/USD (test fixture, 2026-10-30)');
    expect(view.instructions).toContain(view.charge);
  });

  it('blocks ticketing when the payment arrives in the wrong currency', async () => {
    const { c, clock } = testContainer();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    const body = JSON.stringify({ id: 'evt_cur', type: 'payment.succeeded', data: { providerReference: p?.providerReference, amountMinor: p?.charge.amountMinor, currency: 'USD' } });
    await expect(c.payments.handleSandboxWebhook(body, c.payments.sign(body, Math.floor(clock.now().getTime() / 1000)))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending');
  });
});

describe('MTN MoMo', () => {
  let momo: FakeMomo;
  beforeEach(async () => {
    momo = new FakeMomo();
    await momo.start();
  });
  afterEach(() => momo.stop());

  function setup(opts: { disbursement?: boolean } = {}) {
    const env: Record<string, string> = {
      PUBLIC_BASE_URL: 'https://bluckflies.example',
      MOMO_BASE_URL: momo.url,
      MOMO_TARGET_ENVIRONMENT: MOMO.environment,
      MOMO_COLLECTION_SUBSCRIPTION_KEY: MOMO.collection.subscriptionKey,
      MOMO_COLLECTION_API_USER: MOMO.collection.apiUser,
      MOMO_COLLECTION_API_KEY: MOMO.collection.apiKey,
      ...(opts.disbursement
        ? {
            MOMO_DISBURSEMENT_SUBSCRIPTION_KEY: MOMO.disbursement.subscriptionKey,
            MOMO_DISBURSEMENT_API_USER: MOMO.disbursement.apiUser,
            MOMO_DISBURSEMENT_API_KEY: MOMO.disbursement.apiKey,
          }
        : {}),
    };
    const { c, clock } = testContainer({}, env);
    return { c, clock, app: createApp(c) };
  }

  it('sends a request-to-pay in SSP with an idempotent UUID reference, then polls MTN to ticket', async () => {
    const { c, clock } = setup();
    expect(c.momoEnabled).toBe(true);
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const ref = referenceIdFor(`pay:${b.bookingId}:1`);
    const call = momo.calls('POST', '/collection/v1_0/requesttopay')[0];
    expect(call?.headers).toMatchObject({
      'x-reference-id': ref,
      'x-target-environment': MOMO.environment,
      'x-callback-url': 'https://bluckflies.example/api/webhooks/momo',
      'ocp-apim-subscription-key': MOMO.collection.subscriptionKey,
    });
    const p = await c.payments.latestForBooking(b.bookingId);
    expect(call?.body).toMatchObject({
      amount: String((p?.charge.amountMinor ?? 0) / 100),
      currency: 'SSP',
      externalId: ref,
      payer: { partyIdType: 'MSISDN', partyId: '211912345678' },
    });
    expect(p?.providerReference).toBe(ref);

    clock.advanceMinutes(1);
    expect(await c.reconciliation.pollPending(15)).toEqual({ checked: 1, resolved: 0 }); // still pending at MTN
    momo.approve(ref);
    expect(await c.reconciliation.pollPending(15)).toEqual({ checked: 1, resolved: 1 });
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('ticketed');
    expect(momo.tokenIssues.collection).toBe(1); // token cached across calls
  });

  it('never charges twice when the response is lost: the retry reuses the reference', async () => {
    const { c } = setup();
    const b = await heldBooking(c);
    momo.dropRequestToPayResponses = 1;
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const calls = momo.calls('POST', '/collection/v1_0/requesttopay');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers['x-reference-id']).toBe(calls[1]?.headers['x-reference-id']);
    expect(momo.payments.size).toBe(1);
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('requested');
  });

  it('never charges twice when a failed request is tried again later (crash or traveller retry)', async () => {
    const { c } = setup();
    const b = await heldBooking(c);
    momo.dropRequestToPayResponses = 2; // both attempts in the first call lose their response
    await expect(c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(momo.payments.size).toBe(1); // MTN did receive it

    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    expect(momo.payments.size).toBe(1); // same reference: MTN answers 409, no second prompt
    expect((await c.payments.latestForBooking(b.bookingId))?.providerReference).toBe([...momo.payments.keys()][0]);
  });

  it('ignores what an unsigned callback claims and checks MTN instead', async () => {
    const { c, app } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const ref = referenceIdFor(`pay:${b.bookingId}:1`);
    // A forged "SUCCESSFUL" callback while MTN still says PENDING changes nothing.
    const forged = await request(app).put('/api/webhooks/momo').set('content-type', 'application/json').send({ externalId: ref, status: 'SUCCESSFUL', amount: '1' }).expect(200);
    expect(forged.body.status).toBe('open');
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending');

    momo.approve(ref);
    const real = await request(app).put('/api/webhooks/momo').set('content-type', 'application/json').send({ externalId: ref, status: 'SUCCESSFUL' }).expect(200);
    expect(real.body.status).toBe('paid');
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('ticketed');
    await request(app).post('/api/webhooks/momo').set('content-type', 'application/json').send('not json').expect(200);
  });

  it('returns the booking to held when the payer declines, and reports unknown numbers clearly', async () => {
    const { c, clock } = setup();
    const b = await heldBooking(c);
    await expect(c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211900000000')).rejects.toThrow(/not registered for MTN MoMo/);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    momo.decline(referenceIdFor(`pay:${b.bookingId}:1`));
    clock.advanceMinutes(1);
    await c.reconciliation.pollPending(15);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('held');
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('failed');
  });

  it('refreshes a revoked access token once and carries on', async () => {
    const { c, clock } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    momo.revokeTokens();
    clock.advanceMinutes(1);
    expect(await c.reconciliation.pollPending(15)).toEqual({ checked: 1, resolved: 0 });
    expect(momo.tokenIssues.collection).toBe(2);
  });

  it('refunds the SSP share to the payer through Disbursement, completed by reconciliation', async () => {
    const { c, clock } = setup({ disbursement: true });
    const b = await heldBooking(c, 'business'); // refundable, USD 50 penalty
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    momo.approve(referenceIdFor(`pay:${b.bookingId}:1`));
    clock.advanceMinutes(1);
    await c.reconciliation.pollPending(15);
    const paid = await c.payments.latestForBooking(b.bookingId);

    await c.confirmations.approve(SID, (await c.confirmations.proposeCancellation(SID, b.pnr)).confirmationId);
    const transfer = momo.calls('POST', '/disbursement/v1_0/transfer')[0];
    const usdRefund = (paid?.amount.amountCents ?? 0) - 5000;
    const expectedMinor = Math.floor(((paid?.charge.amountMinor ?? 0) * usdRefund) / (paid?.amount.amountCents ?? 1));
    expect(transfer?.body).toMatchObject({ amount: String(expectedMinor / 100), currency: 'SSP', payee: { partyIdType: 'MSISDN', partyId: '211912345678' } });

    momo.completeTransfers();
    clock.advanceMinutes(16);
    expect(await c.reconciliation.run()).toMatchObject({ refundsResolved: 1 });
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('refunded');
  });

  it('hands refunds to a person when Disbursement is not enabled', async () => {
    const { c, clock } = setup();
    const b = await heldBooking(c, 'business');
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    momo.approve(referenceIdFor(`pay:${b.bookingId}:1`));
    clock.advanceMinutes(1);
    await c.reconciliation.pollPending(15);
    const before = await supportTickets(c);

    await c.confirmations.approve(SID, (await c.confirmations.proposeCancellation(SID, b.pnr)).confirmationId);
    const p = await c.payments.latestForBooking(b.bookingId);
    expect(p?.status).toBe('refund_requested');
    expect(p?.refundReference).toMatch(/^manual:/);
    expect(await supportTickets(c)).toBe(before + 1);
    expect(momo.calls('POST', '/disbursement')).toHaveLength(0);

    clock.advanceMinutes(16);
    await c.reconciliation.run(); // manual refunds are not polled
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('refund_requested');
  });
});

describe('payment availability in production', () => {
  const prodEnv = {
    NODE_ENV: 'production',
    ENABLE_SANDBOX_ENDPOINTS: 'false',
    PUBLIC_BASE_URL: 'https://bluckflies.example',
    DATABASE_URL: 'postgresql://app@db/bf',
    DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString('base64')}`,
    FLIGHT_PROVIDER: 'duffel',
    DUFFEL_ACCESS_TOKEN: 'duffel_live_abc',
    SANDBOX_DOMESTIC_FLIGHTS: 'false',
    // Required in production: phone login/channel keys and e-ticket email.
    AUTH_SECRET: 'a'.repeat(40),
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'BluckFlies <tickets@bluckflies.example>',
  };

  it('offers no simulated payment methods and refuses unavailable ones clearly', async () => {
    const { c } = testContainer({ repositories: createMemoryRepositories(), flights: new SandboxFlightProvider() }, prodEnv);
    expect(c.payments.availableMethods()).toEqual([]);
    const b = await heldBooking(c);
    await expect(c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678')).rejects.toThrow(/MTN MoMo is not available right now\. Available: none/);
  });

  it('validates exchange-rate and MTN settings together', () => {
    const base = { PAYMENT_WEBHOOK_SECRET: 'x'.repeat(40) };
    expect(() => loadConfig({ ...base, SSP_PER_USD: '4600' })).toThrow(/SSP_RATE_AS_OF/);
    expect(() => loadConfig({ ...base, MOMO_TARGET_ENVIRONMENT: 'sandbox' })).toThrow(/MOMO_COLLECTION_SUBSCRIPTION_KEY/);
    expect(() =>
      loadConfig({
        ...prodEnv,
        ...base,
        MOMO_TARGET_ENVIRONMENT: 'sandbox',
        MOMO_COLLECTION_SUBSCRIPTION_KEY: MOMO.collection.subscriptionKey,
        MOMO_COLLECTION_API_USER: MOMO.collection.apiUser,
        MOMO_COLLECTION_API_KEY: MOMO.collection.apiKey,
      }),
    ).toThrow(/sandbox environment cannot be used in production/);
  });
});


