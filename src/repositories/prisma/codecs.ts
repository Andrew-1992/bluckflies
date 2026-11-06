import { z } from 'zod';
import type {
  ContactDetails,
  FlightOffer,
  IataCode,
  Passenger,
  PendingConfirmation,
} from '../../domain/types.js';

/**
 * Runtime schemas for JSON read back from the database. Stored JSON is
 * untrusted at the type level (schema drift, manual edits, old rows), so it is
 * validated rather than cast. `satisfies` keeps each schema in step with the
 * domain type at compile time.
 */

const Iata = z.custom<IataCode>((v) => typeof v === 'string' && /^[A-Z]{3,4}$/.test(v), 'Expected IATA or ICAO airport code');

/** Drops keys whose value is undefined (domain types use exact optional properties). */
function compact<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

const BaggageSchema = z
  .object({
    cabinPieces: z.number().int().nonnegative(),
    cabinKg: z.number().optional(),
    checkedPieces: z.number().int().nonnegative(),
    checkedKgPerPiece: z.number().optional(),
  })
  .transform(compact);

const SupplierSchema = z
  .object({
    offerId: z.string(),
    passengerIds: z.array(z.string()),
    requiresInstantPayment: z.boolean(),
    ownerName: z.string().optional(),
  })
  .transform(compact);

const SegmentSchema = z.object({
  carrierCode: z.string(),
  carrierName: z.string(),
  flightNumber: z.string(),
  origin: Iata,
  destination: Iata,
  departureTime: z.string(),
  arrivalTime: z.string(),
  durationMinutes: z.number().int(),
  aircraft: z.string(),
});

export const FlightOfferSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    segments: z.array(SegmentSchema),
    returnSegments: z.array(SegmentSchema).min(1).optional(),
    cabin: z.enum(['economy', 'premium_economy', 'business', 'first']),
    passengers: z.number().int().positive(),
    passengerMix: z.object({
      adults: z.number().int().nonnegative(),
      childAges: z.array(z.number().int().min(2).max(11)),
      infants: z.number().int().nonnegative(),
    }),
    totalPrice: z.object({ amountCents: z.number().int().nonnegative(), currency: z.literal('USD') }),
    baggage: BaggageSchema,
    fareRules: z.object({
      refundable: z.boolean(),
      refundPenaltyCents: z.number().int(),
      changeable: z.boolean(),
      changePenaltyCents: z.number().int(),
    }),
    seatsRemaining: z.number().int().optional(),
    expiresAt: z.string(),
    supplier: SupplierSchema.optional(),
  })
  .transform((o): FlightOffer => compact(o)) satisfies z.ZodType<FlightOffer, unknown>;

// Optional fields are rebuilt without `undefined` values, because the domain
// types use exact optional properties (absent, never present-but-undefined).
export const PassengerSchema = z
  .object({
    type: z.enum(['adult', 'child', 'infant']),
    givenName: z.string(),
    familyName: z.string(),
    gender: z.enum(['m', 'f']),
    dateOfBirth: z.string(),
    nationality: z.string(),
    passportNumber: z.string().optional(),
    passportExpiry: z.string().optional(),
  })
  .transform((p): Passenger => compact(p)) satisfies z.ZodType<Passenger, unknown>;

export const PassengersSchema = z.array(PassengerSchema);

export const ContactSchema = z
  .object({ phone: z.string(), email: z.string(), language: z.enum(['en', 'ar']).optional() })
  .transform((c): ContactDetails => compact(c)) satisfies z.ZodType<ContactDetails, unknown>;

export const ConfirmationPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_reservation'), offerId: z.string(), passengers: PassengersSchema, contact: ContactSchema }),
  z.object({ kind: z.literal('cancel_booking'), bookingId: z.string() }),
]) satisfies z.ZodType<PendingConfirmation['payload'], unknown>;

export const MessagesSchema = z.array(z.unknown());

/**
 * Removes keys whose value is `undefined`: domain objects use optional
 * properties, and Prisma JSON input rejects undefined values.
 */
export function toJsonValue(value: unknown): JsonValue {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return JsonValueSchema.parse(parsed);
}

export type JsonValue = string | number | boolean | { [k: string]: JsonValue } | JsonValue[];
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);
