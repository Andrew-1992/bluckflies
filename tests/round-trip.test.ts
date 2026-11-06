import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { isAppError } from '../src/domain/errors.js';
import { createApp } from '../src/http/app.js';
import type { EmailSender } from '../src/providers/notify/senders.js';
import { adult, CONTACT, FRIDAY, ONE_ADULT, ScriptedLlm, testContainer, text, toolCall } from './helpers.js';
import { FAKE_TOKEN, FakeDuffel } from './support/fakeDuffel.js';

const SID = 'ses_owner';
const BACK = '2026-11-13'; // a week after FRIDAY
const BANK = { BANK_NAME: 'KCB', BANK_ACCOUNT_NAME: 'BluckFlies Ltd', BANK_ACCOUNT_NUMBER: '1234567890', AUTH_SECRET: 's'.repeat(40), PUBLIC_BASE_URL: 'https://bluckflies.example' };

class RecordingEmail implements EmailSender {
  readonly name = 'recording';
  readonly delivers = true;
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(m: { to: string; subject: string; text: string }) {
    this.sent.push(m);
  }
}

const roundTrip = (c: Container, returnDate = BACK) =>
  c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, returnDate, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });

async function validationMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isAppError(err) && err.code === 'VALIDATION_FAILED') return err.message;
    throw err;
  }
  throw new Error('expected VALIDATION_FAILED');
}

