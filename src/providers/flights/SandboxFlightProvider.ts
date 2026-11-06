import { createHash } from 'node:crypto';
import { findAirportByCode } from '../../data/airports.js';
import { passengerCount, type CabinClass, type FlightOffer, type FlightSearchCriteria, type FlightSegment, type IataCode } from '../../domain/types.js';
import { newId } from '../../lib/ids.js';
import { toZonedIso, zonedToUtc } from '../../lib/time.js';
import type { BookingContext, CancelResult, FlightProvider, FlightStatus, HoldResult, IssuedTickets } from './FlightProvider.js';

/**
 * Deterministic sandbox inventory for development and demos.
 *
 * Carriers here are FICTIONAL ("Sandbox …") on purpose: schedules and fares are
 * generated, so they must never be presented as real airline data. Replace this
 * provider with a real supplier adapter for production.
 */

interface Leg {
  carrierCode: string;
  carrierName: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departLocal: string; // HH:MM in origin time zone
  durationMinutes: number;
  /** ISO weekdays (1 = Monday … 7 = Sunday) the flight operates. */
  days: readonly number[];
  baseFareCents: number;
  aircraft: string;
}

const DAILY = [1, 2, 3, 4, 5, 6, 7] as const;
const XN = { carrierCode: 'XN', carrierName: 'Sandbox Nile Air' };
const XS = { carrierCode: 'XS', carrierName: 'Sandbox Savannah Express' };
const XG = { carrierCode: 'XG', carrierName: 'Sandbox Gulf Connect' };
const XA = { carrierCode: 'XA', carrierName: 'Sandbox Airstrip Link' };

/** Juba ↔ town airstrip shuttles: [airstrip, flight number base, depart, minutes, days, fare in cents]. */
const AIRSTRIP_SHUTTLES: readonly (readonly [string, number, string, number, readonly number[], number])[] = [
  ['HSBR', 501, '07:30', 45, [1, 3, 5], 14000],
  ['HSTR', 503, '08:00', 40, [2, 4, 6], 13000],
  ['HSKP', 505, '08:15', 60, [1, 4], 16000],
  ['HSYE', 507, '07:45', 35, [2, 5], 12000],
  ['HSYA', 509, '09:00', 80, [1, 3, 6], 19000],
  ['HSMD', 511, '09:30', 70, [2, 6], 18000],
  ['HSPI', 513, '08:30', 65, [3, 7], 17000],
  ['HSPA', 515, '08:45', 90, [4], 21000],
  ['HSBT', 517, '07:15', 105, [1, 4, 6], 23000],
  ['HSRN', 519, '06:45', 150, [3], 29000],
  ['HJKJ', 521, '07:00', 100, [2, 5], 22000],
  ['HSAW', 523, '07:20', 110, [1, 3, 5], 23000],
];

const addMinutesHHMM = (hhmm: string, minutes: number): string => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** Each shuttle flies out from Juba and returns after a 45-minute turnaround. */
const AIRSTRIP_LEGS: readonly Leg[] = AIRSTRIP_SHUTTLES.flatMap(([code, num, depart, minutes, days, fare]) => [
  { ...XA, flightNumber: `XA${num}`, origin: 'JUB', destination: code, departLocal: depart, durationMinutes: minutes, days, baseFareCents: fare, aircraft: 'Cessna 208B' },
  { ...XA, flightNumber: `XA${num + 1}`, origin: code, destination: 'JUB', departLocal: addMinutesHHMM(depart, minutes + 45), durationMinutes: minutes, days, baseFareCents: fare, aircraft: 'Cessna 208B' },
]);

