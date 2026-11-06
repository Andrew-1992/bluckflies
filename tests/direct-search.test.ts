import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { adult, CONTACT, FRIDAY, testContainer } from './helpers.js';

const ADMIN = 'a'.repeat(40);
const desk = { authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Mary Akol' };

async function session(app: ReturnType<typeof createApp>) {
  const token = (await request(app).post('/api/sessions').expect(201)).body.token as string;
  return { authorization: `Bearer ${token}` };
}

describe('search without the AI assistant', () => {
  it('searches directly with exact child ages, so the chosen fare can be booked', async () => {
    const { c } = testContainer({}, { ADMIN_API_TOKEN: ADMIN }); // no LLM configured at all
    expect(c.agent).toBeNull();
    const app = createApp(c);
    const auth = await session(app);
    await request(app).post('/api/search').send({ origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, adults: 1 }).expect(401);

    const res = await request(app).post('/api/search').set(auth).send({ origin: 'JUB', destination: 'Nairobi', departureDate: FRIDAY, adults: 1, childAges: [7], infants: 0 }).expect(200);
    expect(res.body.offers.length).toBeGreaterThan(0);
    expect(res.body.destination.code).toBe('NBO');

    // The offer belongs to this session and is priced for the exact ages: a reservation with a 7-year-old matches.
    const sessionId = (await c.repos.sessions.findByTokenHash((await import('../src/lib/ids.js')).hashToken(auth.authorization.slice(7))))?.id ?? '';
    const offer = await c.search.getOffer(sessionId, res.body.offers[0].offerId);
    expect(offer.passengerMix).toEqual({ adults: 1, childAges: [7], infants: 0 });
    const child = adult({ type: 'child', givenName: 'Deng', familyName: 'Akol', dateOfBirth: '2019-03-01' });
    await expect(c.confirmations.proposeReservation(sessionId, offer.id, [adult(), child], CONTACT)).resolves.toBeDefined();
  });

  it('validates the search and finds town airstrips by name', async () => {
    const { c } = testContainer();
    const app = createApp(c);
    const auth = await session(app);
    await request(app).post('/api/search').set(auth).send({ origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, adults: 8, childAges: [5, 6] }).expect(400);
    await request(app).post('/api/search').set(auth).send({ origin: 'JUB', destination: 'NBO', departureDate: '6/11/2026', adults: 1 }).expect(400);
    const lafon = await request(app).post('/api/search').set(auth).send({ origin: 'JUB', destination: 'Lafon', departureDate: FRIDAY, adults: 1 }).expect(200);
    expect(lafon.body.destination.code).toBe('HSTR');
  });

  it('explains that the assistant is unavailable, and staff get a call-back request with the chosen flight', async () => {
    const { c } = testContainer({}, { ADMIN_API_TOKEN: ADMIN });
    const app = createApp(c);
    const auth = await session(app);
    const chat = await request(app).post('/api/chat').set(auth).send({ message: 'I choose this flight' }).expect(503);
    expect(chat.body.error).toMatchObject({ code: 'AGENT_UNAVAILABLE', message: expect.stringMatching(/step by step/) });

    const found = await request(app).post('/api/search').set(auth).send({ origin: 'JUB', destination: 'EBB', departureDate: FRIDAY, adults: 2 }).expect(200);
    const offerId = found.body.offers[0].offerId;
    await request(app).post('/api/booking-requests').set(auth).send({ offerId, name: 'Akol Deng', phone: '12' }).expect(400);
    const other = await session(app);
    await request(app).post('/api/booking-requests').set(other).send({ offerId, name: 'Akol Deng', phone: '0912345678' }).expect(404); // not their offer
    const req = await request(app).post('/api/booking-requests').set(auth).send({ offerId, name: 'Akol Deng', phone: '0912 345 678', language: 'ar' }).expect(201);

    const detail = (await request(app).get(`/api/admin/tickets/${req.body.requestId}`).set(desk).expect(200)).body;
    expect(detail.ticket.reason).toBe('booking_request');
    expect(detail.ticket.summary).toMatch(/Please call Akol Deng to book: XS420 JUB-EBB 2026-11-06 .*2 adults.*Prefers Arabic/);
    expect(detail.travellerPhone).toBe('+211912345678');
    expect(detail.ticket.summary).not.toContain('912345678'); // the phone is kept encrypted, not in the ticket text
  });

  it('accepts a general call-back request (e.g. Help) with what the traveller wrote', async () => {
    const { c } = testContainer({}, { ADMIN_API_TOKEN: ADMIN });
    const app = createApp(c);
    const auth = await session(app);
    const req = await request(app).post('/api/booking-requests').set(auth).send({ message: 'I want to talk to a person', name: 'Nyandeng', phone: '+211955111222' }).expect(201);
    const detail = (await request(app).get(`/api/admin/tickets/${req.body.requestId}`).set(desk).expect(200)).body;
    expect(detail.ticket).toMatchObject({ reason: 'callback_request', summary: 'Please call Nyandeng back. They wrote: "I want to talk to a person"' });
  });
});
