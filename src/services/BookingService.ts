import { findAirportByCode } from '../data/airports.js';
import { AppError } from '../domain/errors.js';
import { allSegments, type Booking, type ContactDetails, type FlightOffer, type FlightSegment, type Passenger } from '../domain/types.js';
import { addMinutes, isPast, type Clock } from '../lib/clock.js';
import { newId, newPnr } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { formatUsd } from '../lib/money.js';
import { withTimeout } from '../lib/withTimeout.js';
import { CancellationNotSupportedError, type BookingContext, type FlightProvider } from '../providers/flights/FlightProvider.js';
import { DuplicateKeyError, type BookingRepository, type SessionRepository } from '../repositories/types.js';
import type { BookingEvents } from './notifications/NotificationService.js';
import type { FlightSearchService } from './FlightSearchService.js';
import type { PaymentService } from './PaymentService.js';

const SUPPLIER_TIMEOUT_MS = 20_000;

/** Traveller-facing projection: no supplier internals, passport numbers masked. */
export interface BookingView {
  bookingId: string;
  pnr: string;
  status: Booking['status'];
  /** "JUB → NBO", or "JUB ⇄ NBO" for a round trip. */
  route: string;
  segments: Array<{ flight: string; carrier: string; from: string; to: string; departs: string; arrives: string }>;
  /** Round trip: the flights back (same booking code and tickets). */
  returnSegments?: Array<{ flight: string; carrier: string; from: string; to: string; departs: string; arrives: string }>;
  passengers: Array<{ name: string; type: Passenger['type']; passport?: string }>;
  total: string;
  holdExpiresAt?: string;
  ticketNumbers: readonly string[];
  refundable: boolean;
  /** Signed link to the printable e-ticket (PDF), once ticketed. */
  eticketUrl?: string;
}

