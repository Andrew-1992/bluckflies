import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { signLink, verifyLink } from '../src/lib/signedLinks.js';
import type { EmailSender } from '../src/providers/notify/senders.js';
import { adult, CONTACT, FRIDAY, ONE_ADULT, testContainer } from './helpers.js';

const SID = 'ses_owner';
const BANK = { BANK_NAME: 'KCB', BANK_ACCOUNT_NAME: 'BluckFlies Ltd', BANK_ACCOUNT_NUMBER: '1234567890', AUTH_SECRET: 's'.repeat(40), PUBLIC_BASE_URL: 'https://bluckflies.example' };

class RecordingEmail implements EmailSender {
  readonly name = 'recording';
  readonly delivers = true;
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(m: { to: string; subject: string; text: string }) {
    this.sent.push(m);
  }
}

async function ticketed(c: Container) {
  const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult({ givenName: 'Akol', familyName: 'Deng' })], CONTACT);
  const v = await c.confirmations.approve(SID, p.confirmationId);
  const booking = await c.bookings.getOwned(SID, v.pnr);
  await c.payments.initiate(booking, 'bank_transfer', CONTACT.phone);
  await c.payments.settleManualPayment(booking.id, { received: true, amount: { amountMinor: booking.offer.totalPrice.amountCents, currency: 'USD' }, reference: 'FT1' });
  return c.bookings.getOwned(SID, v.pnr);
}

const pathOf = (url: string) => new URL(url).pathname;

describe('printable e-ticket', () => {
  it('links a ticketed booking to a PDF with the booking code, names, ticket numbers and flights', async () => {
    const { c } = testContainer({}, BANK);
    const app = createApp(c);
    const b = await ticketed(c);
    const view = await c.bookings.view(SID, b.pnr);
    expect(view.eticketUrl).toMatch(/^https:\/\/bluckflies\.example\/e\/bkg_[a-f0-9]+\.\d+\.[\w-]+$/);

    const res = await request(app).get(pathOf(view.eticketUrl ?? '')).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const pdf = (res.body as Buffer).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    for (const text of [b.pnr, 'DENG / AKOL', b.ticketNumbers[0] ?? '?', 'Juba \\(JUB\\)', 'Nairobi \\(NBO\\)', 'by Bank transfer', 'DEMO BOOKING']) expect(pdf).toContain(text);
    expect(pdf).not.toContain(CONTACT.phone); // no contact details on the printout
  });

  it('refuses tampered, expired, wrong-purpose and unticketed links', async () => {
    const { c, clock } = testContainer({}, BANK);
    const app = createApp(c);
    const b = await ticketed(c);
    const url = (await c.bookings.view(SID, b.pnr)).eticketUrl ?? '';
    const token = pathOf(url).slice(3);
    await request(app).get(`/e/${token.slice(0, -2)}xx`).expect(404);
    await request(app).get(`/e/${signLink('s'.repeat(40), 'other-purpose', b.id, new Date(Date.now() + 1e9))}`).expect(404);
    await request(app).get(`/e/${signLink('another secret value at least 32 chars', 'eticket', b.id, new Date(Date.now() + 1e9))}`).expect(404);

    // Not ticketed yet: no link in the view, and a forged-valid link still shows nothing.
    const r = await c.search.search(SID, { origin: 'JUB', destination: 'EBB', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
    const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
    const held = await c.confirmations.approve(SID, p.confirmationId);
    expect((await c.bookings.view(SID, held.pnr)).eticketUrl).toBeUndefined();
    await request(app).get(pathOf(c.etickets.link(held.bookingId))).expect(404);

    clock.advanceMinutes(61 * 24 * 60);
    await request(app).get(pathOf(url)).expect(404);
  });

  it('puts the link in the e-ticket email', async () => {
    const email = new RecordingEmail();
    const { c } = testContainer({ email }, BANK);
    const b = await ticketed(c);
    await c.notifications.dispatch();
    const msg = email.sent.find((m) => m.to === CONTACT.email && /ticket is ready/.test(m.subject));
    expect(msg?.text).toMatch(new RegExp(`Printable e-ticket \\(PDF\\): https://bluckflies\\.example/e/${b.id}\\.`));
  });

  it('signs links per purpose and verifies them in constant form', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    const t = signLink('k'.repeat(32), 'eticket', 'bkg_1', new Date(now.getTime() + 60_000));
    expect(verifyLink('k'.repeat(32), 'eticket', t, now)).toBe('bkg_1');
    expect(verifyLink('k'.repeat(32), 'eticket', t, new Date(now.getTime() + 61_000))).toBeUndefined();
    expect(verifyLink('k'.repeat(32), 'eticket', `${t}.extra`, now)).toBeUndefined();
    expect(verifyLink('k'.repeat(32), 'eticket', 'bkg_1.notanumber.sig', now)).toBeUndefined();
    expect(() => signLink('k'.repeat(32), 'eticket', 'bad id!', now)).toThrow();
  });
});
