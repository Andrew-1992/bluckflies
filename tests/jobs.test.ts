import { describe, expect, it } from 'vitest';
import { buildJobs } from '../src/jobs/definitions.js';
import { JobScheduler, type JobDefinition } from '../src/lib/jobs.js';
import { silentLogger } from '../src/lib/logger.js';
import { SandboxFlightProvider } from '../src/providers/flights/SandboxFlightProvider.js';
import { SandboxPaymentProvider } from '../src/providers/payments/SandboxPaymentProvider.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { adult, CONTACT, FRIDAY, testContainer, ONE_ADULT } from './helpers.js';
import { FakeStripe, STRIPE_ENV, stripeSdk } from './support/fakeStripe.js';

const SID = 'ses_owner';

function setup(opts: { flights?: SandboxFlightProvider } = {}) {
  const fake = new FakeStripe();
  const mobile = new SandboxPaymentProvider();
  const flights = opts.flights ?? new SandboxFlightProvider();
  const { c, clock } = testContainer({ stripe: { client: fake, webhooks: stripeSdk.webhooks }, paymentProvider: mobile, flights }, STRIPE_ENV);
  const job = (name: string) => {
    const j = buildJobs({ repos: c.repos, bookings: c.bookings, reconciliation: c.reconciliation, clock, retentionDays: 30 }).find((x) => x.name === name);
    if (!j) throw new Error(`no job ${name}`);
    return j;
  };
  return { c, clock, fake, mobile, flights, job };
}

async function heldBooking(c: ReturnType<typeof setup>['c'], cabin: 'economy' | 'business' = 'economy') {
  const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin, maxStops: 0, sortBy: 'best' });
  const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
  return c.confirmations.approve(SID, p.confirmationId);
}

describe('JobScheduler', () => {
  it('runs a job on only one of several instances, and hands over after stop()', async () => {
    const leases = createMemoryRepositories().leases;
    let runs = 0;
    let release!: () => void;
    const job: JobDefinition = { name: 'demo', intervalMs: 60_000, run: () => new Promise<void>((r) => ((runs += 1), (release = r))) };
    const clock = { now: () => new Date() };
    const a = new JobScheduler([job], leases, clock, silentLogger);
    const b = new JobScheduler([job], leases, clock, silentLogger);

    const first = a.tick(job);
    await new Promise((r) => setImmediate(r));
    expect(await b.tick(job)).toBe(false); // lease held by a
    expect(await a.tick(job)).toBe(false); // a never overlaps itself
    release();
    expect(await first).toBe(true);

    await a.stop();
    const second = b.tick(job);
    await new Promise((r) => setImmediate(r));
    release();
    expect(await second).toBe(true);
    expect(runs).toBe(2);
  });

  it('contains job failures instead of crashing the process', async () => {
    const s = new JobScheduler([], createMemoryRepositories().leases, { now: () => new Date() }, silentLogger);
    const boom: JobDefinition = { name: 'boom', intervalMs: 1000, run: () => Promise.reject(new Error('down')) };
    await expect(s.tick(boom)).resolves.toBe(true);
  });
});

describe('holds.sweep', () => {
  it('expires unpaid holds nobody looked at and voids their payment link', async () => {
    const { c, clock, fake, job } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');

    clock.advanceMinutes(30);
    expect(await job('holds.sweep').run()).toEqual({ expired: 0 });

    clock.advanceMinutes(31);
    expect(await job('holds.sweep').run()).toEqual({ expired: 1 });
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('expired');
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('cancelled');
    expect(fake.expired).toEqual(['cs_test_1']);
  });
});

describe('payments.reconcile', () => {
  it('tickets a card payment whose webhook never arrived, once it is stale', async () => {
    const { c, clock, fake, job } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    fake.markPaid('cs_test_1');

    clock.advanceMinutes(5);
    await job('payments.reconcile').run();
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending'); // too early: give the webhook a chance

    clock.advanceMinutes(15);
    expect(await job('payments.reconcile').run()).toMatchObject({ paymentsChecked: 1, paymentsResolved: 1 });
    const view = await c.bookings.view(SID, b.pnr);
    expect(view.status).toBe('ticketed');
    expect(view.ticketNumbers).toHaveLength(1);
  });

  it('returns the booking to held when Stripe says the session expired', async () => {
    const { c, clock, fake, job } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    const s = fake.sessions.get('cs_test_1');
    if (s) s.status = 'expired';
    clock.advanceMinutes(16);
    await job('payments.reconcile').run();
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('held');
    expect((await c.payments.latestForBooking(b.bookingId))?.status).toBe('failed');
  });

  it('completes a refund Stripe finished without telling us', async () => {
    const { c, clock, fake, job } = setup();
    const b = await heldBooking(c, 'business'); // refundable fare
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    fake.markPaid('cs_test_1');
    clock.advanceMinutes(16);
    await job('payments.reconcile').run();
    await c.confirmations.approve(SID, (await c.confirmations.proposeCancellation(SID, b.pnr)).confirmationId);
    expect((await c.payments.latestForBooking(b.bookingId))?.refundReference).toBe('re_1');

    fake.refundStatus = 'succeeded';
    clock.advanceMinutes(16);
    expect(await job('payments.reconcile').run()).toMatchObject({ refundsResolved: 1 });
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('refunded');
  });

  it('retries ticketing after a supplier outage without issuing twice', async () => {
    const flights = new SandboxFlightProvider();
    const { c, clock, fake, job } = setup({ flights });
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    fake.markPaid('cs_test_1');

    flights.failNextIssuances = 1;
    clock.advanceMinutes(16);
    await job('payments.reconcile').run();
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('ticketing'); // paid, supplier down

    clock.advanceMinutes(6);
    expect(await job('payments.reconcile').run()).toMatchObject({ ticketingRetried: 1, ticketingCompleted: 1 });
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('ticketed');

    // A further run finds nothing to do; the supplier would reject a second issuance.
    clock.advanceMinutes(6);
    expect(await job('payments.reconcile').run()).toMatchObject({ ticketingRetried: 0 });
  });

  it('skips providers that cannot be queried (sandbox mobile money)', async () => {
    const { c, clock, job } = setup();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    clock.advanceMinutes(16);
    await job('payments.reconcile').run();
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending');
  });
});

describe('data.cleanup', () => {
  it('purges expired offers and stale confirmations', async () => {
    const { c, clock, job } = setup();
    const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 0, sortBy: 'best' });
    const offerId = r.offers[0]?.offerId ?? '';
    await c.confirmations.proposeReservation(SID, offerId, [adult()], CONTACT);

    clock.advanceMinutes(120);
    const result = await job('data.cleanup').run();
    expect(result).toMatchObject({ confirmationsExpired: 1 });
    expect((result as { offersDeleted: number }).offersDeleted).toBeGreaterThan(0);
    await expect(c.search.getOffer(SID, offerId)).rejects.toThrow(/not found/);
    expect(await c.confirmations.listPending(SID)).toEqual([]);
  });
});