function ageOn(dateOfBirth: string, onDate: string): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  const on = new Date(`${onDate}T00:00:00Z`);
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    on.getUTCMonth() < dob.getUTCMonth() || (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Airlines accept names in Latin letters only (spaces, hyphens and apostrophes allowed). */
const LATIN_NAME = /^[A-Za-z]+(?:[ '-][A-Za-z]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const contextOf = (b: Booking): BookingContext => ({
  bookingId: b.id,
  supplierReference: b.supplierReference,
  offer: b.offer,
  passengers: b.passengers,
  contact: b.contact,
});

export const isInternational = (offer: FlightOffer): boolean =>
  allSegments(offer).some((s) => !findAirportByCode(s.origin)?.isDomestic || !findAirportByCode(s.destination)?.isDomestic);

const viewSegment = (s: FlightSegment) => ({ flight: s.flightNumber, carrier: s.carrierName, from: s.origin, to: s.destination, departs: s.departureTime, arrives: s.arrivalTime });

export class BookingService {
  constructor(
    private readonly provider: FlightProvider,
    private readonly bookings: BookingRepository,
    private readonly search: FlightSearchService,
    private readonly payments: PaymentService,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: { holdTtlMinutes: number },
    private readonly sessions?: SessionRepository,
    private readonly events?: BookingEvents,
    /** Signed e-ticket link maker (ETicketService.link). */
    private readonly eticketLink?: (bookingId: string) => string,
  ) {}

  /** The account a session is logged into, if any. */
  private async travellerOf(sessionId: string): Promise<string | undefined> {
    return (await this.sessions?.findById(sessionId))?.travellerId;
  }

  /**
   * Validates a reservation draft without side effects. Used before asking the
   * traveller to confirm, so they only confirm something that can succeed.
   */
  async validateDraft(sessionId: string, offerId: string, passengers: Passenger[], contact: ContactDetails): Promise<FlightOffer> {
    const offer = await this.search.getOffer(sessionId, offerId);
    if (isPast(offer.expiresAt, this.clock)) throw new AppError('OFFER_EXPIRED', 'This fare has expired. Please search again for current prices.');
    if (passengers.length !== offer.passengers) {
      throw new AppError('VALIDATION_FAILED', `This offer is priced for ${offer.passengers} passenger(s), but ${passengers.length} were provided.`);
    }
    if (!/^\+[1-9]\d{7,14}$/.test(contact.phone)) throw new AppError('VALIDATION_FAILED', 'Contact phone must be in international format, e.g. +211912345678.');
    if (!EMAIL.test(contact.email)) throw new AppError('VALIDATION_FAILED', 'A valid contact email is required: e-tickets and airline notices are sent there.');

    // Traveller type (adult/child/infant) is set by age on the first flight; the passport must last
    // six months past the last flight, which for a round trip is the return.
    const travelDate = offer.segments[0]?.departureTime.slice(0, 10) ?? '';
    const lastTravelDate = allSegments(offer).at(-1)?.departureTime.slice(0, 10) ?? travelDate;
    const international = isInternational(offer);
    const adults = passengers.filter((p) => p.type === 'adult').length;
    const infants = passengers.filter((p) => p.type === 'infant').length;
    if (adults === 0) throw new AppError('VALIDATION_FAILED', 'At least one adult must travel on every booking.');
    if (infants > adults) throw new AppError('VALIDATION_FAILED', 'Each infant must travel with a separate adult.');

    const childAges: number[] = [];
    passengers.forEach((p, i) => {
      const label = `Passenger ${i + 1} (${p.givenName} ${p.familyName})`;
      if (!LATIN_NAME.test(p.givenName) || !LATIN_NAME.test(p.familyName)) {
        throw new AppError('VALIDATION_FAILED', `${label}: names must use Latin letters exactly as printed on the passport or ID.`);
      }
      const age = ageOn(p.dateOfBirth, travelDate);
      if (age < 0 || age > 120) throw new AppError('VALIDATION_FAILED', `${label}: date of birth looks incorrect.`);
      const expectedType = age < 2 ? 'infant' : age < 12 ? 'child' : 'adult';
      if (p.type !== expectedType) {
        throw new AppError('VALIDATION_FAILED', `${label} will be ${age} on the travel date and must be booked as "${expectedType}".`);
      }
      if (p.type === 'child') childAges.push(age);
      if (international) {
        if (!p.passportNumber || !p.passportExpiry) throw new AppError('VALIDATION_FAILED', `${label}: passport number and expiry are required for international travel.`);
        const sixMonthsAfter = new Date(`${lastTravelDate}T00:00:00Z`);
        sixMonthsAfter.setUTCMonth(sixMonthsAfter.getUTCMonth() + 6);
        if (p.passportExpiry < sixMonthsAfter.toISOString().slice(0, 10)) {
          throw new AppError('VALIDATION_FAILED', `${label}: passport expires within 6 months of ${offer.returnSegments?.length ? 'the return flight' : 'travel'}. Many countries will refuse boarding or entry.`);
        }
      }
    });

    // The fare was priced for a specific mix of travellers; the booking must match it.
    const mix = offer.passengerMix;
    const sorted = (a: readonly number[]) => [...a].sort((x, y) => x - y).join(',');
    if (adults !== mix.adults || infants !== mix.infants || sorted(childAges) !== sorted(mix.childAges)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This fare was priced for ${mix.adults} adult(s), children aged [${mix.childAges.join(', ')}] and ${mix.infants} infant(s), which doesn't match these travellers. Please search again with the right ages.`,
      );
    }
    return offer;
  }

  /** Creates a seat hold. Only reachable through a traveller-approved confirmation. */
  async createReservation(sessionId: string, offerId: string, passengers: Passenger[], contact: ContactDetails): Promise<BookingView> {
    const offer = await this.validateDraft(sessionId, offerId, passengers, contact);
    const current = await withTimeout('Fare check', SUPPLIER_TIMEOUT_MS, () => this.provider.revalidate(offer));
    if (!current) throw new AppError('CONFLICT', 'These seats are no longer available. Please search again.');
    if (current.totalPrice.amountCents !== offer.totalPrice.amountCents) {
      throw new AppError('CONFLICT', `The fare changed from ${formatUsd(offer.totalPrice)} to ${formatUsd(current.totalPrice)}. Please review the new price.`);
    }

    const bookingId = newId('bkg');
    const travellerId = await this.travellerOf(sessionId);
    const hold = await withTimeout('Seat hold', SUPPLIER_TIMEOUT_MS, () => this.provider.hold({ bookingId, offer: current, passengers, contact }));
    const { supplierReference } = hold;
    const now = this.clock.now();
    // A hold never outlives the departure, our policy, or the airline's payment deadline.
    const firstDeparture = new Date(current.segments[0]?.departureTime ?? now.toISOString());
    const deadlines = [addMinutes(now, this.opts.holdTtlMinutes).getTime(), addMinutes(firstDeparture, -120).getTime()];
    if (hold.payBy) deadlines.push(Date.parse(hold.payBy));
    const holdExpires = new Date(Math.min(...deadlines));

    let booking: Booking = {
      id: bookingId,
      pnr: newPnr(),
      ownerSessionId: sessionId,
      ...(travellerId ? { travellerId } : {}),
      offer: current,
      passengers,
      contact,
      status: 'held',
      holdExpiresAt: holdExpires.toISOString(),
      ticketNumbers: [],
      supplierReference,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    try {
      // A PNR collision (1 in ~10^9 per pair) gets a fresh PNR, a few times.
      for (let attempt = 1; ; attempt++) {
        try {
          await this.bookings.insert(booking);
          break;
        } catch (err) {
          if (!(err instanceof DuplicateKeyError) || err.field !== 'pnr' || attempt >= 5) throw err;
          booking = { ...booking, pnr: newPnr() };
        }
      }
    } catch (err) {
      // Do not leave an orphaned seat hold at the supplier.
      await this.provider.cancel(contextOf(booking)).catch(() => undefined);
      throw err;
    }
    this.log.info('booking.held', { bookingId: booking.id, pnr: booking.pnr });
    // Queues the "seats held, pay before …" message; never fails the booking.
    await this.events?.onBooking('held', booking).catch((err: unknown) => this.log.error('booking.event_failed', { kind: 'held', bookingId: booking.id, err: String(err) }));
    return this.toView(booking);
  }

  async getOwned(sessionId: string, reference: string): Promise<Booking> {
    const ref = reference.trim();
    const booking = ref.startsWith('bkg_') ? await this.bookings.findById(ref) : await this.bookings.findByPnr(ref);
    // Same error for "missing" and "not yours" so references cannot be probed.
    if (!booking || !(await this.owns(sessionId, booking))) throw new AppError('NOT_FOUND', `No booking found with reference ${reference}.`);
    return this.expireIfLapsed(booking);
  }

  /** The session that made the booking, or any session logged into the same account. */
  private async owns(sessionId: string, booking: Booking): Promise<boolean> {
    if (booking.ownerSessionId === sessionId) return true;
    if (!booking.travellerId) return false;
    return (await this.travellerOf(sessionId)) === booking.travellerId;
  }

  async view(sessionId: string, reference: string): Promise<BookingView> {
    return this.toView(await this.getOwned(sessionId, reference));
  }

  async list(sessionId: string): Promise<BookingView[]> {
    const travellerId = await this.travellerOf(sessionId);
    const own = await this.bookings.listBySession(sessionId);
    const account = travellerId ? await this.bookings.listByTraveller(travellerId) : [];
    // Newest first, each booking once.
    const all = [...new Map([...own, ...account].map((b) => [b.id, b])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const fresh = await Promise.all(all.map((b) => this.expireIfLapsed(b)));
    return fresh.map((b) => this.toView(b));
  }

  /** Describes what cancelling would do, so the traveller confirms informed. */
  async describeCancellation(sessionId: string, reference: string): Promise<{ booking: Booking; outcome: string }> {
    const booking = await this.getOwned(sessionId, reference);
    switch (booking.status) {
      case 'held':
        return { booking, outcome: 'The seat hold will be released. You have not been charged.' };
      case 'payment_pending':
        return { booking, outcome: 'The seat hold will be released. Do not approve the pending payment prompt. If it was already approved, it will be refunded in full.' };
      case 'ticketed': {
        const rules = booking.offer.fareRules;
        if (!rules.refundable) {
          throw new AppError('INVALID_STATE', 'This ticket is non-refundable, so it cannot be cancelled for a refund. A change may be possible; I can connect you with an agent.');
        }
        const refund = { amountCents: booking.offer.totalPrice.amountCents - rules.refundPenaltyCents, currency: 'USD' as const };
        return { booking, outcome: `The ticket will be cancelled and ${formatUsd(refund)} refunded (penalty ${formatUsd({ amountCents: rules.refundPenaltyCents, currency: 'USD' })}) to the original payment method.` };
      }
      default:
        throw new AppError('INVALID_STATE', `This booking is ${booking.status.replace('_', ' ')} and cannot be cancelled.`);
    }
  }

  /** Cancels a booking. Only reachable through a traveller-approved confirmation. */
  async cancel(sessionId: string, reference: string): Promise<BookingView> {
    const { booking } = await this.describeCancellation(sessionId, reference);
    const now = this.clock.now().toISOString();

    if (booking.status === 'held' || booking.status === 'payment_pending') {
      const updated = await this.bookings.transition(booking.id, ['held', 'payment_pending'], { status: 'cancelled', updatedAt: now });
      if (!updated) throw new AppError('CONFLICT', 'The booking changed while cancelling. Please check its status.');
      await this.payments.cancelPending(booking.id);
      await this.provider.cancel(contextOf(booking)).catch((err: unknown) => this.log.warn('supplier.cancel_failed', { bookingId: booking.id, err: String(err) }));
      return this.toView(updated);
    }

    // Ticketed and refundable: the airline must cancel first, then we refund.
    let supplierRefundCents: number | undefined;
    try {
      const result = await withTimeout('Airline cancellation', SUPPLIER_TIMEOUT_MS, () => this.provider.cancel(contextOf(booking)));
      supplierRefundCents = result.supplierRefund?.amountCents;
    } catch (err) {
      if (err instanceof CancellationNotSupportedError) {
        throw new AppError('INVALID_STATE', 'This airline only accepts cancellations through a BluckFlies agent. Offer to hand the traveller over to a person; nothing has been cancelled yet.');
      }
      throw err;
    }
    const updated = await this.bookings.transition(booking.id, ['ticketed'], { status: 'refund_pending', updatedAt: now });
    if (!updated) {
      this.log.error('booking.cancelled_at_supplier_but_state_changed', { bookingId: booking.id });
      throw new AppError('CONFLICT', 'The booking changed while cancelling. Please check its status.');
    }
    const promised = booking.offer.totalPrice.amountCents - booking.offer.fareRules.refundPenaltyCents;
    // Never refund more than the airline returns to us.
    const refundCents = supplierRefundCents === undefined ? promised : Math.min(promised, supplierRefundCents);
    if (refundCents !== promised) this.log.warn('refund.below_quote', { bookingId: booking.id, promised, refundCents });
    await this.payments.requestRefund(booking.id, { amountCents: refundCents, currency: 'USD' });
    return this.toView(updated);
  }

  /** Background job: expires lapsed holds even if no one looks at them. */
  async sweepLapsedHolds(limit = 100): Promise<{ expired: number }> {
    const lapsed = await this.bookings.findLapsedHolds(this.clock.now(), limit);
    let expired = 0;
    for (const b of lapsed) {
      const after = await this.expireIfLapsed(b);
      if (after.status === 'expired') expired++;
    }
    return { expired };
  }

  private async expireIfLapsed(booking: Booking): Promise<Booking> {
    const lapsable = booking.status === 'held' || booking.status === 'payment_pending';
    if (!lapsable || !isPast(booking.holdExpiresAt, this.clock)) return booking;
    const expired = await this.bookings.transition(booking.id, ['held', 'payment_pending'], { status: 'expired', updatedAt: this.clock.now().toISOString() });
    if (!expired) return (await this.bookings.findById(booking.id)) ?? booking;
    // Void any open payment request; a payment that still lands is refunded automatically.
    await this.payments.cancelPending(booking.id);
    await this.provider.cancel(contextOf(expired)).catch(() => undefined);
    this.log.info('booking.expired', { bookingId: booking.id });
    return expired;
  }

  toView(b: Booking): BookingView {
    const first = b.offer.segments[0];
    const last = b.offer.segments.at(-1);
    return {
      bookingId: b.id,
      pnr: b.pnr,
      status: b.status,
      route: first && last ? `${first.origin} ${b.offer.returnSegments?.length ? '⇄' : '→'} ${last.destination}` : '',
      segments: b.offer.segments.map(viewSegment),
      ...(b.offer.returnSegments?.length ? { returnSegments: b.offer.returnSegments.map(viewSegment) } : {}),
      passengers: b.passengers.map((p) => ({
        name: `${p.givenName} ${p.familyName}`,
        type: p.type,
        ...(p.passportNumber ? { passport: `•••${p.passportNumber.slice(-3)}` } : {}),
      })),
      total: formatUsd(b.offer.totalPrice),
      ...(b.status === 'held' || b.status === 'payment_pending' ? { holdExpiresAt: b.holdExpiresAt } : {}),
      ticketNumbers: b.ticketNumbers,
      refundable: b.offer.fareRules.refundable,
      ...(b.status === 'ticketed' && this.eticketLink ? { eticketUrl: this.eticketLink(b.id) } : {}),
    };
  }
}