const LEGS: readonly Leg[] = [
  // Domestic (Sandbox Nile Air)
  { ...XN, flightNumber: 'XN101', origin: 'JUB', destination: 'WUU', departLocal: '08:30', durationMinutes: 95, days: [1, 3, 5, 7], baseFareCents: 21000, aircraft: 'Dash 8-100' },
  { ...XN, flightNumber: 'XN102', origin: 'WUU', destination: 'JUB', departLocal: '11:15', durationMinutes: 95, days: [1, 3, 5, 7], baseFareCents: 21000, aircraft: 'Dash 8-100' },
  { ...XN, flightNumber: 'XN201', origin: 'JUB', destination: 'MAK', departLocal: '09:00', durationMinutes: 110, days: [2, 4, 6], baseFareCents: 24000, aircraft: 'Dash 8-100' },
  { ...XN, flightNumber: 'XN202', origin: 'MAK', destination: 'JUB', departLocal: '12:00', durationMinutes: 110, days: [2, 4, 6], baseFareCents: 24000, aircraft: 'Dash 8-100' },
  { ...XN, flightNumber: 'XN301', origin: 'JUB', destination: 'RBX', departLocal: '07:45', durationMinutes: 75, days: [1, 2, 4, 6], baseFareCents: 18000, aircraft: 'Cessna 208B' },
  { ...XN, flightNumber: 'XN302', origin: 'RBX', destination: 'JUB', departLocal: '10:00', durationMinutes: 75, days: [1, 2, 4, 6], baseFareCents: 18000, aircraft: 'Cessna 208B' },
  // Regional (Sandbox Savannah Express)
  { ...XS, flightNumber: 'XS410', origin: 'JUB', destination: 'NBO', departLocal: '14:30', durationMinutes: 115, days: DAILY, baseFareCents: 32000, aircraft: 'Embraer E190' },
  { ...XS, flightNumber: 'XS411', origin: 'NBO', destination: 'JUB', departLocal: '09:40', durationMinutes: 115, days: DAILY, baseFareCents: 32000, aircraft: 'Embraer E190' },
  { ...XS, flightNumber: 'XS420', origin: 'JUB', destination: 'EBB', departLocal: '13:10', durationMinutes: 65, days: DAILY, baseFareCents: 24500, aircraft: 'CRJ900' },
  { ...XS, flightNumber: 'XS421', origin: 'EBB', destination: 'JUB', departLocal: '10:20', durationMinutes: 65, days: DAILY, baseFareCents: 24500, aircraft: 'CRJ900' },
  { ...XS, flightNumber: 'XS430', origin: 'JUB', destination: 'ADD', departLocal: '15:50', durationMinutes: 130, days: DAILY, baseFareCents: 36000, aircraft: 'Boeing 737-800' },
  { ...XS, flightNumber: 'XS431', origin: 'ADD', destination: 'JUB', departLocal: '09:10', durationMinutes: 130, days: DAILY, baseFareCents: 36000, aircraft: 'Boeing 737-800' },
  { ...XS, flightNumber: 'XS440', origin: 'JUB', destination: 'KGL', departLocal: '12:00', durationMinutes: 120, days: [2, 4, 6], baseFareCents: 34000, aircraft: 'CRJ900' },
  { ...XS, flightNumber: 'XS441', origin: 'KGL', destination: 'JUB', departLocal: '08:30', durationMinutes: 120, days: [2, 4, 6], baseFareCents: 34000, aircraft: 'CRJ900' },
  { ...XS, flightNumber: 'XS450', origin: 'JUB', destination: 'CAI', departLocal: '05:30', durationMinutes: 240, days: [1, 4, 6], baseFareCents: 52000, aircraft: 'Airbus A320' },
  { ...XS, flightNumber: 'XS451', origin: 'CAI', destination: 'JUB', departLocal: '13:00', durationMinutes: 240, days: [1, 4, 6], baseFareCents: 52000, aircraft: 'Airbus A320' },
  // Long-haul (Sandbox Gulf Connect)
  { ...XG, flightNumber: 'XG660', origin: 'JUB', destination: 'DXB', departLocal: '17:20', durationMinutes: 300, days: DAILY, baseFareCents: 61000, aircraft: 'Boeing 737 MAX 8' },
  { ...XG, flightNumber: 'XG661', origin: 'DXB', destination: 'JUB', departLocal: '09:30', durationMinutes: 320, days: DAILY, baseFareCents: 61000, aircraft: 'Boeing 737 MAX 8' },
  { ...XG, flightNumber: 'XG680', origin: 'ADD', destination: 'IST', departLocal: '22:40', durationMinutes: 330, days: DAILY, baseFareCents: 48000, aircraft: 'Airbus A321neo' },
  { ...XG, flightNumber: 'XG681', origin: 'IST', destination: 'ADD', departLocal: '02:15', durationMinutes: 320, days: DAILY, baseFareCents: 48000, aircraft: 'Airbus A321neo' },
  { ...XG, flightNumber: 'XG690', origin: 'NBO', destination: 'DXB', departLocal: '23:55', durationMinutes: 290, days: DAILY, baseFareCents: 42000, aircraft: 'Boeing 737 MAX 8' },
  { ...XG, flightNumber: 'XG691', origin: 'DXB', destination: 'NBO', departLocal: '03:30', durationMinutes: 300, days: DAILY, baseFareCents: 42000, aircraft: 'Boeing 737 MAX 8' },
  ...AIRSTRIP_LEGS,
];

