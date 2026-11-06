import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { RefundRequiresManualError } from '../src/providers/payments/PaymentProvider.js';
import { DpoClient, parseFlatXml } from '../src/providers/payments/dpo/DpoClient.js';
import { DpoPaymentProvider, serviceDate } from '../src/providers/payments/dpo/DpoPaymentProvider.js';
import { parseMinorUnits } from '../src/lib/money.js';
import { adult, CONTACT, FixedClock, FRIDAY, NOW, ONE_ADULT, testContainer } from './helpers.js';

const SID = 'ses_owner';
const ADMIN = 'a'.repeat(40);
const DPO_ENV = { DPO_COMPANY_TOKEN: '9F416C11-127B-4DE2-AC7F-D5710E4C5E0A', DPO_SERVICE_TYPE: '5525', PUBLIC_BASE_URL: 'https://bluckflies.example' };
const desk = { authorization: `Bearer ${ADMIN}`, 'x-staff-name': 'Mary Akol' };

/** A fake DPO API: answers createToken / verifyToken / cancelToken / refundToken like the documented v6 API. */
class FakeDpo {
  readonly requests: Array<{ name: string; fields: Record<string, string>; xml: string }> = [];
  verify: (token: string) => string = () => '<API3G><Result>900</Result><ResultExplanation>Transaction not paid yet</ResultExplanation></API3G>';
  refund = '<API3G><Result>000</Result><ResultExplanation>Refund successful</ResultExplanation></API3G>';
  private n = 0;

  readonly fetch = (async (_url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const xml = String(init.body ?? '');
    const fields = parseFlatXml(xml);
    const name = fields['Request'] ?? '';
    this.requests.push({ name, fields, xml });
    let body: string;
    if (name === 'createToken') {
      const token = `TOKEN-${String(++this.n).padStart(4, '0')}-ABCDEF`;
      body = `<?xml version="1.0" encoding="utf-8"?><API3G><Result>000</Result><ResultExplanation>Transaction created</ResultExplanation><TransToken>${token}</TransToken><TransRef>R${this.n}</TransRef></API3G>`;
    } else if (name === 'verifyToken') body = this.verify(fields['TransactionToken'] ?? '');
    else if (name === 'cancelToken') body = '<API3G><Result>000</Result><ResultExplanation>Cancelled</ResultExplanation></API3G>';
    else if (name === 'refundToken') body = this.refund;
    else body = '<API3G><Result>803</Result><ResultExplanation>No request</ResultExplanation></API3G>';
    return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
  }) as typeof fetch;

  paid(amount: string, currency = 'USD') {
    this.verify = () => `<API3G><Result>000</Result><ResultExplanation>Transaction paid</ResultExplanation><TransactionAmount>${amount}</TransactionAmount><TransactionCurrency>${currency}</TransactionCurrency><CustomerCredit>4242</CustomerCredit></API3G>`;
  }
}

async function heldBooking(c: Container) {
  const r = await c.search.search(SID, { origin: 'JUB', destination: 'NBO', departureDate: FRIDAY, passengers: ONE_ADULT, cabin: 'economy', maxStops: 1, sortBy: 'cheapest' });
  const p = await c.confirmations.proposeReservation(SID, r.offers[0]?.offerId ?? '', [adult()], CONTACT);
  const view = await c.confirmations.approve(SID, p.confirmationId);
  return c.bookings.getOwned(SID, view.pnr);
}

const decimal = (minor: number) => (minor / 100).toFixed(2);

// ------------------------------------------------------------------ DPO

