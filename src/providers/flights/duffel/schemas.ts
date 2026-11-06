import { z } from 'zod';

/**
 * The subset of Duffel API v2 responses BluckFlies relies on. Fields we do not
 * use are ignored; fields we use are validated, because supplier data is
 * untrusted input. Shapes follow https://duffel.com/docs/api (offer requests,
 * offers, orders, payments, order cancellations).
 */

const Place = z.object({ iata_code: z.string(), time_zone: z.string().nullish() });
const Carrier = z.object({ iata_code: z.string().nullish(), name: z.string() });

export const DuffelSegment = z.object({
  /** Local time at the airport, without offset, e.g. "2026-11-06T09:10:00". */
  departing_at: z.string(),
  arriving_at: z.string(),
  origin: Place,
  destination: Place,
  marketing_carrier: Carrier,
  marketing_carrier_flight_number: z.string(),
  operating_carrier: Carrier.nullish(),
  aircraft: z.object({ name: z.string() }).nullish(),
  passengers: z
    .array(
      z.object({
        passenger_id: z.string().nullish(),
        baggages: z.array(z.object({ type: z.string(), quantity: z.number().int() })).nullish(),
      }),
    )
    .nullish(),
});

const Condition = z
  .object({
    allowed: z.boolean(),
    penalty_amount: z.string().nullish(),
    penalty_currency: z.string().nullish(),
  })
  .nullish();

export const DuffelOffer = z.object({
  id: z.string(),
  total_amount: z.string(),
  total_currency: z.string(),
  expires_at: z.string(),
  owner: Carrier,
  passengers: z.array(z.object({ id: z.string(), type: z.string().nullish(), age: z.number().int().nullish() })),
  payment_requirements: z.object({
    requires_instant_payment: z.boolean(),
    payment_required_by: z.string().nullish(),
    price_guarantee_expires_at: z.string().nullish(),
  }),
  conditions: z.object({ refund_before_departure: Condition, change_before_departure: Condition }).nullish(),
  slices: z.array(z.object({ segments: z.array(DuffelSegment).min(1) })).min(1),
});
export type DuffelOffer = z.infer<typeof DuffelOffer>;

export const OfferRequestResponse = z.object({ data: z.object({ id: z.string(), offers: z.array(z.unknown()) }) });
export const OfferResponse = z.object({ data: DuffelOffer });

export const DuffelOrder = z.object({
  id: z.string(),
  booking_reference: z.string().nullish(),
  total_amount: z.string(),
  total_currency: z.string(),
  cancelled_at: z.string().nullish(),
  documents: z.array(z.object({ type: z.string(), unique_identifier: z.string() })).nullish(),
  payment_status: z
    .object({
      awaiting_payment: z.boolean(),
      payment_required_by: z.string().nullish(),
      price_guarantee_expires_at: z.string().nullish(),
    })
    .nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type DuffelOrder = z.infer<typeof DuffelOrder>;

export const OrderResponse = z.object({ data: DuffelOrder });
export const OrderListResponse = z.object({ data: z.array(DuffelOrder) });
export const PaymentResponse = z.object({ data: z.object({ id: z.string() }) });

export const OrderCancellation = z.object({
  id: z.string(),
  refund_amount: z.string().nullish(),
  refund_currency: z.string().nullish(),
  refund_to: z.string().nullish(),
  confirmed_at: z.string().nullish(),
});
export const OrderCancellationResponse = z.object({ data: OrderCancellation });

/** Webhook event envelope (https://duffel.com/docs/guides/receiving-webhooks). */
export const DuffelWebhookEvent = z.object({
  id: z.string(),
  type: z.string(),
  idempotency_key: z.string().nullish(),
  live_mode: z.boolean().nullish(),
  data: z.object({ object: z.record(z.string(), z.unknown()).nullish() }).nullish(),
});
