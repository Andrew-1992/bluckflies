import { isAppError } from '../domain/errors.js';
import type { ContactDetails, Passenger } from '../domain/types.js';
import type { Logger } from '../lib/logger.js';
import type { FlightProvider } from '../providers/flights/FlightProvider.js';
import type { BookingService } from '../services/BookingService.js';
import type { ConfirmationService } from '../services/ConfirmationService.js';
import type { FlightSearchService } from '../services/FlightSearchService.js';
import type { PaymentService } from '../services/PaymentService.js';
import type { FxService } from '../services/FxService.js';
import type { SupportService } from '../services/SupportService.js';
import type { TravelInfoService } from '../services/TravelInfoService.js';
import { resolvePlaces } from '../data/airports.js';
import { isToolName, ToolSchemas, type ToolInput, type ToolName } from './tools.js';

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** The handler's structured result on success (what `content` serialises), for callers that render it. */
  result?: unknown;
}

export interface ToolDeps {
  search: FlightSearchService;
  bookings: BookingService;
  payments: PaymentService;
  confirmations: ConfirmationService;
  travelInfo: TravelInfoService;
  support: SupportService;
  flights: FlightProvider;
  fx: FxService;
  log: Logger;
}

const toPassenger = (p: ToolInput<'propose_reservation'>['passengers'][number]): Passenger => ({
  type: p.type,
  givenName: p.given_name,
  familyName: p.family_name,
  gender: p.gender,
  dateOfBirth: p.date_of_birth,
  nationality: p.nationality,
  ...(p.passport_number ? { passportNumber: p.passport_number.toUpperCase() } : {}),
  ...(p.passport_expiry ? { passportExpiry: p.passport_expiry } : {}),
});

/**
 * Executes model tool calls on behalf of exactly one session. The session ID
 * comes from the authenticated request, never from model input, so the model
 * cannot reach another traveller's data.
 */
export class ToolExecutor {
  constructor(private readonly deps: ToolDeps) {}

  async execute(sessionId: string, name: string, rawInput: unknown): Promise<ToolOutcome> {
    if (!isToolName(name)) return { content: JSON.stringify({ error: 'UNKNOWN_TOOL', message: `No tool named ${name}.` }), isError: true };

    const parsed = ToolSchemas[name].input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
      return { content: JSON.stringify({ error: 'INVALID_INPUT', issues }), isError: true };
    }

    try {
      const result = await this.run(sessionId, name, parsed.data);
      return { content: JSON.stringify(result), isError: false, result };
    } catch (err) {
      if (isAppError(err)) {
        return { content: JSON.stringify({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }), isError: true };
      }
      this.deps.log.error('tool.unexpected_error', { tool: name, err: err instanceof Error ? err.message : String(err) });
      return { content: JSON.stringify({ error: 'INTERNAL', message: 'Something went wrong on our side. Apologise and offer to try again or hand off to a human agent.' }), isError: true };
    }
  }

  private readonly handlers: { [N in ToolName]: (sessionId: string, input: ToolInput<N>) => Promise<unknown> } = {
    find_airports: async (_sid, { query }) => ({
      matches: resolvePlaces(query).map(({ airport: a, viaTown }) => ({
        code: a.iata,
        name: a.name,
        city: a.city,
        country: a.country,
        domestic: a.isDomestic,
        ...(a.notes ? { notes: a.notes } : {}),
        ...(viaTown ? { via_town: viaTown.name, road_note: `${viaTown.name} has no airstrip of its own: fly to ${a.city}, then continue by road.` } : {}),
      })),
    }),
    search_flights: (sid, i) =>
      this.deps.search.search(sid, {
        origin: i.origin,
        destination: i.destination,
        departureDate: i.departure_date,
        ...(i.return_date ? { returnDate: i.return_date } : {}),
        passengers: { adults: i.adults, childAges: i.child_ages, infants: i.infants },
        cabin: i.cabin,
        maxStops: i.max_stops,
        sortBy: i.sort_by,
      }),
    get_offer_details: async (sid, { offer_id }) => {
      const offer = await this.deps.search.getOffer(sid, offer_id);
      return { ...(await this.deps.search.describe(offer)), fareRules: offer.fareRules };
    },
    propose_reservation: async (sid, i) => {
      const contact: ContactDetails = { phone: i.contact_phone, email: i.contact_email, language: i.contact_language };
      const c = await this.deps.confirmations.proposeReservation(sid, i.offer_id, i.passengers.map(toPassenger), contact);
      return { ...c, nextStep: 'Ask the traveller to review the summary and tap Confirm in the app. Nothing is reserved until they do.' };
    },
    get_booking: async (sid, { reference }) => {
      const view = await this.deps.bookings.view(sid, reference);
      const payment = await this.deps.payments.latestForBooking(view.bookingId);
      return { ...view, ...(payment ? { payment: this.deps.payments.toView(payment) } : {}) };
    },
    list_my_bookings: async (sid) => ({ bookings: await this.deps.bookings.list(sid) }),
    request_payment: async (sid, i) => {
      const booking = await this.deps.bookings.getOwned(sid, i.reference);
      return this.deps.payments.initiate(booking, i.method, i.payer_phone);
    },
    get_payment_options: async () => {
      const methods = this.deps.payments.availableMethods();
      const ssp = await this.deps.fx.current('SSP');
      let sspCharging: string;
      try {
        await this.deps.fx.quoteForCharge('SSP');
        sspCharging = 'available';
      } catch (err) {
        sspCharging = err instanceof Error ? err.message : 'paused';
      }
      return {
        methods,
        sspExchangeRate: ssp ? { perUsd: ssp.perUsd, asOf: ssp.asOf, source: ssp.source } : null,
        sspCharging,
      };
    },
    propose_cancellation: async (sid, { reference }) => {
      const c = await this.deps.confirmations.proposeCancellation(sid, reference);
      return { ...c, nextStep: 'Ask the traveller to tap Confirm in the app to cancel.' };
    },
    get_flight_status: (_sid, i) => {
      const fn = i.flight_number.toUpperCase();
      return this.deps.flights.getFlightStatus(fn.slice(0, 2), fn, i.date);
    },
    get_travel_info: async (_sid, i) => this.deps.travelInfo.info(i.topic, i.airport_code),
    handoff_to_human: async (sid, i) => {
      // Only the traveller's own booking can be attached (getOwned throws NOT_FOUND otherwise).
      const booking = i.booking_reference ? await this.deps.bookings.getOwned(sid, i.booking_reference) : undefined;
      const t = await this.deps.support.open(sid, i.reason, i.summary, { bookingId: booking?.id });
      return { ...t, message: 'A BluckFlies agent will contact the traveller on their booking phone number, usually within working hours the same day.' };
    },
  };

  private run<N extends ToolName>(sessionId: string, name: N, input: ToolInput<N>): Promise<unknown> {
    return this.handlers[name](sessionId, input);
  }
}
