import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { FakeStripe, STRIPE_ENV, STRIPE_WHSEC, stripeSdk } from './support/fakeStripe.js';
import { StripeWebhookHandler } from '../src/providers/payments/StripeWebhookHandler.js';
import { silentLogger } from '../src/lib/logger.js';
import { adult, CONTACT, FRIDAY, testContainer, ONE_ADULT } from './helpers.js';
import type { CabinClass } from '../src/domain/types.js';

const WHSEC = STRIPE_WHSEC;
const SID = 'ses_card';
const sdk = stripeSdk;

function setup() {
  const fake = new FakeStripe();
  const { c, clock } = testContainer({ stripe: { client: fake, webhooks: sdk.webhooks } }, STRIPE_ENV);
  return { c, clock, fake, app: createApp(c) };
}

async function heldBooking(c: ReturnType<typeof setup>['c'], cabin: CabinClass = 'economy') {
  const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin, maxStops: 0, sortBy: 'best' });
  const offerId = r.offers[0]?.offerId ?? '';
  const p = await c.confirmations.proposeReservation(SID, offerId, [adult()], CONTACT);
  return c.confirmations.approve(SID, p.confirmationId);
}

function stripeEvent(type: string, object: Record<string, unknown>, opts: { id?: string; livemode?: boolean } = {}) {
  const payload = JSON.stringify({ id: opts.id ?? `evt_${type}_${Math.random()}`, object: 'event', type, livemode: opts.livemode ?? false, data: { object } });
  return { payload, header: sdk.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
}

const postWebhook = (app: ReturnType<typeof createApp>, e: { payload: string; header: string }) =>
  request(app).post('/api/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', e.header).send(e.payload);

describe('Stripe card payments', () => {
  it('routes card to Stripe Checkout with amount, idempotency key, PNR and a valid expiry', async () => {
    const { c, fake, clock } = setup();
    expect(c.cardProvider).toBe('stripe');
    const b = await heldBooking(c);
    const view = await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');

    expect(view.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const call = fake.created[0];
    const item = call?.params.line_items?.[0];
    expect(item?.price_data?.currency).toBe('usd');
    expect(item?.price_data?.unit_amount).toBe((await c.payments.latestForBooking(b.bookingId))?.amount.amountCents);
    expect(call?.params.client_reference_id).toBe(b.pnr);
    expect(call?.options?.idempotencyKey).toBe(`pay:${b.bookingId}:1`);
    expect(call?.params.success_url).toContain(`payment=success&ref=${b.pnr}`);
    const ahead = (call?.params.expires_at ?? 0) - clock.now().getTime() / 1000;
    expect(ahead).toBeGreaterThanOrEqual(30 * 60);
    expect(ahead).toBeLessThanOrEqual(24 * 3600);
  });

  it('keeps mobile money on the local provider', async () => {
    const { c, fake } = setup();
    const b = await heldBooking(c);
    const view = await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    expect(view.checkoutUrl).toBeUndefined();
    expect(fake.created).toHaveLength(0);
  });

  it('tickets on a verified checkout.session.completed and ignores duplicates', async () => {
    const { c, app } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    const evt = stripeEvent('checkout.session.completed', { id: p?.providerReference, payment_status: 'paid', amount_total: p?.amount.amountCents, currency: 'usd' }, { id: 'evt_paid_1' });

    expect((await postWebhook(app, evt).expect(200)).body.status).toBe('processed');
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('ticketed');
    expect((await postWebhook(app, evt).expect(200)).body.status).toBe('duplicate');
  });

  it('rejects invalid Stripe signatures', async () => {
    const { app } = setup();
    const evt = stripeEvent('checkout.session.completed', { id: 'cs_x' });
    await postWebhook(app, { payload: evt.payload, header: 't=1,v1=forged' }).expect(401);
    await request(app).post('/api/webhooks/stripe').set('content-type', 'application/json').send(evt.payload).expect(401);
    const tampered = { payload: evt.payload.replace('cs_x', 'cs_y'), header: evt.header };
    await postWebhook(app, tampered).expect(401);
  });

  it('waits on unpaid (delayed) completions and blocks currency mismatches', async () => {
    const { c, app } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);

    await postWebhook(app, stripeEvent('checkout.session.completed', { id: p?.providerReference, payment_status: 'unpaid', amount_total: p?.amount.amountCents, currency: 'usd' })).expect(200);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending');

    await postWebhook(app, stripeEvent('checkout.session.async_payment_succeeded', { id: p?.providerReference, payment_status: 'paid', amount_total: p?.amount.amountCents, currency: 'eur' })).expect(409);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending');
  });

  it('returns the booking to held when the Checkout Session expires', async () => {
    const { c, app } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    await postWebhook(app, stripeEvent('checkout.session.expired', { id: p?.providerReference })).expect(200);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('held');
  });

  it('expires the Checkout Session when an unpaid booking is cancelled or switches to mobile money', async () => {
    const { c, fake } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    expect(fake.expired).toEqual(['cs_test_1']);
    expect((await c.payments.latestForBooking(b.bookingId))?.method).toBe('mtn_momo');

    const b2 = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b2.pnr), 'card', '+211912345678');
    await c.confirmations.approve(SID, (await c.confirmations.proposeCancellation(SID, b2.pnr)).confirmationId);
    expect(fake.expired).toContain('cs_test_2');
  });

  it('refunds through Stripe with the PaymentIntent and penalty, completed by refund.updated', async () => {
    const { c, app, fake } = setup();
    const b = await heldBooking(c, 'business'); // sandbox business fares are refundable
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    const cents = p?.amount.amountCents ?? 0;
    await postWebhook(app, stripeEvent('checkout.session.completed', { id: p?.providerReference, payment_status: 'paid', amount_total: cents, currency: 'usd' })).expect(200);

    await c.confirmations.approve(SID, (await c.confirmations.proposeCancellation(SID, b.pnr)).confirmationId);
    const refund = fake.refundCalls[0];
    expect(refund?.params).toMatchObject({ payment_intent: `pi_for_${p?.providerReference}`, amount: cents - 5000, metadata: { provider_reference: p?.providerReference } });
    expect(refund?.options?.idempotencyKey).toBe(`refund:${p?.id}`);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('refund_pending');

    await postWebhook(app, stripeEvent('refund.updated', { id: 're_1', status: 'pending', metadata: { provider_reference: p?.providerReference } })).expect(200);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('refund_pending');
    await postWebhook(app, stripeEvent('refund.updated', { id: 're_1', status: 'succeeded', metadata: { provider_reference: p?.providerReference } })).expect(200);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('refunded');
  });

  it('auto-refunds a card payment that lands after the hold expired', async () => {
    const { c, app, clock, fake } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    clock.advanceMinutes(61);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('expired');
    expect(fake.expired).toEqual([p?.providerReference]);

    await postWebhook(app, stripeEvent('checkout.session.completed', { id: p?.providerReference, payment_status: 'paid', amount_total: p?.amount.amountCents, currency: 'usd' })).expect(200);
    expect(fake.refundCalls[0]?.params.amount).toBe(p?.amount.amountCents);
    expect((await c.bookings.view(SID, b.pnr)).ticketNumbers).toHaveLength(0);
  });

  it('does not let the sandbox approval endpoint settle real Stripe payments', async () => {
    const { c, app } = setup();
    const token = (await request(app).post('/api/sessions').expect(201)).body.token as string;
    const auth = { authorization: `Bearer ${token}` };
    // Booking must belong to this HTTP session; create via the session id behind the token.
    const sessionId = (await c.sessions.findByTokenHash((await import('../src/lib/ids.js')).hashToken(token)))?.id ?? '';
    const r = await c.search.search(sessionId, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 0, sortBy: 'best' });
    const b = await c.confirmations.approve(sessionId, (await c.confirmations.proposeReservation(sessionId, r.offers[0]?.offerId ?? '', [adult()], CONTACT)).confirmationId);
    await c.payments.initiate(await c.bookings.getOwned(sessionId, b.pnr), 'card', '+211912345678');
    const res = await request(app).post(`/api/sandbox/bookings/${b.pnr}/payment`).set(auth).send({ outcome: 'succeeded' }).expect(409);
    expect(res.body.error.message).toMatch(/real provider/);
  });

  it('ignores test-mode events when running with live keys', async () => {
    const { c } = setup();
    const handler = new StripeWebhookHandler(sdk.webhooks, WHSEC, c.payments, silentLogger, false);
    const evt = stripeEvent('checkout.session.completed', { id: 'cs_any', payment_status: 'paid', amount_total: 1, currency: 'usd' });
    expect(await handler.handle(Buffer.from(evt.payload), evt.header)).toEqual({ status: 'ignored' });
  });
});