const CABIN_MULTIPLIER: Record<CabinClass, number> = { economy: 1, premium_economy: 1.6, business: 2.8, first: 4.2 };
const MIN_CONNECTION_MINUTES = 75;
const MAX_CONNECTION_MINUTES = 12 * 60;
/** A return flight leaves at least this long after the outbound lands. */
const MIN_TURNAROUND_MINUTES = 3 * 60;
/** Keeps the number of round-trip combinations readable. */
const MAX_RETURNS_PER_OUTBOUND = 3;
/** Sandbox assumption: a return fare costs 10% less than two one-way fares. Real discounts vary by airline. */
const ROUND_TRIP_FACTOR = 0.9;

/** Stable pseudo-random value in [0, 1) for a key, so the same search returns the same fares. */
function stableRandom(key: string): number {
  const h = createHash('sha256').update(key).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function tzOf(code: string): string {
  const airport = findAirportByCode(code);
  if (!airport) throw new Error(`Sandbox inventory references unknown airport ${code}`);
  return airport.timeZone;
}

interface DatedLeg {
  leg: Leg;
  departUtc: Date;
  arriveUtc: Date;
  date: string;
}

function datedLeg(leg: Leg, date: string): DatedLeg | null {
  if (!leg.days.includes(isoWeekday(date))) return null;
  const departUtc = zonedToUtc(date, leg.departLocal, tzOf(leg.origin));
  return { leg, departUtc, arriveUtc: new Date(departUtc.getTime() + leg.durationMinutes * 60_000), date };
}

function toSegment(d: DatedLeg): FlightSegment {
  return {
    carrierCode: d.leg.carrierCode,
    carrierName: d.leg.carrierName,
    flightNumber: d.leg.flightNumber,
    origin: d.leg.origin as IataCode,
    destination: d.leg.destination as IataCode,
    departureTime: toZonedIso(d.departUtc, tzOf(d.leg.origin)),
    arrivalTime: toZonedIso(d.arriveUtc, tzOf(d.leg.destination)),
    durationMinutes: d.leg.durationMinutes,
    aircraft: d.leg.aircraft,
  };
}

/** Child and infant fares as a share of the adult fare (typical IATA-style discounts). */
const CHILD_FARE_SHARE = 0.75;
const INFANT_FARE_SHARE = 0.1;

export class SandboxFlightProvider implements FlightProvider {
  readonly name = 'sandbox';
  readonly isSandbox = true;
  /**
   * In-process view of holds. The sandbox has no supplier-side storage, so a
   * reference created by another process (or before a restart) is treated as
   * a live hold, and ticket numbers are derived from the reference: re-issuing
   * after a restart yields the same tickets, as a real supplier would report.
   */
  private readonly holds = new Map<string, { status: 'held' | 'ticketed' | 'cancelled'; tickets: string[] }>();
  /** Test hook: number of upcoming issueTickets calls that fail. */
  failNextIssuances = 0;

  private holdFor(supplierReference: string) {
    let hold = this.holds.get(supplierReference);
    if (!hold) {
      if (!supplierReference.startsWith('sbx_')) throw new Error('Sandbox: unknown supplier reference');
      hold = { status: 'held', tickets: [] };
      this.holds.set(supplierReference, hold);
    }
    return hold;
  }

  async search(criteria: FlightSearchCriteria, offerExpiresAt: Date): Promise<FlightOffer[]> {
    const outbound = this.journeys(criteria.origin, criteria.destination, criteria.departureDate, criteria.maxStops);
    if (!criteria.returnDate) return outbound.map((legs) => this.toOffer(legs, criteria, offerExpiresAt));

    // Round trip: pair each outbound with the return journeys that leave after it lands.
    const back = this.journeys(criteria.destination, criteria.origin, criteria.returnDate, criteria.maxStops);
    const offers: FlightOffer[] = [];
    for (const out of outbound) {
      const landed = out.at(-1)?.arriveUtc.getTime() ?? Infinity;
      const fits = back.filter((r) => (r[0]?.departUtc.getTime() ?? 0) - landed >= MIN_TURNAROUND_MINUTES * 60_000).slice(0, MAX_RETURNS_PER_OUTBOUND);
      for (const ret of fits) offers.push(this.toOffer(out, criteria, offerExpiresAt, ret));
    }
    return offers;
  }

  /** Direct flights and one-stop connections (including next-day onward legs). */
  private journeys(origin: string, destination: string, date: string, maxStops: number): DatedLeg[][] {
    const found: DatedLeg[][] = [];
    for (const leg of LEGS) {
      if (leg.origin !== origin) continue;
      const first = datedLeg(leg, date);
      if (!first) continue;

      if (leg.destination === destination) {
        found.push([first]);
        continue;
      }
      if (maxStops < 1) continue;

      for (const next of LEGS) {
        if (next.origin !== leg.destination || next.destination !== destination) continue;
        for (const offset of [0, 1]) {
          const second = datedLeg(next, addDays(date, offset));
          if (!second) continue;
          const gap = (second.departUtc.getTime() - first.arriveUtc.getTime()) / 60_000;
          if (gap >= MIN_CONNECTION_MINUTES && gap <= MAX_CONNECTION_MINUTES) found.push([first, second]);
        }
      }
    }
    return found;
  }

  async revalidate(offer: FlightOffer): Promise<FlightOffer | null> {
    // Sandbox fares are stable; a real supplier re-prices here and may return a new total.
    return (offer.seatsRemaining ?? Infinity) >= offer.passengers ? offer : null;
  }

  async hold(_ctx: Omit<BookingContext, 'supplierReference'>): Promise<HoldResult> {
    const supplierReference = newId('sbx');
    this.holds.set(supplierReference, { status: 'held', tickets: [] });
    return { supplierReference };
  }

  async issueTickets(ctx: BookingContext): Promise<IssuedTickets> {
    const { supplierReference } = ctx;
    const hold = this.holdFor(supplierReference);
    if (hold.status === 'cancelled') throw new Error('Sandbox: hold cancelled');
    if (this.failNextIssuances > 0) {
      this.failNextIssuances -= 1;
      throw new Error('Sandbox: simulated ticketing outage');
    }
    if (hold.status === 'ticketed') throw new Error('Sandbox: tickets already issued for this hold');
    hold.status = 'ticketed';
    // 13-digit e-ticket format; the 999 prefix marks sandbox tickets.
    hold.tickets = Array.from({ length: ctx.passengers.length }, (_, i) => {
      const n = createHash('sha256').update(`${supplierReference}:${i}`).digest().readUIntBE(0, 6) % 10_000_000_000;
      return `999${String(n).padStart(10, '0')}`;
    });
    return { supplierReference, ticketNumbers: [...hold.tickets] };
  }

  async findIssuedTickets(ctx: BookingContext): Promise<IssuedTickets | null> {
    const tickets = this.holds.get(ctx.supplierReference)?.tickets ?? [];
    return tickets.length > 0 ? { supplierReference: ctx.supplierReference, ticketNumbers: [...tickets] } : null;
  }

  async cancel(ctx: BookingContext): Promise<CancelResult> {
    if (ctx.supplierReference.startsWith('sbx_')) this.holdFor(ctx.supplierReference).status = 'cancelled';
    return {};
  }

  async getFlightStatus(carrierCode: string, flightNumber: string, date: string): Promise<FlightStatus> {
    const leg = LEGS.find((l) => l.flightNumber === flightNumber.toUpperCase() && l.carrierCode === carrierCode.toUpperCase());
    const dated = leg ? datedLeg(leg, date) : null;
    if (!leg || !dated) {
      return { carrierCode, flightNumber, date, status: 'unknown', remarks: 'No sandbox flight operates with that number on that date.' };
    }
    const delayed = stableRandom(`status:${flightNumber}:${date}`) < 0.2;
    const estimated = new Date(dated.departUtc.getTime() + (delayed ? 45 : 0) * 60_000);
    return {
      carrierCode: leg.carrierCode,
      flightNumber: leg.flightNumber,
      date,
      status: delayed ? 'delayed' : 'scheduled',
      estimatedDeparture: toZonedIso(estimated, tzOf(leg.origin)),
      remarks: 'Sandbox status. Always confirm with the airline before travelling to the airport.',
    };
  }

  private toOffer(outLegs: DatedLeg[], criteria: FlightSearchCriteria, expiresAt: Date, returnLegs?: DatedLeg[]): FlightOffer {
    const legs = [...outLegs, ...(returnLegs ?? [])];
    const key = `${outLegs.map((l) => `${l.leg.flightNumber}@${l.date}`).join('|')}${returnLegs ? `<>${returnLegs.map((l) => `${l.leg.flightNumber}@${l.date}`).join('|')}` : ''}:${criteria.cabin}`;
    const variation = 0.85 + stableRandom(`fare:${key}`) * 0.4; // demand-driven ±20%
    const journeyFare = (j: DatedLeg[]) => j.reduce((sum, l) => sum + l.leg.baseFareCents, 0) * (j.length > 1 ? 0.92 : 1);
    // Like real airlines, a return ticket costs less than two one-way tickets.
    const perPax = (journeyFare(outLegs) + (returnLegs ? journeyFare(returnLegs) : 0)) * (returnLegs ? ROUND_TRIP_FACTOR : 1) * CABIN_MULTIPLIER[criteria.cabin] * variation;
    const taxesPerPaxCents = 6500 * legs.length;
    const adultFare = Math.round((perPax + taxesPerPaxCents) / 100) * 100;
    const mix = criteria.passengers;
    const round = (c: number) => Math.round(c / 100) * 100;
    const total = adultFare * mix.adults + round(adultFare * CHILD_FARE_SHARE) * mix.childAges.length + round(adultFare * INFANT_FARE_SHARE) * mix.infants;
    const international = legs.some((l) => !findAirportByCode(l.leg.origin)?.isDomestic || !findAirportByCode(l.leg.destination)?.isDomestic);
    const refundable = criteria.cabin !== 'economy' || stableRandom(`refund:${key}`) < 0.35;

    return {
      id: newId('off'),
      provider: this.name,
      segments: outLegs.map(toSegment),
      ...(returnLegs ? { returnSegments: returnLegs.map(toSegment) } : {}),
      cabin: criteria.cabin,
      passengers: passengerCount(mix),
      passengerMix: { adults: mix.adults, childAges: [...mix.childAges], infants: mix.infants },
      totalPrice: { amountCents: total, currency: 'USD' },
      baggage: { cabinPieces: 1, cabinKg: 7, checkedPieces: international || criteria.cabin !== 'economy' ? 2 : 1, checkedKgPerPiece: international ? 23 : 20 },
      fareRules: {
        refundable,
        refundPenaltyCents: refundable ? 5000 : 0,
        changeable: true,
        changePenaltyCents: criteria.cabin === 'economy' ? 4000 : 0,
      },
      // Infants sit on laps: they need no seat.
      seatsRemaining: 1 + Math.floor(stableRandom(`seats:${key}`) * 9),
      expiresAt: expiresAt.toISOString(),
    };
  }
}
