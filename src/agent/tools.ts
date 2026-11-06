import { z } from 'zod';

/**
 * Tool contracts exposed to the model. Zod is the single source of truth: the
 * same schema produces the JSON Schema the model sees and validates the input
 * the model sends back, because model output is untrusted input.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +211912345678');

const PassengerInput = z.object({
  type: z.enum(['adult', 'child', 'infant']).describe('adult 12+, child 2–11, infant under 2 on the travel date'),
  given_name: z.string().trim().min(1).max(60).describe('Latin letters exactly as printed on the passport or national ID'),
  family_name: z.string().trim().min(1).max(60).describe('Latin letters exactly as printed on the passport or national ID'),
  gender: z.enum(['m', 'f']).describe('As shown on the travel document'),
  date_of_birth: IsoDate,
  nationality: z.string().regex(/^[A-Z]{2}$/).describe('ISO 3166-1 alpha-2, e.g. SS, KE, UG'),
  passport_number: z.string().trim().min(5).max(20).optional().describe('Required for international itineraries'),
  passport_expiry: IsoDate.optional(),
});

export const ToolSchemas = {
  find_airports: {
    description: 'Resolve a city or airport name (English or Arabic) to airport codes served by BluckFlies. South Sudan airstrips use 4-letter ICAO codes (e.g. HSBR for Bor). A match with via_town means the traveller named a town without an airstrip: tell them they will fly to the matched airport and continue by road.',
    input: z.object({ query: z.string().min(1).max(80) }),
  },
  search_flights: {
    description:
      'Search flights. For a return trip, set return_date: offers then cover both directions, priced together by the airline (usually cheaper than two one-way fares), and are booked once with one booking code. Each such offer has a "return" journey. Returns ranked offers with offer_id values; only these offers may be presented as available.',
    input: z.object({
      origin: z.string().min(2).max(80).describe('Airport code (3-letter IATA or 4-letter ICAO airstrip code) or town name'),
      destination: z.string().min(2).max(80),
      departure_date: IsoDate,
      return_date: IsoDate.optional().describe('Round trip only: date of the flight back from the destination'),
      adults: z.number().int().min(1).max(9).default(1).describe('Travellers aged 12+ on the travel date'),
      child_ages: z.array(z.number().int().min(2).max(11)).max(8).default([]).describe('Age on the travel date of each child aged 2–11'),
      infants: z.number().int().min(0).max(4).default(0).describe('Babies under 2, on an adult\'s lap'),
      cabin: z.enum(['economy', 'premium_economy', 'business', 'first']).default('economy'),
      max_stops: z.number().int().min(0).max(1).default(1),
      sort_by: z.enum(['best', 'cheapest', 'fastest']).default('best'),
    }),
  },
  get_offer_details: {
    description: 'Get full details (segments, baggage, fare rules) of an offer from a previous search.',
    input: z.object({ offer_id: z.string().min(1).max(100) }),
  },
  propose_reservation: {
    description:
      'Propose holding seats on an offer for the given passengers. This does NOT reserve anything: it shows the traveller a Confirm button in the app, and only their tap creates the hold. Collect and read back all passenger details first.',
    input: z.object({
      offer_id: z.string().min(1).max(100),
      passengers: z.array(PassengerInput).min(1).max(9),
      contact_phone: Phone,
      contact_email: z.email().describe('E-tickets and airline notices are sent here'),
      contact_language: z.enum(['en', 'ar']).default('en').describe('Language for the e-ticket email and SMS: the language the traveller writes or speaks in (Arabic, including Juba Arabic, is "ar")'),
    }),
  },
  get_booking: {
    description: 'Look up one of the traveller\'s bookings by PNR (6 characters) or booking ID.',
    input: z.object({ reference: z.string().min(6).max(100) }),
  },
  list_my_bookings: {
    description: 'List bookings made in this session.',
    input: z.object({}),
  },
  request_payment: {
    description:
      'Send a payment request for a held booking. "card" returns a secure hosted payment link (checkoutUrl) for a Visa or Mastercard bank card, charged in USD. "bank_transfer" returns bank account details: the traveller pays in USD by transfer or cash deposit at a branch with the booking code as reference, and staff confirm it. "cash_office" returns the BluckFlies offices and partner agents that take USD cash; staff confirm with a receipt number. Bank and cash need enough time left on the seat hold, otherwise the request is refused and card is the option. Mobile money sends an approval prompt to the phone, charged in SSP at a rate locked now (the result shows the SSP amount and rate). Never ask for PINs or card numbers.',
    input: z.object({
      reference: z.string().min(6).max(100),
      method: z
        .enum(['card', 'bank_transfer', 'cash_office', 'mtn_momo', 'zain_mgurush'])
        .describe('card = Visa/Mastercard bank card (including cards from South Sudanese banks); bank_transfer = transfer or branch deposit in USD; cash_office = USD cash at a BluckFlies office or partner agent'),
      payer_phone: Phone.describe('Phone that receives the payment prompt or card link'),
    }),
  },
  get_payment_options: {
    description:
      'List the payment methods available right now, the currency each charges in (USD for card, bank transfer and office cash; SSP for mobile money) and the current SSP exchange rate. Call before offering payment methods.',
    input: z.object({}),
  },
  propose_cancellation: {
    description:
      'Propose cancelling a booking. Explains the refund outcome and shows the traveller a Confirm button; only their tap cancels.',
    input: z.object({ reference: z.string().min(6).max(100) }),
  },
  get_flight_status: {
    description: 'Get the operational status of a flight on a date.',
    input: z.object({
      flight_number: z.string().regex(/^[A-Z0-9]{2}\d{1,4}$/i, 'e.g. XN101'),
      date: IsoDate,
    }),
  },
  get_travel_info: {
    description: 'Get curated guidance on entry requirements, baggage, airports, payments or check-in.',
    input: z.object({
      topic: z.enum(['entry_requirements', 'baggage', 'airport', 'payments', 'check_in']),
      airport_code: z.string().min(3).max(4).optional(),
    }),
  },
  handoff_to_human: {
    description:
      'Escalate to a human BluckFlies agent: complaints, special assistance (wheelchair, medical, unaccompanied minors), group bookings over 9, changes the tools cannot do, or when the traveller asks for a person.',
    input: z.object({
      reason: z.enum(['complaint', 'special_assistance', 'group_booking', 'change_request', 'payment_issue', 'traveller_request', 'other']),
      summary: z.string().min(10).max(1000).describe('Context for the human agent. Do not include passport numbers.'),
      booking_reference: z.string().min(6).max(100).optional().describe('PNR of the booking this is about (required for change requests on an existing booking)'),
    }),
  },
} as const;

export type ToolName = keyof typeof ToolSchemas;
export type ToolInput<N extends ToolName> = z.infer<(typeof ToolSchemas)[N]['input']>;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties?: unknown; required?: string[]; [k: string]: unknown };
}

export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(ToolSchemas) as ToolName[]).map((name) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(ToolSchemas[name].input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: ToolSchemas[name].description, input_schema: { ...schema, type: 'object' } };
  });
}

export const isToolName = (name: string): name is ToolName => Object.hasOwn(ToolSchemas, name);
