import { resolveAirports } from '../data/airports.js';
import { AppError } from '../domain/errors.js';
import { isAirstripCode, passengerCount, type Airport, type CabinClass, type FlightOffer, type FlightSegment, type PassengerMix } from '../domain/types.js';
import { addMinutes, type Clock } from '../lib/clock.js';
import { formatUsd, indicativeSsp } from '../lib/money.js';
import { isIsoDate } from '../lib/time.js';
import { withTimeout } from '../lib/withTimeout.js';
import type { FlightProvider } from '../providers/flights/FlightProvider.js';
import type { OfferRepository } from '../repositories/types.js';
import type { FxService } from './FxService.js';

export interface SearchInput {
  origin: string;
  destination: string;
  departureDate: string;
  /** Round trip: return from the destination on this date, priced with the outbound. */
  returnDate?: string;
  passengers: PassengerMix;
  cabin: CabinClass;
  maxStops: number;
  sortBy: 'best' | 'cheapest' | 'fastest';
}

export interface JourneySummary {
  stops: number;
  durationMinutes: number;
  segments: OfferSummary['segments'];
}

export type OfferTag = 'cheapest' | 'fastest' | 'best_value';

export interface OfferSummary {
  offerId: string;
  tags: OfferTag[];
  price: string;
  /** Present when an SSP rate is known; carries the rate's date. */
  priceIndicativeSsp?: string;
  /** Per-adult price; children and infants are usually cheaper. */
  passengers: string;
  airline?: string;
  /** Outbound journey (the whole trip for one-way fares). */
  stops: number;
  totalDurationMinutes: number;
  segments: Array<{
    flight: string;
    carrier: string;
    from: string;
    to: string;
    departs: string;
    arrives: string;
    aircraft: string;
  }>;
  /** Round-trip fares: the journey back. The price covers both directions. */
  return?: JourneySummary;
  baggage: string;
  refundable: boolean;
  changeable: boolean;
  seatsRemaining?: number;
  /** "hold": seats can be held while the traveller pays. "pay_now": the airline confirms only after payment. */
  booking: 'hold' | 'pay_now';
  expiresAt: string;
  /** True for generated demo inventory. */
  sandbox: boolean;
}

export interface SearchResult {
  origin: { code: string; name: string };
  destination: { code: string; name: string };
  departureDate: string;
  /** Present for a round-trip search. */
  returnDate?: string;
  passengers: string;
  cabin: CabinClass;
  offers: OfferSummary[];
  totalFound: number;
  /** Present when results include generated sandbox inventory. */
  notice?: string;
}

const MAX_RESULTS = 6;

const SANDBOX_NOTICE = 'SANDBOX results are generated demo inventory, not real airline schedules or fares.';
const AIRSTRIP_NOTICE =
  'No bookable flights online for this airstrip. Flights to South Sudan town airstrips are mostly charter or humanitarian services: offer to hand the request to a BluckFlies agent (handoff_to_human) who can arrange one.';

function searchNotice(sandbox: boolean, airstripWithoutOffers: boolean): { notice?: string } {
  const parts = [sandbox ? SANDBOX_NOTICE : '', airstripWithoutOffers ? AIRSTRIP_NOTICE : ''].filter(Boolean);
  return parts.length > 0 ? { notice: parts.join(' ') } : {};
}
const MAX_DAYS_AHEAD = 330;
/** Real suppliers query airlines live; the adapter's own timeouts fire before this. */
const PROVIDER_TIMEOUT_MS = 35_000;
const MAX_PASSENGERS = 9;

