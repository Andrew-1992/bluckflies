import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import type { Container } from '../src/container.js';
import type { Passenger } from '../src/domain/types.js';
import { createApp } from '../src/http/app.js';
import { SandboxPaymentProvider } from '../src/providers/payments/SandboxPaymentProvider.js';
import { fromCents, toCents } from '../src/providers/flights/duffel/DuffelFlightProvider.js';
import { adult, CONTACT, FixedClock, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';
import { FAKE_TOKEN, FakeDuffel } from './support/fakeDuffel.js';

const SID = 'ses_owner';
const WEBHOOK_SECRET = 'duffel-webhook-secret-123456';

const KQ_HOLD = {
  owner: { iata_code: 'KQ', name: 'Kenya Airways' },
  totalCents: 32000,
  requiresInstantPayment: false,
  departLocal: '14:30',
  arriveLocal: '17:25',
  flightNumber: '351',
  refund: { allowed: true, penaltyCents: 5000 },
};
const ET_PAY_NOW = {
  owner: { iata_code: 'ET', name: 'Ethiopian Airlines' },
  totalCents: 28000,
  requiresInstantPayment: true,
  departLocal: '11:00',
  arriveLocal: '13:55',
  flightNumber: '353',
  refund: null,
};

let duffel: FakeDuffel;
beforeEach(async () => {
  duffel = new FakeDuffel();
  duffel.templates = [KQ_HOLD, ET_PAY_NOW, { ...KQ_HOLD, flightNumber: '999', currency: 'EUR' }];
  await duffel.start();
});
afterEach(() => duffel.stop());

function setup() {
  const mobile = new SandboxPaymentProvider();
  const { c, clock } = testContainer(
    { paymentProvider: mobile },
    { FLIGHT_PROVIDER: 'duffel', DUFFEL_ACCESS_TOKEN: FAKE_TOKEN, DUFFEL_API_URL: duffel.url, DUFFEL_WEBHOOK_SECRET: WEBHOOK_SECRET },
  );
  return { c, clock, mobile };
}

async function offerFor(c: Container, airline: 'KQ' | 'ET', passengers = ONE_ADULT) {
  const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const o = r.offers.find((x) => x.segments[0]?.flight.startsWith(airline));
  if (!o) throw new Error(`no ${airline} offer`);
  return o;
}

async function reserve(c: Container, airline: 'KQ' | 'ET', passengers: Passenger[] = [adult()], mix = ONE_ADULT) {
  const o = await offerFor(c, airline, mix);
  const p = await c.confirmations.proposeReservation(SID, o.offerId, passengers, CONTACT);
  return c.confirmations.approve(SID, p.confirmationId);
}

/** Pays with sandbox mobile money and delivers a correctly signed success webhook. */
async function pay(c: Container, clock: FixedClock, pnr: string) {
  const booking = await c.bookings.getOwned(SID, pnr);
  await c.payments.initiate(booking, 'mtn_momo', '+211912345678');
  const p = await c.payments.latestForBooking(booking.id);
  const body = JSON.stringify({ id: `evt_${pnr}`, type: 'payment.succeeded', data: { providerReference: p?.providerReference, amountMinor: p?.charge.amountMinor, currency: p?.charge.currency } });
  await c.payments.handleSandboxWebhook(body, c.payments.sign(body, Math.floor(clock.now().getTime() / 1000)));
  return c.bookings.view(SID, pnr);
}

describe('money conversion', () => {
  it('parses supplier decimal strings exactly and rejects anything else', () => {
    expect(toCents('320.00')).toBe(32000);
    expect(toCents('45.5')).toBe(4550);
    expect(toCents('7')).toBe(700);
    expect(() => toCents('1e3')).toThrow();
    expect(() => toCents('-5.00')).toThrow();
    expect(fromCents(32005)).toBe('320.05');
  });
});

describe('Duffel search', () => {
  it('sends a v2 offer request with the passenger mix and maps offers', async () => {
    const { c } = setup();
    const r = await c.search.search(SID, {
      origin: 'Juba',
      destination: 'Nairobi',
      departureDate: FRIDAY,
      passengers: { adults: 2, childAges: [7], infants: 1 },
      cabin: 'economy',
      maxStops: 0,
      sortBy: 'cheapest',
    });
    const req = duffel.calls('POST', '/air/offer_requests')[0];
    expect(req?.path).toContain('supplier_timeout=');
    expect(req?.body).toMatchObject({
      data: {
        slices: [{ origin: 'JUB', destination: 'NBO', departure_date: FRIDAY }],
        passengers: [{ type: 'adult' }, { type: 'adult' }, { age: 7 }, { age: 1 }],
        cabin_class: 'economy',
        max_connections: 0,
      },
    });

    expect(r.notice).toBeUndefined(); // real inventory, no sandbox label
    expect(r.offers).toHaveLength(2); // the EUR-priced offer is skipped
    const kq = r.offers.find((o) => o.airline === 'Kenya Airways');
    expect(kq).toMatchObject({
      price: 'USD 320.00',
      booking: 'hold',
      refundable: true,
      sandbox: false,
      stops: 0,
      totalDurationMinutes: 115, // 14:30 Juba (UTC+2) → 17:25 Nairobi (UTC+3)
      baggage: '1 cabin bag, 2 checked per traveller',
    });
    expect(kq?.segments[0]).toMatchObject({ flight: 'KQ351', departs: `${FRIDAY}T14:30:00+02:00`, arrives: `${FRIDAY}T17:25:00+03:00` });
    expect(r.offers.find((o) => o.airline === 'Ethiopian Airlines')).toMatchObject({ booking: 'pay_now', refundable: false });
  });

  it('serves domestic routes from the labelled sandbox in development', async () => {
    const { c } = setup();
    const r = await c.search.search(SID, { origin: 'JUB', destination: 'WUU', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 0, sortBy: 'best' });
    expect(r.notice).toMatch(/SANDBOX/);
    expect(duffel.calls('POST', '/air/offer_requests')).toHaveLength(0);
  });

  it('turns supplier outages into a friendly retryable error', async () => {
    const { c } = setup();
    await duffel.stop();
    await expect(c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 0, sortBy: 'best' })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    await duffel.start(); // for afterEach
  });
});