describe('DPO bank cards', () => {
  it('creates a hosted card payment with the exact amount, hold time and escaped description', async () => {
    const dpo = new FakeDpo();
    const clock = new FixedClock(NOW);
    const provider = new DpoPaymentProvider(new DpoClient({ baseUrl: 'https://secure.3gdirectpay.com', companyToken: DPO_ENV.DPO_COMPANY_TOKEN, timeoutMs: 1000, fetchImpl: dpo.fetch }), clock, {
      serviceType: '5525',
      publicBaseUrl: 'https://bluckflies.example',
      autoRefunds: false,
    });
    const r = await provider.createPaymentRequest({
      method: 'card',
      amount: { amountCents: 41250, currency: 'USD' },
      charge: { amountMinor: 41250, currency: 'USD' },
      payerPhone: '+211912345678',
      payerEmail: 'akol@example.com',
      merchantReference: 'ABC234',
      description: 'Juba → Nairobi <XS410> & return',
      travelDate: '2026-11-06T14:30:00+02:00',
      expiresAt: new Date(NOW.getTime() + 55 * 60_000),
      idempotencyKey: 'pay:bkg_1:2',
    });
    expect(r.checkoutUrl).toBe('https://secure.3gdirectpay.com/payv2.php?ID=TOKEN-0001-ABCDEF');
    const sent = dpo.requests[0];
    expect(sent?.fields).toMatchObject({
      CompanyToken: DPO_ENV.DPO_COMPANY_TOKEN,
      PaymentAmount: '412.50',
      PaymentCurrency: 'USD',
      CompanyRef: 'ABC234-2',
      PTL: '55',
      PTLtype: 'minutes',
      ServiceType: '5525',
      ServiceDate: '2026/11/06 14:30',
      RedirectURL: 'https://bluckflies.example/api/payments/dpo/return',
      ServiceDescription: 'Juba → Nairobi <XS410> & return',
    });
    expect(sent?.xml).toContain('&lt;XS410&gt; &amp; return');
  });

  it('maps DPO results: paid with amount, still open, expired, and configuration errors', async () => {
    const dpo = new FakeDpo();
    const provider = new DpoPaymentProvider(new DpoClient({ baseUrl: 'https://x', companyToken: 'T'.repeat(20), timeoutMs: 1000, fetchImpl: dpo.fetch }), new FixedClock(NOW), { serviceType: '1', publicBaseUrl: 'https://b', autoRefunds: false });
    expect(await provider.getPaymentStatus('TOK')).toEqual({ state: 'open' }); // 900: not paid yet
    dpo.paid('1,412.5');
    expect(await provider.getPaymentStatus('TOK')).toEqual({ state: 'paid', amount: { amountMinor: 141250, currency: 'USD' } });
    dpo.verify = () => '<API3G><Result>901</Result><ResultExplanation>Declined</ResultExplanation></API3G>';
    expect(await provider.getPaymentStatus('TOK')).toEqual({ state: 'open' }); // the traveller may retry on the same page
    dpo.verify = () => '<API3G><Result>903</Result><ResultExplanation>Time limit</ResultExplanation></API3G>';
    expect(await provider.getPaymentStatus('TOK')).toEqual({ state: 'expired' });
    dpo.verify = () => '<API3G><Result>802</Result><ResultExplanation>Company token does not exist</ResultExplanation></API3G>';
    await expect(provider.getPaymentStatus('TOK')).rejects.toThrow(/Company token/);
  });

  it('refunds only when enabled, and sends any refusal to a person', async () => {
    const dpo = new FakeDpo();
    const make = (autoRefunds: boolean) => new DpoPaymentProvider(new DpoClient({ baseUrl: 'https://x', companyToken: 'T'.repeat(20), timeoutMs: 1000, fetchImpl: dpo.fetch }), new FixedClock(NOW), { serviceType: '1', publicBaseUrl: 'https://b', autoRefunds });
    await expect(make(false).requestRefund('TOK', { amountMinor: 1000, currency: 'USD' }, 'refund:pay_1')).rejects.toBeInstanceOf(RefundRequiresManualError);
    expect(dpo.requests).toHaveLength(0);
    const ok = await make(true).requestRefund('TOK', { amountMinor: 1000, currency: 'USD' }, 'refund:pay_1');
    expect(ok.refundReference).toBe('dpo:TOK:refund:pay_1');
    expect(dpo.requests[0]?.fields).toMatchObject({ refundAmount: '10.00', refundRef: 'refund:pay_1' });
    dpo.refund = '<API3G><Result>999</Result><ResultExplanation>Refund failed</ResultExplanation></API3G>';
    await expect(make(true).requestRefund('TOK', { amountMinor: 1000, currency: 'USD' }, 'refund:pay_2')).rejects.toBeInstanceOf(RefundRequiresManualError);
  });

  it('tickets after the traveller returns from DPO, only once DPO itself confirms the payment', async () => {
    const dpo = new FakeDpo();
    const { c } = testContainer({ dpoFetch: dpo.fetch }, DPO_ENV);
    expect(c.cardProvider).toBe('dpo');
    const app = createApp(c);
    const booking = await heldBooking(c);
    const view = await c.payments.initiate(booking, 'card', CONTACT.phone);
    expect(view.checkoutUrl).toMatch(/^https:\/\/secure\.3gdirectpay\.com\/payv2\.php\?ID=TOKEN-/);
    const token = new URL(view.checkoutUrl ?? '').searchParams.get('ID') ?? '';

    // A return (or forged notification) before payment: DPO says not paid, nothing changes.
    const early = await request(app).get(`/api/payments/dpo/return?TransactionToken=${token}`).expect(303);
    expect(early.headers['location']).toBe(`/?payment=pending&ref=${booking.pnr}`);
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('payment_pending');

    dpo.paid(decimal(booking.offer.totalPrice.amountCents));
    const back = await request(app).get(`/api/payments/dpo/return?TransactionToken=${token}&CompanyRef=${booking.pnr}-1`).expect(303);
    expect(back.headers['location']).toBe(`/?payment=success&ref=${booking.pnr}`);
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('ticketed');
    expect(dpo.requests.filter((r) => r.name === 'verifyToken').every((r) => r.fields['TransactionToken'] === token)).toBe(true);

    // A server notification for the same token is harmless (already ticketed).
    await request(app).post('/api/payments/dpo/return').set('content-type', 'application/xml').send(`<API3G><TransactionToken>${token}</TransactionToken></API3G>`).expect(200);
    // Unknown tokens never reach DPO's verify for a booking, and leak nothing.
    const unknown = await request(app).get('/api/payments/dpo/return?TransactionToken=NOT-A-REAL-TOKEN-1').expect(303);
    expect(unknown.headers['location']).toBe('/?payment=pending');
  });

  it('never tickets when DPO reports a different amount or currency', async () => {
    const dpo = new FakeDpo();
    const { c, clock } = testContainer({ dpoFetch: dpo.fetch }, DPO_ENV);
    const booking = await heldBooking(c);
    const view = await c.payments.initiate(booking, 'card', CONTACT.phone);
    const token = new URL(view.checkoutUrl ?? '').searchParams.get('ID') ?? '';
    clock.advanceMinutes(1);
    dpo.paid(decimal(booking.offer.totalPrice.amountCents - 100));
    await request(createApp(c)).get(`/api/payments/dpo/return?TransactionToken=${token}`).expect(303);
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('payment_pending');
    dpo.paid(decimal(booking.offer.totalPrice.amountCents), 'KES');
    expect(await c.reconciliation.pollPending(0)).toMatchObject({ checked: 1, resolved: 0 });
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('payment_pending');
  });

  it('confirms by polling when the traveller never comes back to the site', async () => {
    const dpo = new FakeDpo();
    const { c, clock } = testContainer({ dpoFetch: dpo.fetch }, DPO_ENV);
    const booking = await heldBooking(c);
    await c.payments.initiate(booking, 'card', CONTACT.phone);
    clock.advanceMinutes(1);
    dpo.paid(decimal(booking.offer.totalPrice.amountCents));
    expect(await c.reconciliation.pollPending(0)).toEqual({ checked: 1, resolved: 1 });
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('ticketed');
  });
});

