import { describe, expect, it } from 'vitest';
import type { Booking, Payment, PendingConfirmation } from '../src/domain/types.js';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { DuplicateKeyError, type Repositories } from '../src/repositories/types.js';
import { FlightSearchService } from '../src/services/FlightSearchService.js';
import { SandboxFlightProvider } from '../src/providers/flights/SandboxFlightProvider.js';
import { MemoryOfferRepository } from '../src/repositories/memory.js';
import { adult, FixedClock, FRIDAY, NOW, testContainer, ONE_ADULT } from './helpers.js';
import { storageMode, testDb } from './support/testDb.js';

/**
 * Contract tests: every Repositories implementation must behave identically.
 * Runs on memory always, and on PostgreSQL under `npm run test:pg`.
 */

async function sampleOffer(destination = 'NBO') {
  const svc = new FlightSearchService(new SandboxFlightProvider(), new MemoryOfferRepository(), new FixedClock(NOW), { offerTtlMinutes: 30 }, { displayRate: async () => ({ perUsd: '4600', asOf: '2026-10-30T08:00:00.000Z' }) });
  const r = await svc.search('x', { origin: 'JUB', destination, departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 0, sortBy: 'best' });
  return svc.getOffer('x', r.offers[0]?.offerId ?? '');
}

const iso = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();

async function booking(over: Partial<Booking> = {}): Promise<Booking> {
  return {
    id: `bkg_${Math.random().toString(16).slice(2)}`,
    pnr: 'ABC234',
    ownerSessionId: 'ses_owner',
    offer: await sampleOffer(),
    passengers: [adult()],
    contact: { phone: '+211912345678', email: 'akol@example.com' },
    status: 'held',
    holdExpiresAt: iso(60),
    ticketNumbers: [],
    supplierReference: 'sbx_1',
    createdAt: iso(0),
    updatedAt: iso(0),
    ...over,
  };
}

function payment(bookingId: string, over: Partial<Payment> = {}): Payment {
  return {
    id: `pay_${Math.random().toString(16).slice(2)}`,
    bookingId,
    method: 'card',
    provider: 'stripe',
    amount: { amountCents: 32000, currency: 'USD' },
    charge: { amountMinor: 32000, currency: 'USD' },
    status: 'requested',
    providerReference: `cs_${Math.random().toString(16).slice(2)}`,
    approvalInstructions: 'Pay on Stripe',
    idempotencyKey: `pay:${bookingId}:1`,
    createdAt: iso(0),
    updatedAt: iso(0),
    ...over,
  };
}

const stores: Array<[string, () => Promise<Repositories>]> = [['memory', async () => createMemoryRepositories()]];
if (storageMode() === 'postgres') {
  stores.push([
    'postgres',
    async () => {
      const t = testDb();
      if (!t) throw new Error('Postgres test database not initialised');
      return t.repos;
    },
  ]);
}

/** Creates the sessions a test needs; Postgres fixtures may already have them. */
async function withSessions(repos: Repositories, ...ids: string[]) {
  for (const id of ids) {
    await repos.sessions.create({ id, tokenHash: id.padEnd(64, 'f').slice(0, 64), createdAt: iso(0), lastSeenAt: iso(0) }).catch((e: unknown) => {
      if (!(e instanceof DuplicateKeyError)) throw e;
    });
  }
}

describe('test harness', () => {
  it(`runs the app container on ${storageMode()}`, () => {
    expect(testContainer().c.storage).toBe(storageMode());
  });
});