describe('Stripe configuration', () => {
  it('requires both keys together and forbids live keys outside production', async () => {
    const { loadConfig } = await import('../src/config/env.js');
    const base = { PAYMENT_WEBHOOK_SECRET: 'x'.repeat(40) };
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc' })).toThrow(/both/);
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).toThrow(/live Stripe keys/);
    expect(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'pk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).toThrow(/secret/);
    const db = { DATABASE_URL: 'postgresql://app@db/bluckflies', DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString('base64')}` };
    expect(() => loadConfig({ ...base, ...db, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://bluckflies.example' })).toThrow(/https/);
  });

  it('falls back to sandbox cards and exposes no Stripe webhook route without keys', async () => {
    const { c } = testContainer();
    expect(c.cardProvider).toBe('sandbox_card');
    // Without the route, the request falls through to session-authenticated /api handling.
    await request(createApp(c)).post('/api/webhooks/stripe').send('{}').expect(401);
  });
});

describe('configuration from .env files', () => {
  it('treats blank values as unset, so the copied .env.example starts', async () => {
    const { loadConfig } = await import('../src/config/env.js');
    const c = loadConfig({ PAYMENT_WEBHOOK_SECRET: 'x'.repeat(40), ANTHROPIC_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: ' ', DATABASE_URL: '' });
    expect(c.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.STRIPE_SECRET_KEY).toBeUndefined();
    expect(c.DATABASE_URL).toBeUndefined();
  });
});