describe('Duffel booking: airline hold', () => {
  it('creates a hold order, respects the payment deadline, pays the current price and issues tickets', async () => {
    const { c, clock } = setup();
    const b = await reserve(c, 'KQ');
    const holdReq = duffel.calls('POST', '/air/orders')[0]?.body as { data: { type: string; passengers: Array<Record<string, unknown>>; metadata: Record<string, string> } };
    expect(holdReq.data.type).toBe('hold');
    expect(holdReq.data.metadata['bluckflies_booking_id']).toBe(b.bookingId);
    expect(holdReq.data.passengers[0]).toMatchObject({
      given_name: 'Akol',
      family_name: 'Deng',
      gender: 'm',
      title: 'mr',
      born_on: '1990-05-12',
      email: CONTACT.email,
      phone_number: CONTACT.phone,
      identity_documents: [{ type: 'passport', unique_identifier: 'R00123456', issuing_country_code: 'SS', expires_on: '2030-01-01' }],
    });
    // The airline wants payment within 40 minutes: the hold must not promise 60.
    expect(Date.parse(b.holdExpiresAt ?? '')).toBe(Date.parse(duffel.paymentRequiredBy));

    const after = await pay(c, clock, b.pnr);
    expect(after.status).toBe('ticketed');
    expect(after.ticketNumbers[0]).toMatch(/^0719/);
    expect(duffel.calls('POST', '/air/payments')[0]?.body).toMatchObject({ data: { payment: { type: 'balance', amount: '320.00', currency: 'USD' } } });
    expect((await c.bookings.getOwned(SID, b.pnr)).supplierReference).toMatch(/^ord_/);
  });

  it('never pays the airline more than the traveller paid: refunds instead', async () => {
    const { c, clock } = setup();
    const b = await reserve(c, 'KQ');
    duffel.orderPriceIncreaseCents = 2500;
    const after = await pay(c, clock, b.pnr);
    expect(after.status).toBe('refund_pending');
    expect(duffel.calls('POST', '/air/payments')).toHaveLength(0);
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('refund_requested');
  });

  it('rejects confirmation when the fare changed since the search', async () => {
    const { c } = setup();
    const o = await offerFor(c, 'KQ');
    for (const offer of duffel.offers.values()) offer.template = { ...offer.template, totalCents: 33000 };
    const p = await c.confirmations.proposeReservation(SID, o.offerId, [adult()], CONTACT);
    await expect(c.confirmations.approve(SID, p.confirmationId)).rejects.toThrow(/fare changed from USD 320.00 to USD 330.00/);
    expect(duffel.calls('POST', '/air/orders')).toHaveLength(0);
  });
});

