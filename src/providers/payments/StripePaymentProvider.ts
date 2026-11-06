import Stripe from 'stripe';
import { AppError } from '../../domain/errors.js';
import type { ChargeAmount } from '../../domain/types.js';
import type { Clock } from '../../lib/clock.js';
import { formatUsd } from '../../lib/money.js';
import type { PaymentProvider, PaymentRequestInput, PaymentRequestResult, ProviderEvent, RemotePaymentStatus, RemoteRefundStatus } from './PaymentProvider.js';

/**
 * Card payments (and wallets such as Apple Pay / Google Pay, as enabled in the
 * Stripe Dashboard) through Stripe Checkout, Stripe's hosted payment page.
 * Card details are entered only on Stripe's page, which keeps BluckFlies out
 * of PCI scope for card data.
 *
 * providerReference = Checkout Session ID (cs_…).
 */

/** The subset of the Stripe client this adapter uses; lets tests inject a fake. */
export interface StripeClientLike {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Checkout.Session>;
      retrieve(id: string): Promise<Stripe.Checkout.Session>;
      expire(id: string): Promise<Stripe.Checkout.Session>;
    };
  };
  refunds: {
    create(params: Stripe.RefundCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Refund>;
    retrieve(id: string): Promise<Stripe.Refund>;
  };
}

// Stripe accepts Checkout Session expiry between 30 minutes and 24 hours ahead.
const MIN_EXPIRY_SECONDS = 31 * 60;
const MAX_EXPIRY_SECONDS = 23 * 60 * 60 + 55 * 60;

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    maxNetworkRetries: 2, // safe: every mutating call carries an idempotency key
    timeout: 20_000,
    appInfo: { name: 'BluckFlies', version: '0.1.0' },
  });
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly chargeCurrency = 'USD';
  readonly needsPolling = false;
  readonly isSandbox = false;

  constructor(
    private readonly stripe: StripeClientLike,
    private readonly clock: Clock,
    private readonly publicBaseUrl: string,
  ) {}

  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    if (input.method !== 'card') throw new Error(`StripePaymentProvider does not handle ${input.method}`);
    if (input.charge.currency !== 'USD') throw new Error('Stripe charges are in USD');

    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const holdSeconds = Math.floor(input.expiresAt.getTime() / 1000);
    const expiresAt = Math.min(Math.max(holdSeconds, nowSeconds + MIN_EXPIRY_SECONDS), nowSeconds + MAX_EXPIRY_SECONDS);

    const ref = encodeURIComponent(input.merchantReference);
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: { currency: 'usd', unit_amount: input.charge.amountMinor, product_data: { name: input.description } },
          },
        ],
        client_reference_id: input.merchantReference,
        metadata: { pnr: input.merchantReference },
        payment_intent_data: { metadata: { pnr: input.merchantReference }, description: input.description },
        ...(input.payerEmail ? { customer_email: input.payerEmail } : {}),
        success_url: `${this.publicBaseUrl}/?payment=success&ref=${ref}`,
        cancel_url: `${this.publicBaseUrl}/?payment=cancelled&ref=${ref}`,
        expires_at: expiresAt,
        locale: 'auto',
      },
      { idempotencyKey: input.idempotencyKey },
    );

    if (!session.url) throw new AppError('UPSTREAM_UNAVAILABLE', 'The card payment page could not be created. Please try again.');
    const until = new Date(expiresAt * 1000).toISOString();
    return {
      providerReference: session.id,
      checkoutUrl: session.url,
      approvalInstructions: `Pay ${formatUsd(input.amount)} by card on Stripe's secure page (link valid until ${until}). Card details are entered only on Stripe, never in chat.`,
    };
  }

  async cancelPaymentRequest(providerReference: string): Promise<void> {
    try {
      await this.stripe.checkout.sessions.expire(providerReference);
    } catch {
      // Already completed or expired. A late payment is refunded by PaymentService.
    }
  }

  async requestRefund(providerReference: string, amount: ChargeAmount, idempotencyKey: string): Promise<{ refundReference: string }> {
    if (amount.currency !== 'USD') throw new Error('Stripe refunds are in USD');
    const session = await this.stripe.checkout.sessions.retrieve(providerReference);
    const pi = session.payment_intent;
    const paymentIntentId = typeof pi === 'string' ? pi : pi?.id;
    if (!paymentIntentId) throw new Error(`Checkout Session ${providerReference} has no PaymentIntent to refund`);
    const refund = await this.stripe.refunds.create(
      { payment_intent: paymentIntentId, amount: amount.amountMinor, metadata: { provider_reference: providerReference } },
      { idempotencyKey },
    );
    return { refundReference: refund.id };
  }

  async getPaymentStatus(providerReference: string): Promise<RemotePaymentStatus> {
    const s = await this.stripe.checkout.sessions.retrieve(providerReference);
    if (s.payment_status === 'paid') {
      return { state: 'paid', amount: { amountMinor: s.amount_total ?? -1, currency: (s.currency ?? '').toUpperCase() } };
    }
    return s.status === 'expired' ? { state: 'expired' } : { state: 'open' };
  }

  async getRefundStatus(refundReference: string): Promise<RemoteRefundStatus> {
    const r = await this.stripe.refunds.retrieve(refundReference);
    if (r.status === 'succeeded') return 'succeeded';
    if (r.status === 'failed' || r.status === 'canceled') return 'failed';
    return 'pending';
  }
}

/**
 * Maps a *verified* Stripe event to a provider-agnostic event, or null for
 * events BluckFlies does not act on.
 */
export function mapStripeEvent(event: Stripe.Event): ProviderEvent | null {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const s = event.data.object;
      // "completed" with payment_status "unpaid" means a delayed method; wait for async_payment_*.
      if (s.payment_status !== 'paid') return null;
      return {
        eventId: event.id,
        kind: 'payment.succeeded',
        providerReference: s.id,
        // Compared with the expected charge (amount AND currency) before ticketing.
        amount: { amountMinor: s.amount_total ?? -1, currency: (s.currency ?? '').toUpperCase() },
      };
    }
    case 'checkout.session.async_payment_failed':
      return { eventId: event.id, kind: 'payment.failed', providerReference: event.data.object.id, reason: 'async_payment_failed' };
    case 'checkout.session.expired':
      return { eventId: event.id, kind: 'payment.failed', providerReference: event.data.object.id, reason: 'checkout_expired' };
    case 'refund.created':
    case 'refund.updated': {
      const r = event.data.object;
      const ref = r.metadata?.['provider_reference'];
      if (r.status !== 'succeeded' || !ref) return null;
      return { eventId: event.id, kind: 'refund.succeeded', providerReference: ref };
    }
    default:
      return null;
  }
}
