import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process fake of the Duffel API v2 endpoints BluckFlies uses, shaped after
 * https://duffel.com/docs/api. It enforces the auth/version headers and Duffel's
 * "one order per offer" rule, and lets tests inject airline behaviour.
 */

export const FAKE_TOKEN = 'duffel_test_fake123';

interface OfferTemplate {
  owner: { iata_code: string; name: string };
  totalCents: number;
  currency?: string;
  requiresInstantPayment: boolean;
  /** Local times at origin/destination for a single direct segment. */
  departLocal: string;
  arriveLocal: string;
  flightNumber: string;
  refund?: { allowed: boolean; penaltyCents?: number } | null;
}

interface FakeOrder {
  id: string;
  offerId: string;
  type: 'hold' | 'instant';
  totalCents: number;
  paid: boolean;
  cancelled: boolean;
  bookingReference: string;
  tickets: string[];
  passengers: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  paymentRequiredBy: string;
}

interface StoredOffer {
  id: string;
  template: OfferTemplate;
  passengers: Array<{ id: string; type: string; age: number | null }>;
  origin: string;
  destination: string;
  date: string;
  /** Every requested slice (two for a round trip). */
  slices: Array<{ origin: string; destination: string; date: string }>;
  available: boolean;
}

export class FakeDuffel {
  private server: Server | undefined;
  url = '';
  readonly requests: Array<{ method: string; path: string; body: unknown }> = [];
  readonly offers = new Map<string, StoredOffer>();
  readonly orders = new Map<string, FakeOrder>();
  readonly bookedOffers = new Set<string>();
  /** Offers returned for every search (one per template). */
  templates: OfferTemplate[] = [];
  /** Test switches. */
  failNextOrderAfterCreating = false; // creates the order, then answers 504 (lost response)
  orderPriceIncreaseCents = 0; // applied to held orders when re-read before payment
  cancellableOwners = new Set<string>(['KQ']);
  /** Answer round-trip searches with one-slice offers (a supplier quirk the adapter must skip). */
  dropReturnSlice = false;
  /** Airline payment deadline for held orders. */
  paymentRequiredBy = '2026-10-30T10:40:00Z';
  private seq = 0;
  private readonly pendingCancels = new Map<string, { order: FakeOrder; refundCents: number }>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  calls(method: string, prefix: string) {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
  }

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(6, '0')}`;
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private error(res: ServerResponse, status: number, type: string, code: string, message = code) {
    this.send(res, status, { errors: [{ type, code, title: code, message, documentation_url: 'https://duffel.com/docs/api/overview/errors' }], meta: { status, request_id: 'req_fake' } });
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    this.requests.push({ method, path: url.pathname + url.search, body });

    if (req.headers['authorization'] !== `Bearer ${FAKE_TOKEN}`) return this.error(res, 401, 'authentication_error', 'invalid_authorization_header');
    if (req.headers['duffel-version'] !== 'v2') return this.error(res, 400, 'invalid_request_error', 'missing_version_header');

    const p = url.pathname;
    const data = (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
    let m: RegExpExecArray | null;

    if (method === 'POST' && p === '/air/offer_requests') return this.offerRequest(res, data);
    if (method === 'GET' && (m = /^\/air\/offers\/([^/]+)$/.exec(p))) {
      const o = this.offers.get(m[1] ?? '');
      if (!o) return this.error(res, 404, 'invalid_request_error', 'not_found');
      if (!o.available) return this.error(res, 422, 'airline_error', 'offer_no_longer_available');
      return this.send(res, 200, { data: this.offerJson(o) });
    }
    if (method === 'POST' && p === '/air/orders') return this.createOrder(res, data);
    if (method === 'GET' && p === '/air/orders') {
      const list = [...this.orders.values()].reverse().slice(0, Number(url.searchParams.get('limit') ?? 50));
      return this.send(res, 200, { data: list.map((o) => this.orderJson(o)), meta: { limit: 50, after: null, before: null } });
    }
    if (method === 'GET' && (m = /^\/air\/orders\/([^/]+)$/.exec(p))) {
      const o = this.orders.get(m[1] ?? '');
      if (!o) return this.error(res, 404, 'invalid_request_error', 'not_found');
      if (o.type === 'hold' && !o.paid && this.orderPriceIncreaseCents) {
        o.totalCents += this.orderPriceIncreaseCents;
        this.orderPriceIncreaseCents = 0;
      }
      return this.send(res, 200, { data: this.orderJson(o) });
    }
    if (method === 'POST' && p === '/air/payments') return this.pay(res, data);
    if (method === 'POST' && p === '/air/order_cancellations') {
      const o = this.orders.get(String(data['order_id']));
      if (!o) return this.error(res, 404, 'invalid_request_error', 'not_found');
      if (o.cancelled) return this.error(res, 422, 'airline_error', 'already_cancelled');
      const offer = this.offers.get(o.offerId);
      if (!offer || !this.cancellableOwners.has(offer.template.owner.iata_code)) return this.error(res, 422, 'invalid_state_error', 'order_not_cancellable');
      const id = this.id('ore');
      const refundCents = o.paid ? o.totalCents - (offer.template.refund?.penaltyCents ?? 0) : 0;
      this.pendingCancels.set(id, { order: o, refundCents });
      return this.send(res, 201, { data: { id, order_id: o.id, refund_amount: money(refundCents), refund_currency: 'USD', refund_to: 'balance', confirmed_at: null } });
    }
    if (method === 'POST' && (m = /^\/air\/order_cancellations\/([^/]+)\/actions\/confirm$/.exec(p))) {
      const pending = this.pendingCancels.get(m[1] ?? '');
      if (!pending) return this.error(res, 404, 'invalid_request_error', 'not_found');
      pending.order.cancelled = true;
      return this.send(res, 200, { data: { id: m[1], refund_amount: money(pending.refundCents), refund_currency: 'USD', refund_to: 'balance', confirmed_at: new Date().toISOString() } });
    }
    return this.error(res, 404, 'invalid_request_error', 'not_found');
  }

  private offerRequest(res: ServerResponse, data: Record<string, unknown>) {
    const requested = (data['slices'] as Array<Record<string, string>>).map((sl) => ({ origin: sl['origin'] ?? '', destination: sl['destination'] ?? '', date: sl['departure_date'] ?? '' }));
    const slice = requested[0] ?? { origin: '', destination: '', date: '' };
    const pax = data['passengers'] as Array<{ type?: string; age?: number }>;
    const offers = this.templates.map((t) => {
      const o: StoredOffer = {
        id: this.id('off'),
        template: t,
        passengers: pax.map((p) => ({
          id: this.id('pas'),
          type: p.type ?? (p.age !== undefined && p.age < 2 ? 'infant_without_seat' : p.age !== undefined && p.age < 12 ? 'child' : 'adult'),
          age: p.age ?? null,
        })),
        origin: slice.origin,
        destination: slice.destination,
        date: slice.date,
        slices: this.dropReturnSlice ? requested.slice(0, 1) : requested,
        available: true,
      };
      this.offers.set(o.id, o);
      return this.offerJson(o);
    });
    return this.send(res, 201, { data: { id: this.id('orq'), offers } });
  }

  private offerJson(o: StoredOffer) {
    const t = o.template;
    const tz: Record<string, string> = { JUB: 'Africa/Juba', NBO: 'Africa/Nairobi', ADD: 'Africa/Addis_Ababa', CAI: 'Africa/Cairo' };
    return {
      id: o.id,
      total_amount: money(t.totalCents),
      total_currency: t.currency ?? 'USD',
      expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      owner: { ...t.owner, id: `arl_${t.owner.iata_code}` },
      passengers: o.passengers,
      payment_requirements: {
        requires_instant_payment: t.requiresInstantPayment,
        payment_required_by: t.requiresInstantPayment ? null : this.paymentRequiredBy,
        price_guarantee_expires_at: null,
      },
      conditions: {
        refund_before_departure: t.refund === undefined ? null : t.refund && { allowed: t.refund.allowed, penalty_amount: t.refund.penaltyCents === undefined ? null : money(t.refund.penaltyCents), penalty_currency: 'USD' },
        change_before_departure: null,
      },
      // One slice per requested direction; the return flight number is the outbound's + 1.
      slices: o.slices.map((sl, n) => ({
          segments: [
            {
              departing_at: `${sl.date}T${t.departLocal}:00`,
              arriving_at: `${sl.date}T${t.arriveLocal}:00`,
              origin: { iata_code: sl.origin, time_zone: tz[sl.origin] ?? 'UTC' },
              destination: { iata_code: sl.destination, time_zone: tz[sl.destination] ?? 'UTC' },
              marketing_carrier: t.owner,
              marketing_carrier_flight_number: String(Number(t.flightNumber) + n),
              operating_carrier: t.owner,
              aircraft: { name: 'Boeing 737-800', iata_code: '738' },
              duration: 'PT2H',
              passengers: o.passengers.map((p) => ({
                passenger_id: p.id,
                baggages: [
                  { type: 'checked', quantity: 2 },
                  { type: 'carry_on', quantity: 1 },
                ],
              })),
            },
          ],
      })),
    };
  }

  private createOrder(res: ServerResponse, data: Record<string, unknown>) {
    const offerId = (data['selected_offers'] as string[])[0] ?? '';
    const offer = this.offers.get(offerId);
    if (!offer) return this.error(res, 422, 'invalid_state_error', 'offer_expired');
    if (this.bookedOffers.has(offerId)) return this.error(res, 422, 'invalid_state_error', 'order_creation_already_attempted');
    if (!offer.available) return this.error(res, 422, 'airline_error', 'offer_no_longer_available');
    const passengers = data['passengers'] as Array<Record<string, unknown>>;
    const ids = new Set(offer.passengers.map((p) => p.id));
    if (passengers.length !== offer.passengers.length || passengers.some((p) => !ids.has(String(p['id'])))) {
      return this.error(res, 422, 'airline_error', 'order_passengers_incompatible_with_offer');
    }
    const type = data['type'] as 'hold' | 'instant';
    if (type === 'hold' && offer.template.requiresInstantPayment) return this.error(res, 422, 'validation_error', 'unsupported_action');
    if (type === 'instant') {
      const pay = (data['payments'] as Array<{ amount: string; currency: string }>)[0];
      if (!pay || pay.amount !== money(offer.template.totalCents)) return this.error(res, 422, 'invalid_state_error', 'payment_amount_does_not_match_order_amount');
    }
    this.bookedOffers.add(offerId);
    const order: FakeOrder = {
      id: this.id('ord'),
      offerId,
      type,
      totalCents: offer.template.totalCents,
      paid: type === 'instant',
      cancelled: false,
      bookingReference: `R${this.seq}XY`,
      tickets: [],
      passengers,
      metadata: (data['metadata'] as Record<string, unknown>) ?? {},
      paymentRequiredBy: this.paymentRequiredBy,
    };
    if (order.paid) order.tickets = passengers.map((_, i) => `07112345678${String(this.seq).padStart(2, '0')}${i}`);
    this.orders.set(order.id, order);
    if (this.failNextOrderAfterCreating) {
      this.failNextOrderAfterCreating = false;
      return this.error(res, 504, 'airline_error', 'airline_internal', 'Airline timed out');
    }
    return this.send(res, 201, { data: this.orderJson(order) });
  }

  private pay(res: ServerResponse, data: Record<string, unknown>) {
    const o = this.orders.get(String(data['order_id']));
    if (!o) return this.error(res, 404, 'invalid_request_error', 'not_found');
    const p = data['payment'] as { amount: string; currency: string; type: string };
    if (p.type !== 'balance') return this.error(res, 422, 'validation_error', 'bad_request');
    if (p.amount !== money(o.totalCents)) return this.error(res, 422, 'airline_error', 'price_changed');
    o.paid = true;
    o.tickets = o.passengers.map((_, i) => `07198765432${String(this.seq).padStart(2, '0')}${i}`);
    return this.send(res, 201, { data: { id: this.id('pay'), amount: p.amount, currency: p.currency, type: 'balance' } });
  }

  private orderJson(o: FakeOrder) {
    return {
      id: o.id,
      booking_reference: o.bookingReference,
      total_amount: money(o.totalCents),
      total_currency: 'USD',
      cancelled_at: o.cancelled ? new Date().toISOString() : null,
      documents: o.tickets.map((t) => ({ type: 'electronic_ticket', unique_identifier: t })),
      payment_status: { awaiting_payment: !o.paid && !o.cancelled, payment_required_by: o.paymentRequiredBy, price_guarantee_expires_at: null },
      metadata: o.metadata,
      passengers: o.passengers,
    };
  }
}

function money(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