describe('Duffel booking: pay-now fares', () => {
  it('creates no airline order until the traveller pays, then books with balance payment', async () => {
    const { c, clock } = setup();
    const b = await reserve(c, 'ET');
    expect(duffel.calls('POST', '/air/orders')).toHaveLength(0);
    const after = await pay(c, clock, b.pnr);
    expect(after.status).toBe('ticketed');
    const order = duffel.calls('POST', '/air/orders')[0]?.body as { data: Record<string, unknown> };
    expect(order.data).toMatchObject({ type: 'instant', payments: [{ type: 'balance', amount: '280.00', currency: 'USD' }], metadata: { bluckflies_booking_id: b.bookingId } });
  });

  it('refunds in full when the fare sold out before payment arrived', async () => {
    const { c, clock } = setup();
    const b = await reserve(c, 'ET');
    for (const offer of duffel.offers.values()) offer.available = false;
    const after = await pay(c, clock, b.pnr);
    expect(after.status).toBe('refund_pending');
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('refund_requested');
  });

  it('recovers a booking whose response was lost, without creating a second order', async () => {
    const { c, clock } = setup();
    const b = await reserve(c, 'ET');
    duffel.failNextOrderAfterCreating = true; // order is created, response lost (504)
    expect((await pay(c, clock, b.pnr)).status).toBe('ticketing');

    clock.advanceMinutes(6);
    expect(await c.reconciliation.run()).toMatchObject({ ticketingRetried: 1, ticketingCompleted: 1 });
    const view = await c.bookings.view(SID, b.pnr);
    expect(view.status).toBe('ticketed');
    expect(view.ticketNumbers).toHaveLength(1);
    expect(duffel.orders.size).toBe(1);
    expect(duffel.calls('POST', '/air/orders')).toHaveLength(1); // recovered by lookup, not by re-ordering
  });

  it('maps a family to the priced passengers, attaching the infant to an adult', async () => {
    const { c, clock } = setup();
    const mix = { adults: 2, childAges: [7], infants: 1 };
    const family: Passenger[] = [
      adult(),
      adult({ givenName: 'Abuk', gender: 'f', dateOfBirth: '1992-02-02', passportNumber: 'R00222333' }),
      adult({ type: 'child', givenName: 'Deng', dateOfBirth: '2019-01-15', passportNumber: 'R00444555' }),
      adult({ type: 'infant', givenName: 'Achol', gender: 'f', dateOfBirth: '2026-01-10', passportNumber: 'R00666777' }),
    ];
    const b = await reserve(c, 'ET', family, mix);
    expect((await pay(c, clock, b.pnr)).ticketNumbers).toHaveLength(4);
    const sent = (duffel.calls('POST', '/air/orders')[0]?.body as { data: { passengers: Array<Record<string, unknown>> } }).data.passengers;
    const offer = [...duffel.offers.values()].find((o) => o.template.owner.iata_code === 'ET' && o.passengers.length === 4);
    const infantId = offer?.passengers.find((p) => p.type === 'infant_without_seat')?.id;
    expect(sent.filter((p) => p['infant_passenger_id'] === infantId)).toHaveLength(1);
    expect(sent.find((p) => p['given_name'] === 'Deng')).toMatchObject({ title: 'mr', id: offer?.passengers.find((p) => p.age === 7)?.id });
    expect(sent.find((p) => p['given_name'] === 'Achol')).toMatchObject({ title: 'miss' });
  });
});