describe.each(stores)('%s repositories', (_name, make) => {
  it('sessions: unique token hash, lookup, idle retention respects owned records', async () => {
    const r = await make();
    await r.sessions.create({ id: 'ses_x', tokenHash: 'a'.repeat(64), createdAt: iso(-60 * 24 * 40), lastSeenAt: iso(-60 * 24 * 40) });
    await expect(r.sessions.create({ id: 'ses_y', tokenHash: 'a'.repeat(64), createdAt: iso(0), lastSeenAt: iso(0) })).rejects.toBeInstanceOf(DuplicateKeyError);
    expect((await r.sessions.findByTokenHash('a'.repeat(64)))?.id).toBe('ses_x');

    await r.sessions.create({ id: 'ses_keep', tokenHash: 'b'.repeat(64), createdAt: iso(-60 * 24 * 40), lastSeenAt: iso(-60 * 24 * 40) });
    await r.bookings.insert(await booking({ ownerSessionId: 'ses_keep' }));
    await r.sessions.deleteIdleSince(new Date(iso(-60 * 24 * 30)));
    expect(await r.sessions.findByTokenHash('a'.repeat(64))).toBeUndefined();
    expect((await r.sessions.findByTokenHash('b'.repeat(64)))?.id).toBe('ses_keep');
  });

  it('offers: scoped to the searching session and purged after expiry', async () => {
    const r = await make();
    await withSessions(r, 'ses_a', 'ses_b');
    const offer = await sampleOffer();
    await r.offers.saveMany('ses_a', [offer]);
    expect((await r.offers.find('ses_a', offer.id))?.totalPrice).toEqual(offer.totalPrice);
    expect(await r.offers.find('ses_b', offer.id)).toBeUndefined();
    expect(await r.offers.deleteExpiredBefore(new Date(Date.parse(offer.expiresAt) + 1))).toBe(1);
    expect(await r.offers.find('ses_a', offer.id)).toBeUndefined();
  });

  it('offers and bookings: 4-letter airstrip codes round-trip', async () => {
    const r = await make();
    await withSessions(r, 'ses_owner');
    const offer = await sampleOffer('Bor');
    expect(offer.segments[0]?.destination).toBe('HSBR');
    await r.offers.saveMany('ses_owner', [offer]);
    expect((await r.offers.find('ses_owner', offer.id))?.segments).toEqual(offer.segments);
    const b = await booking({ offer, pnr: 'BRR234' });
    await r.bookings.insert(b);
    expect((await r.bookings.findByPnr('BRR234'))?.offer.segments[0]?.destination).toBe('HSBR');
  });

  it('bookings: round-trips every field, rejects duplicate PNRs', async () => {
    const r = await make();
    await withSessions(r, 'ses_owner');
    const b = await booking();
    await r.bookings.insert(b);
    expect(await r.bookings.findById(b.id)).toEqual(b);
    expect(await r.bookings.findByPnr('abc234')).toEqual(b);
    await expect(r.bookings.insert(await booking())).rejects.toBeInstanceOf(DuplicateKeyError);
  });

  it('bookings: transitions are compare-and-set', async () => {
    const r = await make();
    await withSessions(r, 'ses_owner');
    const b = await booking();
    await r.bookings.insert(b);
    const first = await r.bookings.transition(b.id, ['held'], { status: 'ticketing', updatedAt: iso(1) });
    expect(first?.status).toBe('ticketing');
    expect(await r.bookings.transition(b.id, ['held'], { status: 'expired', updatedAt: iso(2) })).toBeUndefined();
    const done = await r.bookings.transition(b.id, ['ticketing'], { status: 'ticketed', ticketNumbers: ['9990000000001'], updatedAt: iso(3) });
    expect(done?.ticketNumbers).toEqual(['9990000000001']);
  });

  it('bookings: finds lapsed holds and stuck ticketing', async () => {
    const r = await make();
    await withSessions(r, 'ses_owner');
    const lapsed = await booking({ pnr: 'LAP234', holdExpiresAt: iso(-1) });
    const open = await booking({ pnr: 'NPN234', holdExpiresAt: iso(30) });
    const stuck = await booking({ pnr: 'STK234', status: 'ticketing', updatedAt: iso(-20) });
    for (const b of [lapsed, open, stuck]) await r.bookings.insert(b);
    expect((await r.bookings.findLapsedHolds(NOW, 10)).map((b) => b.pnr)).toEqual(['LAP234']);
    expect((await r.bookings.findStuckTicketing(new Date(iso(-5)), 10)).map((b) => b.pnr)).toEqual(['STK234']);
  });

  it('payments: idempotency key returns the existing row; latest is by insertion, not timestamp', async () => {
    const r = await make();
    await withSessions(r, 'ses_owner');
    const b = await booking();
    await r.bookings.insert(b);
    const p1 = payment(b.id);
    expect((await r.payments.insertIfAbsent(p1)).created).toBe(true);
    const again = await r.payments.insertIfAbsent({ ...payment(b.id), idempotencyKey: p1.idempotencyKey });
    expect(again).toEqual({ payment: p1, created: false });

    await r.payments.transition(p1.id, ['requested'], { status: 'cancelled', updatedAt: iso(0) });
    // Same timestamps on purpose: ordering must not depend on them.
    const p2 = payment(b.id, { idempotencyKey: `pay:${b.id}:2`, method: 'mtn_momo', provider: 'sandbox' });
    await r.payments.insertIfAbsent(p2);
    expect((await r.payments.findLatestForBooking(b.id))?.id).toBe(p2.id);
    expect((await r.payments.findByProviderReference(p2.providerReference))?.id).toBe(p2.id);
  });

  it('payments: at most one open request per booking', async () => {
    const r = await make();
    await withSessions(r, 'ses_owner');
    const b = await booking();
    await r.bookings.insert(b);
    const open = payment(b.id);
    await r.payments.insertIfAbsent(open);
    await expect(r.payments.insertIfAbsent(payment(b.id, { idempotencyKey: `pay:${b.id}:2` }))).rejects.toMatchObject({ field: 'openPaymentRequest' });
    // Once the first is no longer open, a new attempt is allowed.
    await r.payments.transition(open.id, ['requested'], { status: 'failed', updatedAt: iso(1) });
    expect((await r.payments.insertIfAbsent(payment(b.id, { idempotencyKey: `pay:${b.id}:2` }))).created).toBe(true);
  });

  it('payments: refund reference persists; stale lookup filters by status, provider and age', async () => {
    const r = await make();
    await withSessions(r, 'ses_owner');
    const b = await booking();
    await r.bookings.insert(b);
    const p = payment(b.id, { status: 'succeeded', updatedAt: iso(-30) });
    await r.payments.insertIfAbsent(p);
    const refunded = await r.payments.transition(p.id, ['succeeded'], { status: 'refund_requested', refundReference: 're_1', updatedAt: iso(-20) });
    expect(refunded?.refundReference).toBe('re_1');
    expect((await r.payments.findStale(['refund_requested'], 'stripe', new Date(iso(-10)), 10)).map((x) => x.id)).toEqual([p.id]);
    expect(await r.payments.findStale(['refund_requested'], 'sandbox', new Date(iso(-10)), 10)).toEqual([]);
    expect(await r.payments.findStale(['refund_requested'], 'stripe', new Date(iso(-25)), 10)).toEqual([]);
  });

  it('confirmations: payload round-trips; single use; expiry sweep', async () => {
    const r = await make();
    await withSessions(r, 'ses_owner');
    const c: PendingConfirmation = {
      id: 'cnf_1',
      sessionId: 'ses_owner',
      kind: 'create_reservation',
      summary: 'Reserve XS410',
      payload: { kind: 'create_reservation', offerId: 'off_1', passengers: [adult()], contact: { phone: '+211912345678', email: 'akol.deng@example.com' } },
      expiresAt: iso(15),
      status: 'pending',
    };
    await r.confirmations.insert(c);
    expect(await r.confirmations.find('cnf_1')).toEqual(c);
    expect((await r.confirmations.transition('cnf_1', 'pending', 'confirmed'))?.status).toBe('confirmed');
    expect(await r.confirmations.transition('cnf_1', 'pending', 'confirmed')).toBeUndefined();

    await r.confirmations.insert({ ...c, id: 'cnf_2', expiresAt: iso(-1) });
    expect(await r.confirmations.expireStale(NOW)).toBe(1);
    expect(await r.confirmations.listPending('ses_owner')).toEqual([]);
  });

  it('processed events: first delivery wins', async () => {
    const r = await make();
    expect(await r.events.markIfNew('stripe:evt_1')).toBe(true);
    expect(await r.events.markIfNew('stripe:evt_1')).toBe(false);
  });

  it('conversations: round-trip and retention', async () => {
    const r = await make();
    await withSessions(r, 'ses_a');
    const msgs = [{ role: 'user', content: 'Juba to Wau' }];
    await r.conversations.save('ses_a', msgs);
    expect(await r.conversations.load('ses_a')).toEqual(msgs);
    expect(await r.conversations.load('ses_b')).toEqual([]);
    expect(await r.conversations.deleteNotUpdatedSince(new Date(Date.now() + 60_000))).toBe(1);
    expect(await r.conversations.load('ses_a')).toEqual([]);
  });

  it('job leases: exclusive until expiry, renewable by the owner', async () => {
    const r = await make();
    const until = new Date(NOW.getTime() + 60_000);
    expect(await r.leases.tryAcquire('job', 'a', until, NOW)).toBe(true);
    expect(await r.leases.tryAcquire('job', 'b', until, NOW)).toBe(false);
    expect(await r.leases.tryAcquire('job', 'a', new Date(until.getTime() + 60_000), NOW)).toBe(true);
    expect(await r.leases.tryAcquire('job', 'b', until, new Date(until.getTime() + 61_000))).toBe(true);
    await r.leases.release('job', 'a'); // not the owner any more: no effect
    expect(await r.leases.tryAcquire('job', 'a', until, NOW)).toBe(false);
  });
});

