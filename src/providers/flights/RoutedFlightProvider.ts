import { findAirportByCode } from '../../data/airports.js';
import { isAirstripCode, type FlightOffer, type FlightSearchCriteria } from '../../domain/types.js';
import type { BookingContext, CancelResult, FlightProvider, FlightStatus, HoldResult, IssuedTickets } from './FlightProvider.js';

/**
 * Sends searches to the right supplier and every later step (hold, ticketing,
 * cancellation) back to the supplier that sold the offer (`offer.provider`).
 *
 * `domestic` (optional) serves routes entirely within South Sudan, which the
 * primary supplier does not cover. Configuration forbids a sandbox here in
 * production, so generated flights are never sold for real.
 */
export class RoutedFlightProvider implements FlightProvider {
  readonly name = 'routed';
  readonly isSandbox: boolean;
  private readonly byName: Map<string, FlightProvider>;

  constructor(
    private readonly primary: FlightProvider,
    private readonly domestic?: FlightProvider,
  ) {
    this.isSandbox = primary.isSandbox || Boolean(domestic?.isSandbox);
    this.byName = new Map([primary, ...(domestic ? [domestic] : [])].map((p) => [p.name, p]));
  }

  private isDomesticRoute(c: FlightSearchCriteria): boolean {
    return Boolean(findAirportByCode(c.origin)?.isDomestic && findAirportByCode(c.destination)?.isDomestic);
  }

  private forOffer(offer: FlightOffer): FlightProvider {
    const p = this.byName.get(offer.provider);
    if (!p) throw new Error(`No flight provider registered as "${offer.provider}"`);
    return p;
  }

  search(criteria: FlightSearchCriteria, offerExpiresAt: Date): Promise<FlightOffer[]> {
    if (this.domestic && this.isDomesticRoute(criteria)) return this.domestic.search(criteria, offerExpiresAt);
    // Airline-booking APIs know only IATA codes; airstrip (ICAO) routes have no
    // online inventory there, so the search reports none and an agent takes over.
    if (isAirstripCode(criteria.origin) || isAirstripCode(criteria.destination)) return Promise.resolve([]);
    return this.primary.search(criteria, offerExpiresAt);
  }
  revalidate(offer: FlightOffer): Promise<FlightOffer | null> {
    return this.forOffer(offer).revalidate(offer);
  }
  hold(ctx: Omit<BookingContext, 'supplierReference'>): Promise<HoldResult> {
    return this.forOffer(ctx.offer).hold(ctx);
  }
  issueTickets(ctx: BookingContext): Promise<IssuedTickets> {
    return this.forOffer(ctx.offer).issueTickets(ctx);
  }
  findIssuedTickets(ctx: BookingContext): Promise<IssuedTickets | null> {
    return this.forOffer(ctx.offer).findIssuedTickets(ctx);
  }
  cancel(ctx: BookingContext): Promise<CancelResult> {
    return this.forOffer(ctx.offer).cancel(ctx);
  }
  async getFlightStatus(carrierCode: string, flightNumber: string, date: string): Promise<FlightStatus> {
    for (const p of this.byName.values()) {
      const s = await p.getFlightStatus(carrierCode, flightNumber, date);
      if (s.status !== 'unknown') return s;
    }
    return this.primary.getFlightStatus(carrierCode, flightNumber, date);
  }
}