describe('Duffel cancellations', () => {
  it('cancels with the airline first and refunds what the airline returns', async () => {
    const { c, clock } = setup();
    const b = await reserve(c, 'KQ');
    await pay(c, clock, b.pnr);
    const p = await c.confirmations.proposeCancellation(SID, b.pnr);
    expect((await c.confirmations.approve(SID, p.confirmationId)).status).toBe('refund_pending');
    expect(duffel.calls('POST', '/air/order_cancellations')).toHaveLength(2); // quote + confirm
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('refund_requested');
  });

  it('hands over to a person when the airline does not allow API cancellation, changing nothing', async () => {
    const { c, clock } = setup();
    duffel.cancellableOwners.clear();
    duffel.templates = [{ ...KQ_HOLD, refund: { allowed: true, penaltyCents: 5000 } }];
    const b = await reserve(c, 'KQ');
    await pay(c, clock, b.pnr);
    const p = await c.confirmations.proposeCancellation(SID, b.pnr);
    await expect(c.confirmations.approve(SID, p.confirmationId)).rejects.toThrow(/through a BluckFlies agent/);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('ticketed');
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('succeeded');
  });
});

describe('Duffel webhooks', () => {
  it('opens one support ticket per airline schedule change and rejects bad signatures', async () => {
    const { c, clock } = setup();
    const app = createApp(c);
    const b = await reserve(c, 'KQ');
    await pay(c, clock, b.pnr);
    const orderId = (await c.bookings.getOwned(SID, b.pnr)).supplierReference;
    const body = JSON.stringify({ id: 'wev_1', type: 'order.airline_initiated_change_detected', idempotency_key: 'idem_1', live_mode: false, data: { object: { order_id: orderId } } });
    const t = Math.floor(clock.now().getTime() / 1000);
    const sig = c.duffelWebhooks?.sign(body, t) ?? '';

    const post = (s: string) => request(app).post('/api/webhooks/duffel').set('content-type', 'application/json').set('x-duffel-signature', s).send(body);
    expect((await post(sig).expect(200)).body.status).toBe('processed');
    expect((await post(sig).expect(200)).body.status).toBe('duplicate');
    await post('t=1,v1=00').expect(401);
    await post(sig.replace(/v1=./, 'v1=0')).expect(401);
  });
});

describe('flight supplier configuration', () => {
  const base = { PAYMENT_WEBHOOK_SECRET: 'x'.repeat(40) };
  const prod = {
    ...base,
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://bluckflies.example',
    DATABASE_URL: 'postgresql://app@db/bf',
    DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString('base64')}`,
    // Required in production: phone login/channel keys and e-ticket email.
    AUTH_SECRET: 'a'.repeat(40),
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'BluckFlies <tickets@bluckflies.example>',
  };

  it('never allows generated flights or test bookings in production', () => {
    expect(() => loadConfig(prod)).toThrow(/sandbox.*not allowed in production/);
    expect(() => loadConfig({ ...prod, FLIGHT_PROVIDER: 'duffel', DUFFEL_ACCESS_TOKEN: 'duffel_live_abc' })).toThrow(/SANDBOX_DOMESTIC_FLIGHTS must be false/);
    expect(() => loadConfig({ ...prod, FLIGHT_PROVIDER: 'duffel', DUFFEL_ACCESS_TOKEN: 'duffel_test_abc', SANDBOX_DOMESTIC_FLIGHTS: 'false' })).toThrow(/test token/);
    expect(loadConfig({ ...prod, FLIGHT_PROVIDER: 'duffel', DUFFEL_ACCESS_TOKEN: 'duffel_live_abc', SANDBOX_DOMESTIC_FLIGHTS: 'false' }).FLIGHT_PROVIDER).toBe('duffel');
  });

  it('requires a token and forbids live tokens outside production', () => {
    expect(() => loadConfig({ ...base, FLIGHT_PROVIDER: 'duffel' })).toThrow(/DUFFEL_ACCESS_TOKEN is required/);
    expect(() => loadConfig({ ...base, FLIGHT_PROVIDER: 'duffel', DUFFEL_ACCESS_TOKEN: 'duffel_live_abc' })).toThrow(/live Duffel tokens/);
  });
});