// ------------------------------------------------------------ bank transfer

describe('bank transfer and branch deposits', () => {
  const BANK_ENV = { BANK_NAME: 'KCB Bank South Sudan', BANK_ACCOUNT_NAME: 'BluckFlies Ltd', BANK_ACCOUNT_NUMBER: '1234 5678 90', BANK_BRANCH: 'Juba Main', ADMIN_API_TOKEN: ADMIN };

  async function requested(env: Record<string, string> = BANK_ENV) {
    const { c, clock } = testContainer({}, env);
    const booking = await heldBooking(c);
    const view = await c.payments.initiate(booking, 'bank_transfer', CONTACT.phone);
    const ticket = (await c.repos.tickets.list({ limit: 10 })).find((t) => t.reason === 'bank_transfer');
    return { c, clock, booking, view, ticketId: ticket?.id ?? '', app: createApp(c) };
  }

  it('gives the traveller the account and booking code, and puts the payment on the desk', async () => {
    const { view, booking, ticketId, app } = await requested();
    expect(view.bankTransfer).toEqual({ bankName: 'KCB Bank South Sudan', accountName: 'BluckFlies Ltd', accountNumber: '1234 5678 90', branch: 'Juba Main' });
    expect(view.instructions).toContain(`Reference: ${booking.pnr}`);
    expect(view.instructions).toMatch(/Juba time/);
    expect(ticketId).not.toBe('');
    const detail = (await request(app).get(`/api/admin/tickets/${ticketId}`).set(desk).expect(200)).body;
    expect(detail.payment).toMatchObject({ method: 'bank_transfer', status: 'requested', provider: 'bank_transfer' });
  });

  it('staff confirm the exact amount: tickets are issued, with an audit note', async () => {
    const { c, booking, ticketId, app } = await requested();
    const due = decimal(booking.offer.totalPrice.amountCents);
    const wrong = await request(app).post(`/api/admin/tickets/${ticketId}/manual-payment`).set(desk).send({ received: true, amountUsd: decimal(booking.offer.totalPrice.amountCents - 500), reference: 'FT26308XYZ' }).expect(400);
    expect(wrong.body.error.message).toMatch(/not the amount due/);
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('payment_pending');

    const ok = await request(app).post(`/api/admin/tickets/${ticketId}/manual-payment`).set(desk).send({ received: true, amountUsd: due, reference: 'FT26308XYZ' }).expect(200);
    expect(ok.body).toEqual({ bookingStatus: 'ticketed', paymentStatus: 'succeeded' });
    const detail = (await request(app).get(`/api/admin/tickets/${ticketId}`).set(desk).expect(200)).body;
    expect(detail.ticket.status).toBe('resolved');
    expect(detail.notes.map((n: { author: string; body: string }) => `${n.author}: ${n.body}`).join('\n')).toMatch(/Mary Akol \(admin token\): Bank transfer RECEIVED: USD .* bank reference FT26308XYZ/);
    // Confirming twice is refused, so a payment can never be applied twice.
    await request(app).post(`/api/admin/tickets/${ticketId}/manual-payment`).set(desk).send({ received: true, amountUsd: due, reference: 'FT26308XYZ' }).expect(409);
  });

  it('"not received" frees the booking to be paid another way', async () => {
    const { c, booking, ticketId, app } = await requested();
    await request(app).post(`/api/admin/tickets/${ticketId}/manual-payment`).set(desk).send({ received: false, note: 'Nothing on the statement by 15:00' }).expect(200);
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('held');
  });

  it('a deposit arriving after the seats were released is recorded and refunded, not ticketed', async () => {
    const { c, clock, booking, ticketId, app } = await requested();
    clock.advanceMinutes(24 * 60);
    await c.bookings.sweepLapsedHolds();
    expect((await c.bookings.view(SID, booking.pnr)).status).toBe('expired');
    const due = decimal(booking.offer.totalPrice.amountCents);
    const res = await request(app).post(`/api/admin/tickets/${ticketId}/manual-payment`).set(desk).send({ received: true, amountUsd: due, reference: 'LATE-001' }).expect(200);
    expect(res.body.paymentStatus).toBe('refund_requested');
    const refundTicket = (await c.repos.tickets.list({ limit: 20 })).find((t) => t.reason === 'payment_issue');
    expect(refundTicket?.summary).toMatch(/Refund USD/);
  });

  it('offers a clearly marked demo account in development, and none in production unless configured', async () => {
    const { view } = await requested({ ADMIN_API_TOKEN: ADMIN });
    expect(view.provider).toBe('bank_transfer_demo');
    expect(view.instructions).toMatch(/DEMO ONLY/);
  });
});

