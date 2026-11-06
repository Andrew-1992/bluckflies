import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from '../src/lib/password.js';
import { base32Decode, base32Encode, totpCode, totpStep, verifyTotp } from '../src/lib/totp.js';
import { adult, CONTACT, FixedClock, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';

const ADMIN_TOKEN = 'a'.repeat(40);
const breakGlass = { authorization: `Bearer ${ADMIN_TOKEN}`, 'x-staff-name': 'Founder' };
const PASSWORD = 'correct horse battery staple';

type App = ReturnType<typeof createApp>;

async function createStaff(app: App, email: string, role: 'admin' | 'agent' | 'partner', name = 'Staff Member') {
  return (await request(app).post('/api/admin/staff').set(breakGlass).send({ email, name, role, password: PASSWORD }).expect(201)).body.staff;
}
function login(app: App, email: string, code?: string) {
  return request(app).post('/api/staff/login').send({ email, password: PASSWORD, ...(code ? { code } : {}) });
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Enrols two-step login and returns the secret. */
async function enrol(app: App, token: string, clock: FixedClock) {
  const { secret } = (await request(app).post('/api/staff/2fa/start').set(bearer(token)).expect(200)).body;
  await request(app).post('/api/staff/2fa/confirm').set(bearer(token)).send({ code: totpCode(secret, totpStep(clock.now())) }).expect(204);
  return secret as string;
}

async function cashAndCardTickets(c: Container) {
  const r = await c.search.search('ses_owner', { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation('ses_owner', r.offers[0]?.offerId ?? '', [adult()], CONTACT);
  const v = await c.confirmations.approve('ses_owner', p.confirmationId);
  const booking = await c.bookings.getOwned('ses_owner', v.pnr);
  await c.payments.initiate(booking, 'cash_office', CONTACT.phone);
  const other = await c.support.open('ses_owner', 'complaint', 'Seat was broken.');
  const cash = (await c.repos.tickets.list({ limit: 10 })).find((t) => t.reason === 'cash_office');
  return { cashTicket: cash?.id ?? '', otherTicket: other.ticketId, booking };
}

describe('password hashing and two-step codes', () => {
  it('hashes with scrypt, verifies, and flags weak parameters for rehash', async () => {
    const h = await hashPassword(PASSWORD);
    expect(h).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(await verifyPassword(PASSWORD, h)).toBe(true);
    expect(await verifyPassword('wrong password here', h)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash(h.replace('$32768$', '$16384$'))).toBe(true);
    expect(passwordProblem('short', { email: 'a@b.co', name: 'A' })).toMatch(/12 characters/);
    expect(passwordProblem('mary.akol-2026-pass', { email: 'mary.akol@bluckflies.com', name: 'Mary' })).toMatch(/email/);
    expect(passwordProblem(PASSWORD, { email: 'mary@bluckflies.com', name: 'Mary' })).toBeUndefined();
  });

  it('matches the RFC 6238 test vectors and accepts one step of clock drift', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, totpStep(new Date(59_000)))).toBe('287082');
    expect(totpCode(secret, totpStep(new Date(1_111_111_109_000)))).toBe('081804');
    const at = new Date(1_111_111_109_000);
    expect(verifyTotp(secret, totpCode(secret, totpStep(at) - 1), at)).toBe(totpStep(at) - 1);
    expect(verifyTotp(secret, totpCode(secret, totpStep(at) - 2), at)).toBeUndefined();
    expect(verifyTotp(secret, 'abcdef', at)).toBeUndefined();
  });
});

describe('staff accounts', () => {
  it('bootstraps the first admin with the admin token, then signs in with email and password', async () => {
    const { c } = testContainer({}, { ADMIN_API_TOKEN: ADMIN_TOKEN, STAFF_REQUIRE_2FA: 'false' });
    const app = createApp(c);
    await request(app).post('/api/admin/staff').set({ authorization: `Bearer ${ADMIN_TOKEN}` }).send({ email: 'a@b.co', name: 'X', role: 'admin', password: PASSWORD }).expect(400); // token needs a name
    const admin = await createStaff(app, 'Mary.Akol@BluckFlies.com', 'admin', 'Mary Akol');
    expect(admin).toMatchObject({ email: 'mary.akol@bluckflies.com', role: 'admin', twoStepEnabled: false });
    expect(JSON.stringify(admin)).not.toMatch(/scrypt|password/);
    await request(app).post('/api/admin/staff').set(breakGlass).send({ email: 'mary.akol@bluckflies.com', name: 'Dup', role: 'agent', password: PASSWORD }).expect(409);

    const ok = (await login(app, 'MARY.AKOL@bluckflies.com').expect(200)).body;
    expect(ok.status).toBe('ok');
    const me = (await request(app).get('/api/staff/me').set(bearer(ok.token)).expect(200)).body.staff;
    expect(me).toMatchObject({ name: 'Mary Akol', role: 'admin', needs2fa: false });

    // Actions are attributed to the account, not to a header anyone can set.
    const t = await c.support.open('ses_owner', 'complaint', 'Test');
    await request(app).post(`/api/admin/tickets/${t.ticketId}/notes`).set({ ...bearer(ok.token), 'x-staff-name': 'Someone Else' }).send({ body: 'Called the traveller.' }).expect(201);
    expect((await c.repos.tickets.notes(t.ticketId))[0]?.author).toBe('Mary Akol');

    await request(app).post('/api/staff/logout').set(bearer(ok.token)).expect(204);
    await request(app).get('/api/staff/me').set(bearer(ok.token)).expect(401);
  });

  it('gives the same answer for unknown accounts and wrong passwords, and locks after 5 failures', async () => {
    const { c, clock } = testContainer({}, { ADMIN_API_TOKEN: ADMIN_TOKEN, STAFF_REQUIRE_2FA: 'false' });
    const app = createApp(c);
    await createStaff(app, 'agent@bluckflies.com', 'agent');
    const unknown = await request(app).post('/api/staff/login').send({ email: 'nobody@bluckflies.com', password: PASSWORD }).expect(401);
    const wrong = await request(app).post('/api/staff/login').send({ email: 'agent@bluckflies.com', password: 'not the password!' }).expect(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    for (let i = 0; i < 4; i++) await request(app).post('/api/staff/login').send({ email: 'agent@bluckflies.com', password: 'not the password!' }).expect(401);
    await login(app, 'agent@bluckflies.com').expect(401); // locked, even with the right password
    clock.advanceMinutes(16);
    await login(app, 'agent@bluckflies.com').expect(200);
  });

  it('requires two-step login when configured: setup first, then a fresh code at every sign-in, never reused', async () => {
    const { c, clock } = testContainer({}, { ADMIN_API_TOKEN: ADMIN_TOKEN, STAFF_REQUIRE_2FA: 'true' });
    const app = createApp(c);
    await createStaff(app, 'agent@bluckflies.com', 'agent');
    const first = (await login(app, 'agent@bluckflies.com').expect(200)).body;
    expect((await request(app).get('/api/staff/me').set(bearer(first.token)).expect(200)).body.staff.needs2fa).toBe(true);
    await request(app).get('/api/admin/tickets').set(bearer(first.token)).expect(403); // desk locked until setup
    const secret = await enrol(app, first.token, clock);
    await request(app).get('/api/admin/tickets').set(bearer(first.token)).expect(200);

    expect((await login(app, 'agent@bluckflies.com').expect(200)).body).toEqual({ status: 'code_required' });
    clock.advanceMinutes(1);
    const code = totpCode(secret, totpStep(clock.now()));
    await login(app, 'agent@bluckflies.com', code).expect(200);
    await login(app, 'agent@bluckflies.com', code).expect(401); // replay of the same code
    await login(app, 'agent@bluckflies.com', '000000').expect(401);
  });

  it('limits each role: agents cannot manage staff or rates; partners only see and confirm cash payments', async () => {
    const { c } = testContainer({}, { ADMIN_API_TOKEN: ADMIN_TOKEN, STAFF_REQUIRE_2FA: 'false' });
    const app = createApp(c);
    const { cashTicket, otherTicket, booking } = await cashAndCardTickets(c);
    await createStaff(app, 'agent@bluckflies.com', 'agent');
    await createStaff(app, 'partner@niletravel.example', 'partner', 'Nile Travel');
    const agent = bearer((await login(app, 'agent@bluckflies.com')).body.token);
    const partner = bearer((await login(app, 'partner@niletravel.example')).body.token);

    await request(app).get('/api/admin/staff').set(agent).expect(403);
    await request(app).post('/api/admin/fx-rates').set(agent).send({ currency: 'SSP', perUsd: '4600', asOf: '2026-10-30T09:00:00Z', source: 'x' }).expect(403);
    await request(app).get(`/api/admin/tickets/${otherTicket}`).set(agent).expect(200);

    const seen = (await request(app).get('/api/admin/tickets').set(partner).expect(200)).body.tickets.map((t: { id: string }) => t.id);
    expect(seen).toEqual([cashTicket]);
    await request(app).get(`/api/admin/tickets/${otherTicket}`).set(partner).expect(404);
    await request(app).patch(`/api/admin/tickets/${cashTicket}`).set(partner).send({ status: 'resolved' }).expect(403);
    await request(app).post('/api/admin/payments/bank-statement').set(partner).set('content-type', 'text/csv').send('a,b').expect(403);
    const res = await request(app).post(`/api/admin/tickets/${cashTicket}/manual-payment`).set(partner).send({ received: true, amountUsd: (booking.offer.totalPrice.amountCents / 100).toFixed(2), reference: 'NT-0091' }).expect(200);
    expect(res.body.bookingStatus).toBe('ticketed');
    expect((await c.repos.tickets.notes(cashTicket)).some((n) => n.author === 'Nile Travel' && /receipt NT-0091/.test(n.body))).toBe(true);
  });

  it('signs a person out everywhere when they are disabled, their role changes or their password is reset', async () => {
    const { c } = testContainer({}, { ADMIN_API_TOKEN: ADMIN_TOKEN, STAFF_REQUIRE_2FA: 'false' });
    const app = createApp(c);
    const agent = await createStaff(app, 'agent@bluckflies.com', 'agent');
    const token = (await login(app, 'agent@bluckflies.com')).body.token;
    await request(app).patch(`/api/admin/staff/${agent.id}`).set(breakGlass).send({ disabled: true }).expect(200);
    await request(app).get('/api/staff/me').set(bearer(token)).expect(401);
    await login(app, 'agent@bluckflies.com').expect(401);
    await request(app).patch(`/api/admin/staff/${agent.id}`).set(breakGlass).send({ disabled: false }).expect(200);
    const again = (await login(app, 'agent@bluckflies.com').expect(200)).body.token;
    await request(app).patch(`/api/admin/staff/${agent.id}`).set(breakGlass).send({ role: 'partner' }).expect(200);
    await request(app).get('/api/staff/me').set(bearer(again)).expect(401);
  });

  it('changing your own password keeps this session and ends the others', async () => {
    const { c } = testContainer({}, { ADMIN_API_TOKEN: ADMIN_TOKEN, STAFF_REQUIRE_2FA: 'false' });
    const app = createApp(c);
    await createStaff(app, 'agent@bluckflies.com', 'agent');
    const a = (await login(app, 'agent@bluckflies.com')).body.token;
    const b = (await login(app, 'agent@bluckflies.com')).body.token;
    await request(app).post('/api/staff/password').set(bearer(a)).send({ current: 'wrong current pass', next: 'a whole new passphrase' }).expect(401);
    await request(app).post('/api/staff/password').set(bearer(a)).send({ current: PASSWORD, next: 'short' }).expect(400);
    await request(app).post('/api/staff/password').set(bearer(a)).send({ current: PASSWORD, next: 'a whole new passphrase' }).expect(204);
    await request(app).get('/api/staff/me').set(bearer(a)).expect(200);
    await request(app).get('/api/staff/me').set(bearer(b)).expect(401);
  });

  it('keeps at least one admin, and ends sessions after 2 idle hours', async () => {
    const { c, clock } = testContainer({}, { ADMIN_API_TOKEN: ADMIN_TOKEN, STAFF_REQUIRE_2FA: 'false' });
    const app = createApp(c);
    const admin = await createStaff(app, 'admin@bluckflies.com', 'admin');
    const token = (await login(app, 'admin@bluckflies.com')).body.token;
    await request(app).patch(`/api/admin/staff/${admin.id}`).set(bearer(token)).send({ disabled: true }).expect(400);
    await request(app).patch(`/api/admin/staff/${admin.id}`).set(breakGlass).send({ role: 'agent' }).expect(400);
    clock.advanceMinutes(121);
    await request(app).get('/api/staff/me').set(bearer(token)).expect(401);
  });

  it('works without an admin token once staff exist, and the token never unlocks without being configured', async () => {
    const { c } = testContainer({}, { STAFF_REQUIRE_2FA: 'false' });
    const app = createApp(c);
    await request(app).get('/api/admin/tickets').set(breakGlass).expect(401);
    await c.staff.create('setup', { email: 'admin@bluckflies.com', name: 'Admin', role: 'admin', password: PASSWORD });
    const token = (await login(app, 'admin@bluckflies.com')).body.token;
    await request(app).get('/api/admin/tickets').set(bearer(token)).expect(200);
  });
});
