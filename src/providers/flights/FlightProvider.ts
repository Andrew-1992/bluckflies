import type { ContactDetails, FlightOffer, FlightSearchCriteria, Money, Passenger } from '../../domain/types.js';

export type FlightStatusCode = 'scheduled' | 'on_time' | 'delayed' | 'departed' | 'landed' | 'cancelled' | 'unknown';

export interface FlightStatus {
  carrierCode: string;
  flightNumber: string;
  date: string;
  status: FlightStatusCode;
  estimatedDeparture?: string;
  remarks: string;
}

/** Everything a supplier needs to reserve or ticket a booking. */
export interface BookingContext {
  bookingId: string;
  /** Supplier reference from `hold` (an order ID, or a deferred-booking marker). */
  supplierReference: string;
  offer: FlightOffer;
  passengers: readonly Passenger[];
  contact: ContactDetails;
}

export interface HoldResult {
  supplierReference: string;
  /**
   * Latest time the traveller can pay: the airline's payment deadline for a
   * real hold, or the offer's expiry when the airline only sells with
   * instant payment (the order is then created at ticketing time).
   */
  payBy?: string;
}

export interface IssuedTickets {
  /** May differ from the hold reference (a deferred booking gets its order ID here). */
  supplierReference: string;
  ticketNumbers: string[];
  /** Airline booking reference, when the supplier returns one. */
  airlineReference?: string;
}

export interface CancelResult {
  /** What the supplier will refund to us, when known. */
  supplierRefund?: Money;
}

/**
 * Ticketing failed in a way that retrying cannot fix (fare gone, price rose,
 * schedule changed). The paid booking must be refunded.
 */
export class PermanentTicketingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentTicketingError';
  }
}

/** The airline does not allow this cancellation through the API; a person must handle it. */
export class CancellationNotSupportedError extends Error {
  constructor(message = 'This airline does not support cancellation through our system.') {
    super(message);
    this.name = 'CancellationNotSupportedError';
  }
}

/**
 * Supplier boundary for flight content (aggregator, GDS or airline API).
 * `search`, `revalidate`, `findIssuedTickets` and `getFlightStatus` are safe to
 * retry. `hold`, `issueTickets` and `cancel` must never be blindly retried by
 * callers; implementations protect against duplicates where the supplier allows.
 */
export interface FlightProvider {
  readonly name: string;
  /** True for generated demo inventory that must never be sold in production. */
  readonly isSandbox: boolean;
  search(criteria: FlightSearchCriteria, offerExpiresAt: Date): Promise<FlightOffer[]>;
  /** Re-prices an offer before holding it; returns null if no longer available. */
  revalidate(offer: FlightOffer): Promise<FlightOffer | null>;
  hold(ctx: Omit<BookingContext, 'supplierReference'>): Promise<HoldResult>;
  /** Pays the supplier and issues tickets. Throws PermanentTicketingError when it can never succeed. */
  issueTickets(ctx: BookingContext): Promise<IssuedTickets>;
  /** Tickets already issued for this booking (crash recovery), or null if none. */
  findIssuedTickets(ctx: BookingContext): Promise<IssuedTickets | null>;
  /** Releases a hold or cancels a ticketed order. Throws CancellationNotSupportedError when a person must do it. */
  cancel(ctx: BookingContext): Promise<CancelResult>;
  getFlightStatus(carrierCode: string, flightNumber: string, date: string): Promise<FlightStatus>;
}
