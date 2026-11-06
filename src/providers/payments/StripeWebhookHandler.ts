import type Stripe from 'stripe';
import { AppError } from '../../domain/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { PaymentService } from '../../services/PaymentService.js';
import { mapStripeEvent } from './StripePaymentProvider.js';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export interface StripeWebhookVerifier {
  constructEvent(payload: string | Buffer, header: string, secret: string): Stripe.Event;
}

/**
 * Verifies Stripe's signature (HMAC over timestamp + raw body, default
 * 5-minute tolerance) with the official SDK, then hands a normalised event to
 * PaymentService. Unhandled event types are acknowledged so Stripe stops retrying.
 */
export class StripeWebhookHandler {
  constructor(
    private readonly verifier: StripeWebhookVerifier,
    private readonly secret: string,
    private readonly payments: PaymentService,
    private readonly log: Logger,
    /** In production, test-mode events are acknowledged but never applied. */
    private readonly acceptTestEvents: boolean,
  ) {}

  async handle(rawBody: Buffer, signature: string | undefined): Promise<{ status: 'processed' | 'duplicate' | 'ignored' }> {
    if (!signature) throw new AppError('UNAUTHENTICATED', 'Missing Stripe signature.');
    let event: Stripe.Event;
    try {
      event = this.verifier.constructEvent(rawBody, signature, this.secret);
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Invalid Stripe signature.');
    }

    if (!event.livemode && !this.acceptTestEvents) {
      this.log.warn('stripe.test_event_ignored', { eventId: event.id });
      return { status: 'ignored' };
    }

    const mapped = mapStripeEvent(event);
    if (!mapped) {
      if (event.type === 'refund.failed') this.log.error('stripe.refund_failed', { eventId: event.id, refundId: event.data.object.id });
      return { status: 'ignored' };
    }
    return this.payments.applyEvent(mapped);
  }
}
