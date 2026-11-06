/**
 * Core domain types. These are independent of HTTP payloads, LLM tool
 * schemas and any future database models.
 */

/**
 * Airport location code. Airports with scheduled airline service use their
 * 3-letter IATA code; South Sudan airstrips that have none use their 4-letter
 * ICAO code (e.g. HSBR for Bor), so the two can never collide.
 */
export type IataCode = string & { readonly __brand: 'IataCode' };

/** True for 4-letter ICAO airstrip codes, which airline-booking APIs do not accept. */
export const isAirstripCode = (code: string): boolean => /^[A-Z]{4}$/.test(code);

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

export interface Airport {
  iata: IataCode;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  /** IANA time zone used to render local times. */
  timeZone: string;
  isDomestic: boolean;
  /** Alternative spellings travellers use: "Juba", "جوبا", etc. */
  aliases: readonly string[];
  notes?: string;
  /** Present for towns without an airport of their own that travellers reach from here by road. */
  nearbyTowns?: readonly NearbyTown[];
}

export interface NearbyTown {
  name: string;
  /** Arabic name, for the same matching as aliases. */
  nameAr: string;
  aliases: readonly string[];
}

export interface FlightSegment {
  carrierCode: string;
  carrierName: string;
  flightNumber: string;
  origin: IataCode;
  destination: IataCode;
  /** ISO 8601 with UTC offset. */
  departureTime: string;
  arrivalTime: string;
  durationMinutes: number;
  aircraft: string;
}

/** Real suppliers often report piece counts without weights, so weights are optional. */
export interface BaggageAllowance {
  cabinPieces: number;
  cabinKg?: number;
  checkedPieces: number;
  checkedKgPerPiece?: number;
}

export interface FareRules {
  refundable: boolean;
  /** Penalty in minor units (cents) for a refund, when refundable. */
  refundPenaltyCents: number;
  changeable: boolean;
  changePenaltyCents: number;
}

export interface Money {
  /** Integer minor units to avoid floating-point rounding in money. */
  amountCents: number;
  currency: 'USD';
}

export type PassengerType = 'adult' | 'child' | 'infant';

/** Who is travelling; airlines price adults, children and infants differently. */
export interface PassengerMix {
  adults: number;
  /** Age on the travel date of each child aged 2–11. */
  childAges: readonly number[];
  /** Infants under 2, travelling on an adult's lap. */
  infants: number;
}

/** Supplier-side identifiers needed to book an offer (never shown to travellers). */
export interface SupplierOfferData {
  offerId: string;
  /** Supplier passenger IDs, in the order adults, children (by childAges), infants. */
  passengerIds: readonly string[];
  /** True if the airline requires payment at booking (no seat hold possible). */
  requiresInstantPayment: boolean;
  ownerName?: string;
}

/**
 * An amount actually collected from (or returned to) a payer, in any currency,
 * in that currency's minor units (cents, piasters). Fares stay in USD (`Money`);
 * mobile-money wallets in South Sudan hold SSP, so charges can differ.
 */
export interface ChargeAmount {
  amountMinor: number;
  /** ISO 4217, e.g. "USD", "SSP". */
  currency: string;
}

/** Exchange rate locked onto a payment when it was requested. */
export interface FxQuote {
  currency: string;
  /** Units of `currency` per 1 USD, as an exact decimal string (e.g. "4612.5"). */
  perUsd: string;
  /** When the rate was published by its source. */
  asOf: string;
  source: string;
  /** Markup applied on top of the rate, in basis points (100 = 1%). */
  markupBps: number;
}

export interface FlightOffer {
  id: string;
  provider: string;
  /** The outbound journey (the whole trip for a one-way fare). */
  segments: readonly FlightSegment[];
  /**
   * The journey back, for a round-trip fare: priced together with the outbound,
   * booked as one order with one booking code and one ticket per traveller.
   */
  returnSegments?: readonly FlightSegment[];
  cabin: CabinClass;
  /** Total travellers (adults + children + infants). */
  passengers: number;
  passengerMix: PassengerMix;
  totalPrice: Money;
  baggage: BaggageAllowance;
  fareRules: FareRules;
  /** Unknown for most real suppliers. */
  seatsRemaining?: number;
  expiresAt: string;
  supplier?: SupplierOfferData;
}