// ------------------------------------------------------------ configuration

describe('payment configuration', () => {
  const base = { NODE_ENV: 'development', PAYMENT_WEBHOOK_SECRET: 'p'.repeat(40) };
  const stripe = { STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' };

  it('requires a choice when both card providers are configured, and complete bank details', () => {
    expect(() => loadConfig({ ...base, ...stripe, ...DPO_ENV })).toThrow(/CARD_PROVIDER/);
    expect(() => loadConfig({ ...base, ...stripe, ...DPO_ENV, CARD_PROVIDER: 'dpo' })).not.toThrow();
    expect(() => loadConfig({ ...base, DPO_COMPANY_TOKEN: DPO_ENV.DPO_COMPANY_TOKEN })).toThrow(/DPO_SERVICE_TYPE/);
    expect(() => loadConfig({ ...base, BANK_NAME: 'KCB' })).toThrow(/BANK_ACCOUNT_NAME/);
    expect(() => loadConfig({ ...base, CARD_PROVIDER: 'dpo' })).toThrow(/needs DPO_COMPANY_TOKEN/);
  });

  it('lists only the ways to pay that are switched on', async () => {
    const { c } = testContainer({}, DPO_ENV);
    const res = await request(createApp(c)).get('/api/payment-options').expect(200);
    expect(res.body.cardProvider).toBe('dpo');
    expect(res.body.methods.map((m: { method: string }) => m.method)).toEqual(expect.arrayContaining(['card', 'bank_transfer']));
  });

  it('parses money amounts strictly', () => {
    expect(parseMinorUnits('412.5')).toBe(41250);
    expect(parseMinorUnits('1,000')).toBe(100000);
    for (const bad of ['', '-5', '1.234', 'abc', '1e3', '12.']) expect(parseMinorUnits(bad)).toBeUndefined();
    expect(serviceDate(undefined, new Date('2026-11-06T09:05:00Z'))).toBe('2026/11/06 09:05');
  });
});