export function describeMix(m: PassengerMix): string {
  const parts = [`${m.adults} adult${m.adults === 1 ? '' : 's'}`];
  if (m.childAges.length) parts.push(`${m.childAges.length} child${m.childAges.length === 1 ? '' : 'ren'} (age ${m.childAges.join(', ')})`);
  if (m.infants) parts.push(`${m.infants} infant${m.infants === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export const journeyMinutes = (segments: readonly FlightSegment[]): number => {
  const first = segments[0];
  const last = segments.at(-1);
  if (!first || !last) return 0;
  return Math.round((Date.parse(last.arrivalTime) - Date.parse(first.departureTime)) / 60_000);
};

/** Outbound journey time. */
export const totalDurationMinutes = (o: FlightOffer): number => journeyMinutes(o.segments);

/** Time in the air and connecting, both directions: used for ranking. */
const tripMinutes = (o: FlightOffer): number => journeyMinutes(o.segments) + journeyMinutes(o.returnSegments ?? []);
const tripStops = (o: FlightOffer): number => o.segments.length - 1 + Math.max(0, (o.returnSegments?.length ?? 0) - 1);

const segmentSummary = (s: FlightSegment): OfferSummary['segments'][number] => ({
  flight: s.flightNumber,
  carrier: s.carrierName,
  from: s.origin,
  to: s.destination,
  departs: s.departureTime,
  arrives: s.arrivalTime,
  aircraft: s.aircraft,
});

export class FlightSearchService {
  constructor(
    private readonly provider: FlightProvider,
    private readonly offers: OfferRepository,
    private readonly clock: Clock,
    private readonly opts: { offerTtlMinutes: number },
    private readonly fx: Pick<FxService, 'displayRate'>,
  ) {}

  resolveAirport(query: string, role: 'origin' | 'destination'): Airport {
    const matches = resolveAirports(query);
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length === 0) {
      throw new AppError('VALIDATION_FAILED', `I couldn't find an airport for "${query}" (${role}). BluckFlies serves Juba, Wau, Malakal, Rumbek, South Sudan town airstrips (such as Bor, Torit, Yambio, Yei, Aweil and Bentiu) and major regional hubs.`);
    }
    throw new AppError('VALIDATION_FAILED', `"${query}" matches several airports. Please choose one.`, {
      candidates: matches.map((a) => ({ code: a.iata, name: a.name, city: a.city })),
    });
  }

  async search(sessionId: string, input: SearchInput): Promise<SearchResult> {
    const origin = this.resolveAirport(input.origin, 'origin');
    const destination = this.resolveAirport(input.destination, 'destination');
    if (origin.iata === destination.iata) throw new AppError('VALIDATION_FAILED', 'Origin and destination must be different.');
    this.assertBookableDate(input.departureDate);
    if (input.returnDate !== undefined) {
      this.assertBookableDate(input.returnDate);
      if (input.returnDate < input.departureDate) throw new AppError('VALIDATION_FAILED', 'The return date must be on or after the departure date.');
    }
    const mix = input.passengers;
    if (mix.adults < 1) throw new AppError('VALIDATION_FAILED', 'At least one adult must travel.');
    if (mix.infants > mix.adults) throw new AppError('VALIDATION_FAILED', 'Each infant must travel on the lap of a separate adult.');
    if (passengerCount(mix) > MAX_PASSENGERS) throw new AppError('VALIDATION_FAILED', `Online bookings are limited to ${MAX_PASSENGERS} travellers; larger groups are handled by an agent.`);

    const expiresAt = addMinutes(this.clock.now(), this.opts.offerTtlMinutes);
    const raw = await withTimeout('Flight search', PROVIDER_TIMEOUT_MS, () =>
      this.provider.search(
        {
          origin: origin.iata,
          destination: destination.iata,
          departureDate: input.departureDate,
          ...(input.returnDate ? { returnDate: input.returnDate } : {}),
          passengers: mix,
          cabin: input.cabin,
          maxStops: input.maxStops,
        },
        expiresAt,
      ),
    );

    const now = this.clock.now().getTime();
    const seatsNeeded = mix.adults + mix.childAges.length; // infants sit on laps
    const available = raw.filter(
      (o) => (o.seatsRemaining ?? Infinity) >= seatsNeeded && Date.parse(o.segments[0]?.departureTime ?? '') > now && Date.parse(o.expiresAt) > now,
    );
    const ranked = this.rank(available, input.sortBy).slice(0, MAX_RESULTS);
    await this.offers.saveMany(sessionId, ranked.map((r) => r.offer));

    return {
      origin: { code: origin.iata, name: `${origin.city} – ${origin.name}` },
      destination: { code: destination.iata, name: `${destination.city} – ${destination.name}` },
      departureDate: input.departureDate,
      ...(input.returnDate ? { returnDate: input.returnDate } : {}),
      passengers: describeMix(mix),
      cabin: input.cabin,
      offers: await this.summarizeAll(ranked),
      totalFound: available.length,
      ...searchNotice(ranked.some((r) => this.isSandbox(r.offer)), ranked.length === 0 && [origin, destination].some((a) => isAirstripCode(a.iata))),
    };
  }

  async getOffer(sessionId: string, offerId: string): Promise<FlightOffer> {
    const offer = await this.offers.find(sessionId, offerId);
    if (!offer) throw new AppError('NOT_FOUND', 'That offer was not found. Please search again.');
    return offer;
  }

  private isSandbox(offer: FlightOffer): boolean {
    return offer.provider === 'sandbox';
  }

  private async summarizeAll(ranked: Array<{ offer: FlightOffer; tags: OfferTag[] }>): Promise<OfferSummary[]> {
    const rate = await this.fx.displayRate('SSP');
    return ranked.map((r) => this.summarize(r.offer, r.tags, rate));
  }

  async describe(offer: FlightOffer): Promise<OfferSummary> {
    return this.summarize(offer, [], await this.fx.displayRate('SSP'));
  }

  summarize(offer: FlightOffer, tags: OfferTag[] = [], sspRate?: { perUsd: string; asOf: string }): OfferSummary {
    const b = offer.baggage;
    const kg = (n: number | undefined) => (n === undefined ? '' : ` × ${n} kg`);
    return {
      offerId: offer.id,
      tags,
      price: formatUsd(offer.totalPrice),
      ...(sspRate ? { priceIndicativeSsp: indicativeSsp(offer.totalPrice, sspRate) } : {}),
      passengers: describeMix(offer.passengerMix),
      ...(offer.supplier?.ownerName ? { airline: offer.supplier.ownerName } : {}),
      stops: offer.segments.length - 1,
      totalDurationMinutes: totalDurationMinutes(offer),
      segments: offer.segments.map(segmentSummary),
      ...(offer.returnSegments?.length
        ? { return: { stops: offer.returnSegments.length - 1, durationMinutes: journeyMinutes(offer.returnSegments), segments: offer.returnSegments.map(segmentSummary) } }
        : {}),
      baggage: `${b.cabinPieces} cabin bag${b.cabinPieces === 1 ? '' : 's'}${kg(b.cabinKg)}, ${b.checkedPieces} checked${kg(b.checkedKgPerPiece)} per traveller`,
      refundable: offer.fareRules.refundable,
      changeable: offer.fareRules.changeable,
      ...(offer.seatsRemaining !== undefined ? { seatsRemaining: offer.seatsRemaining } : {}),
      booking: offer.supplier?.requiresInstantPayment ? 'pay_now' : 'hold',
      expiresAt: offer.expiresAt,
      sandbox: this.isSandbox(offer),
    };
  }

  private rank(offers: FlightOffer[], sortBy: SearchInput['sortBy']): Array<{ offer: FlightOffer; tags: OfferTag[] }> {
    if (offers.length === 0) return [];
    const prices = offers.map((o) => o.totalPrice.amountCents);
    const durations = offers.map(tripMinutes);
    const [minP, maxP, minD, maxD] = [Math.min(...prices), Math.max(...prices), Math.min(...durations), Math.max(...durations)];
    const norm = (v: number, lo: number, hi: number) => (hi === lo ? 0 : (v - lo) / (hi - lo));

    // Value score: 60% price, 30% duration, 10% penalty per stop.
    const scored = offers.map((offer) => ({
      offer,
      price: offer.totalPrice.amountCents,
      duration: tripMinutes(offer),
      score:
        0.6 * norm(offer.totalPrice.amountCents, minP, maxP) +
        0.3 * norm(tripMinutes(offer), minD, maxD) +
        0.1 * tripStops(offer),
    }));

    const best = scored.reduce((a, b) => (b.score < a.score ? b : a));
    const sorted = [...scored].sort((a, b) =>
      sortBy === 'cheapest' ? a.price - b.price : sortBy === 'fastest' ? a.duration - b.duration : a.score - b.score,
    );

    return sorted.map((s) => {
      const tags: OfferTag[] = [];
      if (s.price === minP) tags.push('cheapest');
      if (s.duration === minD) tags.push('fastest');
      if (s === best) tags.push('best_value');
      return { offer: s.offer, tags };
    });
  }

  private assertBookableDate(date: string): void {
    if (!isIsoDate(date)) throw new AppError('VALIDATION_FAILED', 'Departure date must be in YYYY-MM-DD format.');
    const todayJuba = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Juba' }).format(this.clock.now());
    if (date < todayJuba) throw new AppError('VALIDATION_FAILED', 'That departure date is in the past.');
    const maxDate = new Date(Date.parse(`${todayJuba}T00:00:00Z`) + MAX_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);
    if (date > maxDate) throw new AppError('VALIDATION_FAILED', `Flights can be booked up to ${MAX_DAYS_AHEAD} days ahead.`);
  }
}
