import { AppError } from '../../../domain/errors.js';
import {
  passengerCount,
  type FlightOffer,
  type FlightSearchCriteria,
  type FlightSegment,
  type IataCode,
  type Passenger,
  type PassengerMix,
} from '../../../domain/types.js';
import type { Logger } from '../../../lib/logger.js';
import { toZonedIso, zonedToUtc } from '../../../lib/time.js';
import {
  CancellationNotSupportedError,
  PermanentTicketingError,
  type BookingContext,
  type CancelResult,
  type FlightProvider,
  type FlightStatus,
  type HoldResult,
  type IssuedTickets,
} from '../FlightProvider.js';
import { DuffelApiError, type DuffelClient } from './DuffelClient.js';
import {
  DuffelOffer,
  OfferRequestResponse,
  OfferResponse,
  OrderCancellationResponse,
  OrderListResponse,
  OrderResponse,
  PaymentResponse,
  type DuffelOrder,
} from './schemas.js';

/** Reference stored on bookings whose airline order is created only after the traveller pays. */
const DEFERRED_PREFIX = 'duffel-deferred:';
/** Sent to Duffel as `supplier_timeout`; must stay below the HTTP timeout. */
const SUPPLIER_TIMEOUT_MS = 15_000;
/** How many recent orders to scan when recovering an order after an unclear failure. */
const RECOVERY_SCAN_LIMIT = 50;
const METADATA_KEY = 'bluckflies_booking_id';

/** Duffel error codes meaning the fare can never be booked as sold; the traveller must be refunded. */
const UNFULFILLABLE = new Set([
  'offer_no_longer_available',
  'offer_expired',
  'price_changed',
  'schedule_changed',
  'order_passengers_incompatible_with_offer',
  'duplicate_passenger_names',
  'invalid_passenger_name',
  'invalid_passenger_title',
  'invalid_email_address',
  'invalid_phone_number',
  'payment_amount_does_not_match_order_amount',
  'payment_currency_does_not_match_order_currency',
]);
/** Duffel refuses to book an offer twice; the earlier attempt's order must be found instead. */
const ALREADY_ATTEMPTED = new Set(['order_creation_already_attempted', 'offer_request_already_booked', 'duplicate_booking']);

