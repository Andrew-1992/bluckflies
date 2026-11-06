import { AppError } from '../domain/errors.js';
import type { ContactDetails, FlightOffer, Passenger, PendingConfirmation } from '../domain/types.js';
import { addMinutes, isPast, type Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { formatUsd } from '../lib/money.js';
import type { ConfirmationRepository } from '../repositories/types.js';
import type { BookingService, BookingView } from './BookingService.js';

const CONFIRMATION_TTL_MINUTES = 15;

export interface ConfirmationView {
  confirmationId: string;
  kind: PendingConfirmation['kind'];
  summary: string;
  expiresAt: string;
}

/**
 * Human-in-the-loop gate. The agent can only *propose* state-changing actions
 * that commit the traveller (reserve seats, cancel a booking). Execution
 * happens when the traveller approves in the app via an authenticated request
 * the model cannot make on their behalf.
 */
export class ConfirmationService {
  constructor(
    private readonly repo: ConfirmationRepository,
    private readonly bookings: BookingService,
    private readonly clock: Clock,
  ) {}

  async proposeReservation(sessionId: string, offerId: string, passengers: Passenger[], contact: ContactDetails): Promise<ConfirmationView> {
    const offer = await this.bookings.validateDraft(sessionId, offerId, passengers, contact);
    const describe = (segs: FlightOffer['segments']) => segs.map((s) => `${s.flightNumber} ${s.origin}→${s.destination} departs ${s.departureTime}`).join('; ');
    const legs = offer.returnSegments?.length
      ? `a round trip: outbound ${describe(offer.segments)}; return ${describe(offer.returnSegments)} (one booking, both directions)`
      : describe(offer.segments);
    const names = passengers.map((p) => `${p.givenName} ${p.familyName} (${p.type})`).join(', ');
    const summary = `Reserve ${legs} for ${names}. Total ${formatUsd(offer.totalPrice)}. ${
      offer.fareRules.refundable ? 'Refundable with penalty.' : 'Non-refundable.'
    } Seats will be held for payment; nothing is charged yet.`;
    return this.create(sessionId, 'create_reservation', summary, { kind: 'create_reservation', offerId, passengers, contact });
  }

  async proposeCancellation(sessionId: string, reference: string): Promise<ConfirmationView> {
    const { booking, outcome } = await this.bookings.describeCancellation(sessionId, reference);
    return this.create(sessionId, 'cancel_booking', `Cancel booking ${booking.pnr}. ${outcome}`, { kind: 'cancel_booking', bookingId: booking.id });
  }

  async listPending(sessionId: string): Promise<ConfirmationView[]> {
    const pending = await this.repo.listPending(sessionId);
    return pending.filter((c) => !isPast(c.expiresAt, this.clock)).map(this.toView);
  }

  /** Called only from the authenticated HTTP route the traveller triggers. */
  async approve(sessionId: string, confirmationId: string): Promise<BookingView> {
    const c = await this.repo.find(confirmationId);
    if (!c || c.sessionId !== sessionId) throw new AppError('NOT_FOUND', 'Confirmation not found.');
    if (isPast(c.expiresAt, this.clock)) {
      await this.repo.transition(c.id, 'pending', 'expired');
      throw new AppError('INVALID_STATE', 'This confirmation has expired. Please ask BluckFlies again.');
    }
    // Compare-and-set makes double-clicks and replays harmless.
    const claimed = await this.repo.transition(c.id, 'pending', 'confirmed');
    if (!claimed) throw new AppError('CONFLICT', 'This confirmation has already been handled.');

    const p = c.payload;
    return p.kind === 'create_reservation'
      ? this.bookings.createReservation(sessionId, p.offerId, p.passengers, p.contact)
      : this.bookings.cancel(sessionId, p.bookingId);
  }

  async decline(sessionId: string, confirmationId: string): Promise<void> {
    const c = await this.repo.find(confirmationId);
    if (!c || c.sessionId !== sessionId) throw new AppError('NOT_FOUND', 'Confirmation not found.');
    await this.repo.transition(c.id, 'pending', 'declined');
  }

  private async create(sessionId: string, kind: PendingConfirmation['kind'], summary: string, payload: PendingConfirmation['payload']): Promise<ConfirmationView> {
    const c: PendingConfirmation = {
      id: newId('cnf'),
      sessionId,
      kind,
      summary,
      payload,
      expiresAt: addMinutes(this.clock.now(), CONFIRMATION_TTL_MINUTES).toISOString(),
      status: 'pending',
    };
    await this.repo.insert(c);
    return this.toView(c);
  }

  private toView = (c: PendingConfirmation): ConfirmationView => ({ confirmationId: c.id, kind: c.kind, summary: c.summary, expiresAt: c.expiresAt });
}