describe.runIf(storageMode() === 'postgres')('postgres-only guarantees', () => {
  const t = () => {
    const x = testDb();
    if (!x) throw new Error('no db');
    return x;
  };

  it('encrypts personal data at rest and binds ciphertext to its row', async () => {
    const { repos, db } = t();
    const b = await booking();
    await repos.bookings.insert(b);
    const [row] = await db.$queryRaw<Array<{ passengers_enc: string; contact_enc: string }>>`SELECT passengers_enc, contact_enc FROM bookings WHERE id = ${b.id}`;
    expect(row?.passengers_enc).not.toContain('R00123456');
    expect(row?.passengers_enc).not.toContain('Akol');
    expect(row?.contact_enc).not.toContain('912345678');

    // Copying one booking's ciphertext onto another row must not decrypt.
    const other = await booking({ pnr: 'XYZ234' });
    await repos.bookings.insert(other);
    await db.$executeRaw`UPDATE bookings SET passengers_enc = ${row?.passengers_enc} WHERE id = ${other.id}`;
    await expect(repos.bookings.findById(other.id)).rejects.toThrow();
  });

  it('exactly one of many concurrent transitions wins', async () => {
    const { repos } = t();
    const b = await booking();
    await repos.bookings.insert(b);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => repos.bookings.transition(b.id, ['held', 'payment_pending'], { status: 'ticketing', updatedAt: iso(i) })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('exactly one of many concurrent duplicate events is new', async () => {
    const { repos } = t();
    const results = await Promise.all(Array.from({ length: 12 }, () => repos.events.markIfNew('stripe:evt_race')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('exactly one of many instances takes a free job lease', async () => {
    const { repos } = t();
    const until = new Date(NOW.getTime() + 60_000);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => repos.leases.tryAcquire('race', `inst_${i}`, until, NOW)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('database rejects a ticketed booking without tickets and malformed PNRs', async () => {
    const { repos, db } = t();
    const b = await booking();
    await repos.bookings.insert(b);
    await expect(repos.bookings.transition(b.id, ['held'], { status: 'ticketed', updatedAt: iso(1) })).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE bookings SET pnr = 'IO0O1I' WHERE id = ${b.id}`).rejects.toThrow(/bookings_pnr_format/);
  });
});