export interface FlightSearchCriteria {
  origin: IataCode;
  destination: IataCode;
  departureDate: string; // YYYY-MM-DD
  /** Set for a round trip: destination back to origin on this date. */
  returnDate?: string;
  passengers: PassengerMix;
  cabin: CabinClass;
  maxStops: number;
}

/** Every flight in the trip, outbound then return. */
export const allSegments = (o: Pick<FlightOffer, 'segments' | 'returnSegments'>): readonly FlightSegment[] => [...o.segments, ...(o.returnSegments ?? [])];
export const isRoundTrip = (o: Pick<FlightOffer, 'returnSegments'>): boolean => (o.returnSegments?.length ?? 0) > 0;

export const passengerCount = (m: PassengerMix): number => m.adults + m.childAges.length + m.infants;

export interface Passenger {
  type: PassengerType;
  /** Latin letters exactly as printed on the passport (airlines reject other scripts). */
  givenName: string;
  familyName: string;
  /** As on the travel document; airlines require it. */
  gender: 'm' | 'f';
  dateOfBirth: string; // YYYY-MM-DD
  nationality: string; // ISO 3166-1 alpha-2
  /** Collected for international itineraries. Stored masked in responses. */
  passportNumber?: string;
  passportExpiry?: string;
}

export interface ContactDetails {
  phone: string; // E.164
  /** E-tickets and airline notifications are sent here. */
  email: string;
  /** Language for messages to the traveller (e-ticket, SMS). Defaults to English. */
  language?: 'en' | 'ar';
}

export type BookingStatus =
  | 'held' // seats held, awaiting payment
  | 'payment_pending' // payment request sent, awaiting provider confirmation
  | 'ticketing' // paid; one worker is issuing tickets with the supplier
  | 'ticketed' // paid and tickets issued
  | 'expired' // hold lapsed without payment
  | 'cancelled' // cancelled before ticketing
  | 'refund_pending' // ticketed, cancelled, refund requested
  | 'refunded';

export interface Booking {
  id: string;
  /** Airline-style record locator shown to the traveller. */
  pnr: string;
  ownerSessionId: string;
  /** Account that owns the booking (set at creation when logged in, or when the traveller logs in later). */
  travellerId?: string;
  offer: FlightOffer;
  passengers: readonly Passenger[];
  contact: ContactDetails;
  status: BookingStatus;
  holdExpiresAt: string;
  ticketNumbers: readonly string[];
  supplierReference: string;
  createdAt: string;
  updatedAt: string;
}

/** `card` is served by Stripe Checkout; mobile money by a local provider. */
export type PaymentMethod = 'mtn_momo' | 'zain_mgurush' | 'card' | 'bank_transfer' | 'cash_office';

/** Paid in person or at a bank and confirmed by staff (no provider API). */
export const MANUAL_PAYMENT_METHODS: readonly PaymentMethod[] = ['bank_transfer', 'cash_office'];

export type PaymentStatus = 'requested' | 'succeeded' | 'failed' | 'cancelled' | 'refund_requested' | 'refunded';

export interface Payment {
  id: string;
  bookingId: string;
  method: PaymentMethod;
  /** Name of the provider that holds this payment; refunds must go back to it. */
  provider: string;
  /** Booking value in USD. */
  amount: Money;
  /** What the payer is asked to pay; equals `amount` for USD charges. */
  charge: ChargeAmount;
  /** Present when `charge` is in another currency. */
  fx?: FxQuote;
  status: PaymentStatus;
  providerReference: string;
  /** Provider refund ID once a refund has been requested. */
  refundReference?: string;
  approvalInstructions: string;
  /** Hosted payment page for card payments. */
  checkoutUrl?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  /** When the money was confirmed (set on the move to `succeeded`), for finance reports. */
  paidAt?: string;
  /** When the refund completed (set on the move to `refunded`). */
  refundedAt?: string;
}

/** An action the traveller must approve in the UI. The agent cannot approve it. */
export interface PendingConfirmation {
  id: string;
  sessionId: string;
  kind: 'create_reservation' | 'cancel_booking';
  summary: string;
  payload: ReservationDraft | CancellationDraft;
  expiresAt: string;
  status: 'pending' | 'confirmed' | 'declined' | 'expired';
}

export interface ReservationDraft {
  kind: 'create_reservation';
  offerId: string;
  passengers: Passenger[];
  contact: ContactDetails;
}

export interface CancellationDraft {
  kind: 'cancel_booking';
  bookingId: string;
}
