import { describe, expect, it } from 'vitest';
import { adult, CONTACT, FRIDAY, testContainer, ONE_ADULT } from './helpers.js';
import type { Container } from '../src/container.js';

const SID = 'ses_owner';

/** Runs a real search through the container's executor path to obtain an offer for `SID`. */
async function searchOffer(c: Container, origin = 'JUB', destination = 'NBO', passengers = ONE_ADULT): Promise<string> {
  const r = await c.search.search(SID, { origin, destination, departureDate: FRIDAY, passengers, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const id = r.offers[0]?.offerId;
  if (!id) throw new Error('no offers');
  return id;
}

async function heldBooking(c: Container) {
  const offerId = await searchOffer(c);
  const proposal = await c.confirmations.proposeReservation(SID, offerId, [adult()], CONTACT);
  return c.confirmations.approve(SID, proposal.confirmationId);
}

function webhook(c: Container, body: object, at: Date) {
  const raw = JSON.stringify(body);
  return { raw, sig: c.payments.sign(raw, Math.floor(at.getTime() / 1000)) };
}

describe('reservations', () => {
  it('only holds seats after the traveller approves the confirmation', async () => {
    const { c } = testContainer();
    const offerId = await searchOffer(c);
    const proposal = await c.confirmations.proposeReservation(SID, offerId, [adult()], CONTACT);
    expect(await c.bookings.list(SID)).toHaveLength(0);

    const booking = await c.confirmations.approve(SID, proposal.confirmationId);
    expect(booking.status).toBe('held');
    expect(booking.pnr).toMatch(/^[A-Z2-9]{6}$/);
    expect(booking.passengers[0]?.passport).toBe('•••456');
  });

  it('rejects approving twice, and approving from another session', async () => {
    const { c } = testContainer();
    const offerId = await searchOffer(c);
    const p = await c.confirmations.proposeReservation(SID, offerId, [adult()], CONTACT);
    await expect(c.confirmations.approve('ses_intruder', p.confirmationId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await c.confirmations.approve(SID, p.confirmationId);
    await expect(c.confirmations.approve(SID, p.confirmationId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await c.bookings.list(SID)).toHaveLength(1);
  });

  it('validates passengers before proposing', async () => {
    const { c } = testContainer();
    const offerId = await searchOffer(c);
    const noPassport = adult();
    delete noPassport.passportNumber;
    await expect(c.confirmations.proposeReservation(SID, offerId, [noPassport], CONTACT)).rejects.toThrow(/passport number/);
    await expect(c.confirmations.proposeReservation(SID, offerId, [adult({ passportExpiry: '2027-01-01' })], CONTACT)).rejects.toThrow(/6 months/);
    await expect(c.confirmations.proposeReservation(SID, offerId, [adult({ dateOfBirth: '2020-01-01' })], CONTACT)).rejects.toThrow(/must be booked as "child"/);
    await expect(c.confirmations.proposeReservation(SID, offerId, [adult(), adult()], CONTACT)).rejects.toThrow(/priced for 1/);
  });

  it('does not require a passport for domestic trips', async () => {
    const { c } = testContainer();
    const offerId = await searchOffer(c, 'JUB', 'WUU');
    const p = adult();
    delete p.passportNumber;
    delete p.passportExpiry;
    await expect(c.confirmations.proposeReservation(SID, offerId, [p], CONTACT)).resolves.toMatchObject({ kind: 'create_reservation' });
  });

  it('rejects expired offers and expires lapsed holds', async () => {
    const { c, clock } = testContainer();
    const offerId = await searchOffer(c);
    clock.advanceMinutes(31);
    await expect(c.confirmations.proposeReservation(SID, offerId, [adult()], CONTACT)).rejects.toMatchObject({ code: 'OFFER_EXPIRED' });

    const booking = await heldBooking(c);
    clock.advanceMinutes(61);
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('expired');
  });

  it('hides other sessions\' bookings', async () => {
    const { c } = testContainer();
    const booking = await heldBooking(c);
    await expect(c.bookings.view('ses_other', booking.pnr)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('payments', () => {
  it('is idempotent: repeating the request does not create a second charge', async () => {
    const { c } = testContainer();
    const b = await heldBooking(c);
    const first = await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const again = await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    expect(again.paymentId).toBe(first.paymentId);
    expect(first.instructions).toMatch(/MTN MoMo/);
    expect(first.instructions).not.toContain('912345678');
  });

  it('tickets only after a verified success webhook, and handles duplicates', async () => {
    const { c, clock } = testContainer();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'zain_mgurush', '+211922222222');
    const payment = await c.payments.latestForBooking(b.bookingId);
    const event = { id: 'evt_1', type: 'payment.succeeded', data: { providerReference: payment?.providerReference, amountMinor: payment?.charge.amountMinor, currency: payment?.charge.currency } };
    const { raw, sig } = webhook(c, event, clock.now());

    expect((await c.payments.handleSandboxWebhook(raw, sig)).status).toBe('processed');
    const ticketed = await c.bookings.view(SID, b.pnr);
    expect(ticketed.status).toBe('ticketed');
    expect(ticketed.ticketNumbers).toHaveLength(1);

    expect((await c.payments.handleSandboxWebhook(raw, sig)).status).toBe('duplicate');
    expect((await c.bookings.view(SID, b.pnr)).ticketNumbers).toEqual(ticketed.ticketNumbers);
  });

  it('rejects forged, tampered and stale webhooks', async () => {
    const { c, clock } = testContainer();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    const event = { id: 'evt_x', type: 'payment.succeeded', data: { providerReference: p?.providerReference, amountMinor: p?.charge.amountMinor, currency: p?.charge.currency } };
    const { raw, sig } = webhook(c, event, clock.now());

    await expect(c.payments.handleSandboxWebhook(raw, undefined)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(c.payments.handleSandboxWebhook(raw, 't=1,v1=deadbeef')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const tampered = raw.replace('"payment.succeeded"', '"payment.failed"');
    expect(tampered).not.toBe(raw);
    await expect(c.payments.handleSandboxWebhook(tampered, sig)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const stale = webhook(c, event, new Date(clock.now().getTime() - 10 * 60_000));
    await expect(c.payments.handleSandboxWebhook(stale.raw, stale.sig)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending');
  });

  it('never tickets on an amount mismatch', async () => {
    const { c, clock } = testContainer();
    const b = await heldBooking(c);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    const { raw, sig } = webhook(c, { id: 'evt_m', type: 'payment.succeeded', data: { providerReference: p?.providerReference, amountMinor: 1, currency: 'SSP' } }, clock.now());
    await expect(c.payments.handleSandboxWebhook(raw, sig)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('payment_pending');
  });

  it('returns the booking to held after a failed payment so the traveller can retry', async () => {
    const { c, clock } = testContainer();
    const b = await heldBooking(c);
    const first = await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'mtn_momo', '+211912345678');
    const p = await c.payments.latestForBooking(b.bookingId);
    const { raw, sig } = webhook(c, { id: 'evt_f', type: 'payment.failed', data: { providerReference: p?.providerReference, amountMinor: p?.charge.amountMinor, currency: p?.charge.currency } }, clock.now());
    await c.payments.handleSandboxWebhook(raw, sig);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('held');
    const retry = await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    expect(retry.paymentId).not.toBe(first.paymentId);
  });
});

describe('cancellation and refunds', () => {
  it('releases an unpaid hold without charging', async () => {
    const { c } = testContainer();
    const b = await heldBooking(c);
    const p = await c.confirmations.proposeCancellation(SID, b.pnr);
    expect(p.summary).toMatch(/not been charged/);
    expect((await c.confirmations.approve(SID, p.confirmationId)).status).toBe('cancelled');
  });

  it('refunds a refundable ticket minus the penalty, completed by webhook', async () => {
    const { c, clock } = testContainer();
    // Business fares in the sandbox are always refundable.
    const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'business', maxStops: 0, sortBy: 'best' });
    const offerId = r.offers[0]?.offerId ?? '';
    const b = await c.confirmations.approve(SID, (await c.confirmations.proposeReservation(SID, offerId, [adult()], CONTACT)).confirmationId);
    await c.payments.initiate(await c.bookings.getOwned(SID, b.pnr), 'card', '+211912345678');
    const pay = await c.payments.latestForBooking(b.bookingId);
    const ok = webhook(c, { id: 'evt_ok', type: 'payment.succeeded', data: { providerReference: pay?.providerReference, amountMinor: pay?.charge.amountMinor, currency: pay?.charge.currency } }, clock.now());
    await c.payments.handleSandboxWebhook(ok.raw, ok.sig);

    const cancel = await c.confirmations.proposeCancellation(SID, b.pnr);
    expect(cancel.summary).toMatch(/refunded \(penalty USD 50\.00\)/);
    expect((await c.confirmations.approve(SID, cancel.confirmationId)).status).toBe('refund_pending');

    const refund = webhook(c, { id: 'evt_rf', type: 'refund.succeeded', data: { providerReference: pay?.providerReference, amountMinor: 0, currency: 'USD' } }, clock.now());
    await c.payments.handleSandboxWebhook(refund.raw, refund.sig);
    expect((await c.bookings.view(SID, b.pnr)).status).toBe('refunded');
  });
});

describe('traveller details for real airlines', () => {
  it('requires Latin-script names, a valid email, and travellers matching the priced mix', async () => {
    const { c } = testContainer();
    const offerId = await searchOffer(c);
    await expect(c.confirmations.proposeReservation(SID, offerId, [adult({ givenName: 'أكول' })], CONTACT)).rejects.toThrow(/Latin letters/);
    await expect(c.confirmations.proposeReservation(SID, offerId, [adult()], { ...CONTACT, email: 'not-an-email' })).rejects.toThrow(/valid contact email/);

    const family = { adults: 1, childAges: [5], infants: 0 };
    const familyOffer = await searchOffer(c, 'JUB', 'NBO', family);
    const sevenYearOld = adult({ type: 'child', givenName: 'Deng', dateOfBirth: '2019-01-15' });
    await expect(c.confirmations.proposeReservation(SID, familyOffer, [adult(), sevenYearOld], CONTACT)).rejects.toThrow(/children aged \[5\]/);
    const fiveYearOld = adult({ type: 'child', givenName: 'Deng', dateOfBirth: '2021-03-01' });
    await expect(c.confirmations.proposeReservation(SID, familyOffer, [adult(), fiveYearOld], CONTACT)).resolves.toMatchObject({ kind: 'create_reservation' });
  });

  it('prices children and lap infants below adults, and limits infants to one per adult', async () => {
    const { c } = testContainer();
    const q = (passengers: { adults: number; childAges: number[]; infants: number }) =>
      c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers, cabin: 'economy', maxStops: 0, sortBy: 'cheapest' });
    const cents = async (m: { adults: number; childAges: number[]; infants: number }) => {
      const r = await q(m);
      return Number((r.offers[0]?.price ?? '').replace(/[^\d.]/g, '')) * 100;
    };
    const one = await cents({ adults: 1, childAges: [], infants: 0 });
    const withChild = await cents({ adults: 1, childAges: [6], infants: 0 });
    const withInfant = await cents({ adults: 1, childAges: [], infants: 1 });
    expect(withChild - one).toBeGreaterThan(0);
    expect(withChild - one).toBeLessThan(one);
    expect(withInfant - one).toBeLessThan((withChild - one) / 2);
    await expect(q({ adults: 1, childAges: [], infants: 2 })).rejects.toThrow(/separate adult/);
    await expect(q({ adults: 5, childAges: [3, 4, 5, 6, 7], infants: 0 })).rejects.toThrow(/limited to 9/);
  });
});