/** "123.45" → 12345. Rejects anything that is not a plain decimal with at most 2 places. */
export function toCents(amount: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Unparseable amount "${amount}"`);
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
export const fromCents = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

/** Duffel times are local to the airport; convert to ISO with that airport's offset. */
function localToIso(local: string, timeZone: string | null | undefined): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(local);
  if (!m || !m[1] || !m[2]) throw new Error(`Unparseable time "${local}"`);
  const tz = timeZone || 'UTC';
  return toZonedIso(zonedToUtc(m[1], m[2], tz), tz);
}

function ageOn(dateOfBirth: string, onDate: string): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  const on = new Date(`${onDate}T00:00:00Z`);
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  if (on.getUTCMonth() < dob.getUTCMonth() || (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export interface DuffelProviderOptions {
  log: Logger;
  /** Optional allowlist of airline IATA codes to sell (e.g. carriers serving Juba). */
  airlines?: readonly string[];
}

export class DuffelFlightProvider implements FlightProvider {
  readonly name = 'duffel';
  readonly isSandbox = false;

  constructor(
    private readonly client: DuffelClient,
    private readonly opts: DuffelProviderOptions,
  ) {}

  // ------------------------------------------------------------------ search

  async search(criteria: FlightSearchCriteria, offerExpiresAt: Date): Promise<FlightOffer[]> {
    const mix = criteria.passengers;
    const body = {
      data: {
        // A round trip is one offer request with two slices: the airline prices both directions together.
        slices: [
          { origin: criteria.origin, destination: criteria.destination, departure_date: criteria.departureDate },
          ...(criteria.returnDate ? [{ origin: criteria.destination, destination: criteria.origin, departure_date: criteria.returnDate }] : []),
        ],
        passengers: [
          ...Array.from({ length: mix.adults }, () => ({ type: 'adult' })),
          ...mix.childAges.map((age) => ({ age })),
          // Infants are sent by age; Duffel prices them as lap infants.
          ...Array.from({ length: mix.infants }, () => ({ age: 1 })),
        ],
        cabin_class: criteria.cabin,
        max_connections: criteria.maxStops,
      },
    };
    let res;
    try {
      res = await this.client.request('POST', `/air/offer_requests?return_offers=true&supplier_timeout=${SUPPLIER_TIMEOUT_MS}`, OfferRequestResponse, {
        body,
        idempotent: true, // creating an offer request has no side effects
      });
    } catch (err) {
      throw this.asUpstream(err, 'Flight search');
    }

    const offers: FlightOffer[] = [];
    let skipped = 0;
    for (const raw of res.data.offers) {
      const parsed = DuffelOffer.safeParse(raw);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const mapped = parsed.data.slices.length === (criteria.returnDate ? 2 : 1) ? this.toOffer(parsed.data, criteria.cabin, mix, offerExpiresAt) : null;
      if (mapped) offers.push(mapped);
      else skipped++;
    }
    if (skipped) this.opts.log.info('duffel.offers_skipped', { skipped, kept: offers.length });
    return offers;
  }

  async revalidate(offer: FlightOffer): Promise<FlightOffer | null> {
    const supplier = this.supplierOf(offer);
    try {
      const res = await this.client.request('GET', `/air/offers/${encodeURIComponent(supplier.offerId)}`, OfferResponse, { idempotent: true });
      const fresh = this.toOffer(res.data, offer.cabin, offer.passengerMix, new Date(offer.expiresAt));
      return fresh ? { ...fresh, id: offer.id } : null;
    } catch (err) {
      if (err instanceof DuffelApiError && (err.status === 404 || err.code === 'offer_no_longer_available' || err.code === 'offer_expired')) return null;
      throw this.asUpstream(err, 'Fare check');
    }
  }

  // -------------------------------------------------------------------- hold

  async hold(ctx: Omit<BookingContext, 'supplierReference'>): Promise<HoldResult> {
    const supplier = this.supplierOf(ctx.offer);
    if (supplier.requiresInstantPayment) {
      // The airline sells this fare only with immediate payment: no airline order
      // until the traveller has paid us. The fare must still be valid then.
      return { supplierReference: `${DEFERRED_PREFIX}${supplier.offerId}`, payBy: ctx.offer.expiresAt };
    }
    try {
      const order = await this.createOrder('hold', { ...ctx, supplierReference: '' });
      return {
        supplierReference: order.id,
        ...(order.payment_status?.payment_required_by ? { payBy: order.payment_status.payment_required_by } : {}),
      };
    } catch (err) {
      if (err instanceof DuffelApiError && UNFULFILLABLE.has(err.code)) {
        throw new AppError('CONFLICT', 'The airline could not hold these seats at this fare. Please search again.');
      }
      throw this.asUpstream(err, 'Seat hold');
    }
  }

  // --------------------------------------------------------------- ticketing

  async issueTickets(ctx: BookingContext): Promise<IssuedTickets> {
    return this.isDeferred(ctx.supplierReference) ? this.createAndPayOrder(ctx) : this.payHeldOrder(ctx);
  }

  async findIssuedTickets(ctx: BookingContext): Promise<IssuedTickets | null> {
    const order = this.isDeferred(ctx.supplierReference) ? await this.findOrderByBooking(ctx.bookingId) : await this.getOrder(ctx.supplierReference);
    return order ? this.ticketsOf(order) : null;
  }

  /** Pay-now fare: create the order with payment in one call. */
  private async createAndPayOrder(ctx: BookingContext): Promise<IssuedTickets> {
    try {
      const order = await this.createOrder('instant', ctx);
      const issued = this.ticketsOf(order);
      if (!issued) throw new Error(`Duffel order ${order.id} created without e-tickets yet`); // picked up by findIssuedTickets on retry
      return issued;
    } catch (err) {
      if (!(err instanceof DuffelApiError)) throw err;
      if (UNFULFILLABLE.has(err.code)) throw new PermanentTicketingError(err.code, err.message);
      if (ALREADY_ATTEMPTED.has(err.code)) {
        // An earlier attempt (whose response we lost) may have created the order.
        const existing = await this.findOrderByBooking(ctx.bookingId);
        const issued = existing ? this.ticketsOf(existing) : null;
        if (issued) return issued;
        throw new Error(`Duffel reports an earlier booking attempt (${err.code}) but no matching ticketed order was found; needs a person`);
      }
      if (err.code === 'insufficient_balance') this.opts.log.error('duffel.insufficient_balance', { bookingId: ctx.bookingId });
      // Unknown outcome or temporary: never re-create blindly; the next attempt starts with findIssuedTickets.
      throw err;
    }
  }

  /** Held fare: re-read the order for the current price, then pay from balance. */
  private async payHeldOrder(ctx: BookingContext): Promise<IssuedTickets> {
    const order = await this.getOrder(ctx.supplierReference);
    if (!order) throw new PermanentTicketingError('order_not_found', 'The held airline order no longer exists');
    const already = this.ticketsOf(order);
    if (already) return already;
    if (order.cancelled_at || order.payment_status?.awaiting_payment === false) {
      throw new PermanentTicketingError('hold_lapsed', 'The airline released the held seats');
    }
    if (order.total_currency !== 'USD') throw new PermanentTicketingError('currency_mismatch', `Order is priced in ${order.total_currency}`);
    const current = toCents(order.total_amount);
    if (current > ctx.offer.totalPrice.amountCents) {
      // Never pay the airline more than the traveller paid us.
      throw new PermanentTicketingError('price_changed', `Fare rose from ${ctx.offer.totalPrice.amountCents} to ${current} cents`);
    }
    try {
      await this.client.request('POST', '/air/payments', PaymentResponse, {
        body: { data: { order_id: order.id, payment: { type: 'balance', amount: order.total_amount, currency: order.total_currency } } },
        idempotent: false,
      });
    } catch (err) {
      if (err instanceof DuffelApiError && UNFULFILLABLE.has(err.code)) throw new PermanentTicketingError(err.code, err.message);
      throw err; // unknown outcome: the retry re-reads the order before paying again
    }
    const paid = await this.getOrder(order.id);
    const issued = paid ? this.ticketsOf(paid) : null;
    if (!issued) throw new Error(`Duffel order ${order.id} paid but e-tickets not yet issued`);
    return issued;
  }

  // ------------------------------------------------------------ cancellation

  async cancel(ctx: BookingContext): Promise<CancelResult> {
    if (this.isDeferred(ctx.supplierReference)) return {}; // no airline order exists
    let quote;
    try {
      quote = await this.client.request('POST', '/air/order_cancellations', OrderCancellationResponse, {
        body: { data: { order_id: ctx.supplierReference } },
        idempotent: false, // a quote only; safe to repeat manually, but not retried automatically
      });
    } catch (err) {
      if (err instanceof DuffelApiError && err.code === 'already_cancelled') return {};
      if (err instanceof DuffelApiError && ['order_not_cancellable', 'unsupported_action', 'modified_externally'].includes(err.code)) {
        throw new CancellationNotSupportedError();
      }
      throw this.asUpstream(err, 'Airline cancellation');
    }
    const confirmed = await this.client.request('POST', `/air/order_cancellations/${encodeURIComponent(quote.data.id)}/actions/confirm`, OrderCancellationResponse, {
      idempotent: false,
    });
    const c = confirmed.data;
    return c.refund_amount && c.refund_currency === 'USD' ? { supplierRefund: { amountCents: toCents(c.refund_amount), currency: 'USD' } } : {};
  }

  async getFlightStatus(carrierCode: string, flightNumber: string, date: string): Promise<FlightStatus> {
    return {
      carrierCode,
      flightNumber,
      date,
      status: 'unknown',
      remarks: 'Live flight status is not available from our booking supplier. Please check with the airline before going to the airport.',
    };
  }

  // ----------------------------------------------------------------- helpers

  private isDeferred(ref: string): boolean {
    return ref.startsWith(DEFERRED_PREFIX);
  }

  private supplierOf(offer: FlightOffer) {
    if (offer.provider !== this.name || !offer.supplier) throw new Error(`Offer ${offer.id} was not sold by Duffel`);
    return offer.supplier;
  }

  private async getOrder(orderId: string): Promise<DuffelOrder | null> {
    try {
      return (await this.client.request('GET', `/air/orders/${encodeURIComponent(orderId)}`, OrderResponse, { idempotent: true })).data;
    } catch (err) {
      if (err instanceof DuffelApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Finds the order an earlier attempt created, by the booking ID we put in its metadata. */
  private async findOrderByBooking(bookingId: string): Promise<DuffelOrder | null> {
    const res = await this.client.request('GET', `/air/orders?limit=${RECOVERY_SCAN_LIMIT}`, OrderListResponse, { idempotent: true });
    return res.data.find((o) => o.metadata?.[METADATA_KEY] === bookingId) ?? null;
  }

  private ticketsOf(order: DuffelOrder): IssuedTickets | null {
    const tickets = (order.documents ?? []).filter((d) => d.type === 'electronic_ticket').map((d) => d.unique_identifier);
    if (tickets.length === 0) return null;
    return { supplierReference: order.id, ticketNumbers: tickets, ...(order.booking_reference ? { airlineReference: order.booking_reference } : {}) };
  }

  private async createOrder(type: 'hold' | 'instant', ctx: BookingContext): Promise<DuffelOrder> {
    const supplier = this.supplierOf(ctx.offer);
    const passengers = this.orderPassengers(ctx, supplier.passengerIds);
    const body = {
      data: {
        type,
        selected_offers: [supplier.offerId],
        passengers,
        metadata: { [METADATA_KEY]: ctx.bookingId },
        ...(type === 'instant'
          ? { payments: [{ type: 'balance', amount: fromCents(ctx.offer.totalPrice.amountCents), currency: ctx.offer.totalPrice.currency }] }
          : {}),
      },
    };
    const res = await this.client.request('POST', '/air/orders', OrderResponse, { body, idempotent: false, timeoutMs: 80_000 });
    return res.data;
  }

  /**
   * Maps our passengers onto the supplier passenger IDs from the offer, which
   * are ordered adults, children (in `childAges` order), infants. Each infant
   * is attached to a different adult, as airlines require.
   */
  private orderPassengers(ctx: BookingContext, ids: readonly string[]) {
    const mix = ctx.offer.passengerMix;
    const travelDate = ctx.offer.segments[0]?.departureTime.slice(0, 10) ?? '';
    const adults = ctx.passengers.filter((p) => p.type === 'adult');
    const infants = ctx.passengers.filter((p) => p.type === 'infant');
    const children = ctx.passengers.filter((p) => p.type === 'child');

    const childIds = mix.childAges.map((age, i) => ({ age, id: ids[mix.adults + i] }));
    const infantIds = ids.slice(mix.adults + mix.childAges.length);
    const out: Array<Record<string, unknown>> = [];

    const base = (p: Passenger, id: string | undefined) => {
      if (!id) throw new PermanentTicketingError('order_passengers_incompatible_with_offer', 'Passengers do not match the priced offer');
      return {
        id,
        given_name: p.givenName,
        family_name: p.familyName,
        born_on: p.dateOfBirth,
        gender: p.gender,
        title: p.type === 'adult' ? (p.gender === 'm' ? 'mr' : 'ms') : p.gender === 'm' ? 'mr' : 'miss',
        email: ctx.contact.email,
        phone_number: ctx.contact.phone,
        ...(p.passportNumber && p.passportExpiry
          ? {
              identity_documents: [
                // Assumes the passport was issued by the passenger's country of nationality.
                { type: 'passport', unique_identifier: p.passportNumber, issuing_country_code: p.nationality, expires_on: p.passportExpiry },
              ],
            }
          : {}),
      };
    };

    adults.forEach((p, i) => {
      out.push({ ...base(p, ids[i]), ...(infantIds[i] ? { infant_passenger_id: infantIds[i] } : {}) });
    });
    const unusedChildIds = [...childIds];
    for (const p of children) {
      const age = ageOn(p.dateOfBirth, travelDate);
      const idx = unusedChildIds.findIndex((c) => c.age === age);
      const slot = idx >= 0 ? unusedChildIds.splice(idx, 1)[0] : undefined;
      out.push(base(p, slot?.id));
    }
    infants.forEach((p, i) => out.push(base(p, infantIds[i])));
    return out;
  }

  /** Maps a Duffel offer to ours, or null if it can't be sold as priced (currency, passengers). */
  private toOffer(o: DuffelOffer, cabin: FlightOffer['cabin'], mix: PassengerMix, ourExpiry: Date): FlightOffer | null {
    if (o.total_currency !== 'USD') return null; // the Duffel account must be configured for USD
    if (this.opts.airlines?.length && !this.opts.airlines.includes(o.owner.iata_code ?? '')) return null;

    // Supplier passenger IDs in our canonical order: adults, children (by requested age), infants.
    const adults = o.passengers.filter((p) => p.type === 'adult' || (p.age ?? 99) >= 12);
    const infants = o.passengers.filter((p) => !adults.includes(p) && (p.type?.startsWith('infant') || (p.age ?? 99) < 2));
    const children = o.passengers.filter((p) => !adults.includes(p) && !infants.includes(p));
    if (adults.length !== mix.adults || infants.length !== mix.infants || children.length !== mix.childAges.length) return null;
    const pool = [...children];
    const orderedChildren = mix.childAges.map((age) => {
      const idx = pool.findIndex((c) => c.age === age);
      return idx >= 0 ? pool.splice(idx, 1)[0] : pool.shift();
    });
    if (orderedChildren.some((c) => !c)) return null;
    const passengerIds = [...adults, ...orderedChildren, ...infants].map((p) => p?.id ?? '');

    // One slice (one-way) or two (outbound and return); anything else is not a fare we sell.
    if (o.slices.length > 2) return null;
    let slices: FlightSegment[][];
    try {
      slices = o.slices.map((sl) =>
        sl.segments.map((s) => {
          const departureTime = localToIso(s.departing_at, s.origin.time_zone);
          const arrivalTime = localToIso(s.arriving_at, s.destination.time_zone);
          return {
            carrierCode: s.marketing_carrier.iata_code ?? '',
            carrierName: s.marketing_carrier.name,
            flightNumber: `${s.marketing_carrier.iata_code ?? ''}${s.marketing_carrier_flight_number}`,
            origin: s.origin.iata_code as IataCode,
            destination: s.destination.iata_code as IataCode,
            departureTime,
            arrivalTime,
            durationMinutes: Math.round((Date.parse(arrivalTime) - Date.parse(departureTime)) / 60_000),
            aircraft: s.aircraft?.name ?? (s.operating_carrier && s.operating_carrier.name !== s.marketing_carrier.name ? `Operated by ${s.operating_carrier.name}` : ''),
          };
        }),
      );
    } catch {
      return null;
    }
    const [segments, returnSegments] = slices;
    if (!segments) return null;

    const bags = o.slices[0]?.segments[0]?.passengers?.[0]?.baggages ?? [];
    const pieces = (t: string) => bags.filter((b) => b.type === t).reduce((n, b) => n + b.quantity, 0);
    const usdPenalty = (c: { allowed: boolean; penalty_amount?: string | null | undefined; penalty_currency?: string | null | undefined } | null | undefined) => {
      if (!c?.allowed) return null;
      if (!c.penalty_amount) return 0;
      return c.penalty_currency === 'USD' ? toCents(c.penalty_amount) : null; // unknown in USD: treat as not allowed
    };
    const refundPenalty = usdPenalty(o.conditions?.refund_before_departure);
    const changePenalty = usdPenalty(o.conditions?.change_before_departure);
    const expiresAt = new Date(Math.min(Date.parse(o.expires_at), ourExpiry.getTime())).toISOString();

    let total: number;
    try {
      total = toCents(o.total_amount);
    } catch {
      return null;
    }
    return {
      id: `off_${o.id}`,
      provider: this.name,
      segments,
      ...(returnSegments ? { returnSegments } : {}),
      cabin,
      passengers: passengerCount(mix),
      passengerMix: { adults: mix.adults, childAges: [...mix.childAges], infants: mix.infants },
      totalPrice: { amountCents: total, currency: 'USD' },
      baggage: { cabinPieces: pieces('carry_on'), checkedPieces: pieces('checked') },
      fareRules: {
        refundable: refundPenalty !== null,
        refundPenaltyCents: refundPenalty ?? 0,
        changeable: changePenalty !== null,
        changePenaltyCents: changePenalty ?? 0,
      },
      expiresAt,
      supplier: {
        offerId: o.id,
        passengerIds,
        requiresInstantPayment: o.payment_requirements.requires_instant_payment,
        ownerName: o.owner.name,
      },
    };
  }

  private asUpstream(err: unknown, label: string): Error {
    if (err instanceof AppError) return err;
    if (err instanceof DuffelApiError) {
      this.opts.log.warn('duffel.error', { label, status: err.status, code: err.code, requestId: err.requestId });
      if (err.status === 429) return new AppError('RATE_LIMITED', 'The flight supplier is busy. Please try again in a moment.');
      if (err.status === 401 || err.status === 403) {
        this.opts.log.error('duffel.auth_failed', { code: err.code });
      }
    }
    return new AppError('UPSTREAM_UNAVAILABLE', `${label} with the airline failed. Please try again shortly.`);
  }
}