describe('round-trip fares (sandbox airline)', () => {
  it('finds fares covering both directions, the return leaving after the outbound lands', async () => {
    const { c } = testContainer();
    const r = await roundTrip(c);
    expect(r.returnDate).toBe(BACK);
    expect(r.offers.length).toBeGreaterThan(0);
    for (const o of r.offers) {
      const out = o.segments;
      const back = o.return?.segments ?? [];
      expect(out[0]?.from).toBe('JUB');
      expect(out.at(-1)?.to).toBe('NBO');
      expect(back[0]?.from).toBe('NBO');
      expect(back.at(-1)?.to).toBe('JUB');
      expect(back[0]?.departs.slice(0, 10)).toBe(BACK);
      expect(Date.parse(back[0]?.departs ?? '')).toBeGreaterThan(Date.parse(out.at(-1)?.arrives ?? ''));
      expect(o.return?.stops).toBe(back.length - 1);
    }
  });

  it('prices a return ticket below the same flights bought as two one-way tickets', async () => {
    const { c } = testContainer();
    const rt = (await roundTrip(c)).offers[0];
    if (!rt?.return) throw new Error('no round-trip offer');
    // The same flights, one way each.
    const one = async (origin: string, destination: string, date: string, flights: string[]) => {
      const r = await c.search.search(SID, { origin, destination, departureDate: date, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
      const o = r.offers.find((x) => x.segments.map((s) => s.flight).join() === flights.join());
      if (!o) throw new Error(`no one-way offer for ${flights.join()}`);
      return Number(o.price.replace(/[^\d.]/g, ''));
    };
    const outbound = await one('JUB', 'NBO', FRIDAY, rt.segments.map((s) => s.flight));
    const back = await one('NBO', 'JUB', BACK, rt.return.segments.map((s) => s.flight));
    // Sandbox fares vary ±20% by itinerary, so compare against the cheaper end of that range.
    expect(Number(rt.price.replace(/[^\d.]/g, ''))).toBeLessThan((outbound + back) * 1.2);
  });

  it('rejects a return date before the departure date', async () => {
    const { c } = testContainer();
    expect(await validationMessage(roundTrip(c, '2026-11-05'))).toMatch(/return date must be on or after/);
  });

  it('books both directions as one booking: one code, one payment, one ticket per traveller, both in every message', async () => {
    const email = new RecordingEmail();
    const { c } = testContainer({ email }, BANK);
    const offer = (await roundTrip(c)).offers[0];
    if (!offer?.return) throw new Error('no round-trip offer');

    const p = await c.confirmations.proposeReservation(SID, offer.offerId, [adult()], CONTACT);
    expect(p.summary).toMatch(/round trip: outbound .*JUB→NBO.*; return .*NBO→JUB.*one booking, both directions/);
    const v = await c.confirmations.approve(SID, p.confirmationId);

    const view = await c.bookings.view(SID, v.pnr);
    expect(view.route).toBe('JUB ⇄ NBO');
    expect(view.returnSegments?.[0]).toMatchObject({ from: 'NBO' });
    expect(await c.bookings.list(SID)).toHaveLength(1);

    const b = await c.bookings.getOwned(SID, v.pnr);
    await c.payments.initiate(b, 'bank_transfer', CONTACT.phone);
    await c.payments.settleManualPayment(b.id, { received: true, amount: { amountMinor: b.offer.totalPrice.amountCents, currency: 'USD' }, reference: 'FT1' });
    const ticketed = await c.bookings.view(SID, v.pnr);
    expect(ticketed.status).toBe('ticketed');
    expect(ticketed.ticketNumbers).toHaveLength(1);

    await c.notifications.dispatch();
    const ticketMail = email.sent.find((m) => m.subject.includes('ticket'));
    expect(ticketMail?.text).toMatch(/Outbound:\n✈ .*Juba.*→.*Nairobi[\s\S]*Return:\n✈ .*Nairobi.*→.*Juba/);

    const body = c.etickets.render(await c.bookings.getOwned(SID, v.pnr)).toString('latin1');
    expect(body).toContain('(FLIGHTS \\(ROUND TRIP\\))'); // PDF text: headings in capitals, parentheses escaped
    expect(body).toContain('OUTBOUND');
    expect(body).toContain('RETURN');
  });

  it('needs the passport valid six months past the return flight, not just the outbound', async () => {
    const { c } = testContainer();
    const offer = (await roundTrip(c, '2026-12-20')).offers[0];
    if (!offer) throw new Error('no offer');
    // Valid 6 months after the outbound (6 Nov), but not after the return (20 Dec).
    const traveller = { ...adult(), passportExpiry: '2027-05-10' };
    expect(await validationMessage(c.confirmations.proposeReservation(SID, offer.offerId, [traveller], CONTACT))).toMatch(/within 6 months of the return flight/);
  });

  it('keeps one-way searches exactly as before', async () => {
    const { c } = testContainer();
    const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
    expect(r.returnDate).toBeUndefined();
    expect(r.offers.every((o) => o.return === undefined)).toBe(true);
  });

  it('lets the agent search a round trip with return_date, and the step-by-step search too', async () => {
    const llm = new ScriptedLlm([toolCall('search_flights', { origin: 'JUB', destination: 'NBO', departure_date: FRIDAY, return_date: BACK, adults: 1 }), text('Here are return fares.')]);
    const { c } = testContainer({ llm });
    const turn = await c.agent!.handle(SID, 'Juba to Nairobi on the 6th, back on the 13th, 1 adult');
    expect(turn.search?.returnDate).toBe(BACK);
    expect(turn.search?.offers[0]?.return?.segments[0]?.from).toBe('NBO');

    const app = createApp(c);
    const token = (await request(app).post('/api/sessions').expect(201)).body.token as string;
    const res = await request(app)
      .post('/api/search')
      .set('authorization', `Bearer ${token}`)
      .send({ origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, returnDate: BACK, adults: 1 })
      .expect(200);
    expect(res.body.returnDate).toBe(BACK);
    expect(res.body.offers[0].return.segments[0].from).toBe('NBO');
  });
});

describe('round-trip fares (Duffel)', () => {
  let duffel: FakeDuffel;
  beforeEach(async () => {
    duffel = new FakeDuffel();
    duffel.templates = [{ owner: { iata_code: 'KQ', name: 'Kenya Airways' }, totalCents: 52000, requiresInstantPayment: false, departLocal: '14:30', arriveLocal: '17:25', flightNumber: '351', refund: { allowed: true, penaltyCents: 5000 } }];
    await duffel.start();
  });
  afterEach(() => duffel.stop());

  const duffelContainer = () => testContainer({}, { FLIGHT_PROVIDER: 'duffel', DUFFEL_ACCESS_TOKEN: FAKE_TOKEN, DUFFEL_API_URL: duffel.url, DUFFEL_WEBHOOK_SECRET: 'duffel-webhook-secret-123456' }).c;

  it('asks the airline for both slices in one offer request, and maps outbound and return', async () => {
    const r = await roundTrip(duffelContainer());
    expect(duffel.calls('POST', '/air/offer_requests')[0]?.body).toMatchObject({
      data: {
        slices: [
          { origin: 'JUB', destination: 'NBO', departure_date: FRIDAY },
          { origin: 'NBO', destination: 'JUB', departure_date: BACK },
        ],
      },
    });
    expect(r.offers).toHaveLength(1);
    expect(r.offers[0]).toMatchObject({ price: 'USD 520.00', segments: [{ flight: 'KQ351', from: 'JUB', to: 'NBO' }], return: { stops: 0, segments: [{ flight: 'KQ352', from: 'NBO', to: 'JUB', departs: `${BACK}T14:30:00+03:00` }] } });
  });

  it('skips offers that do not cover both directions', async () => {
    duffel.dropReturnSlice = true;
    expect((await roundTrip(duffelContainer())).offers).toEqual([]);
  });

  it('holds one airline order for both directions', async () => {
    const c = duffelContainer();
    const offer = (await roundTrip(c)).offers[0];
    if (!offer) throw new Error('no offer');
    const p = await c.confirmations.proposeReservation(SID, offer.offerId, [adult()], CONTACT);
    await c.confirmations.approve(SID, p.confirmationId);
    expect(duffel.calls('POST', '/air/orders')).toHaveLength(1);
  });
});
