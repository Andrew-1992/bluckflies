import Stripe from 'stripe';
import type { StripeClientLike } from '../../src/providers/payments/StripePaymentProvider.js';

/** Real SDK, used offline only for webhook signing/verification. */
export const stripeSdk = new Stripe('sk_test_offline');
export const STRIPE_WHSEC = 'whsec_testsecret123';
export const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_bluckflies123', STRIPE_WEBHOOK_SECRET: STRIPE_WHSEC };

interface FakeSession {
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  amount_total: number;
  currency: string;
}

/**
 * In-process stand-in for Stripe's API. Records calls, and lets a test change
 * what Stripe "knows" (e.g. a session paid but the webhook never arrived).
 */
export class FakeStripe implements StripeClientLike {
  created: Array<{ params: Stripe.Checkout.SessionCreateParams; options?: Stripe.RequestOptions }> = [];
  expired: string[] = [];
  refundCalls: Array<{ params: Stripe.RefundCreateParams; options?: Stripe.RequestOptions }> = [];
  readonly sessions = new Map<string, FakeSession>();
  refundStatus: Stripe.Refund['status'] = 'pending';

  /** Simulates the traveller paying on Stripe without our webhook being delivered. */
  markPaid(id: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    Object.assign(s, { status: 'complete', payment_status: 'paid' });
  }

  checkout = {
    sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams, options?: Stripe.RequestOptions) => {
        this.created.push({ params, ...(options ? { options } : {}) });
        const id = `cs_test_${this.created.length}`;
        const item = params.line_items?.[0]?.price_data;
        this.sessions.set(id, { status: 'open', payment_status: 'unpaid', amount_total: item?.unit_amount ?? 0, currency: item?.currency ?? 'usd' });
        return { id, url: `https://checkout.stripe.com/c/pay/${id}` } as Stripe.Checkout.Session;
      },
      retrieve: async (id: string) => {
        const s = this.sessions.get(id);
        return { id, payment_intent: `pi_for_${id}`, ...(s ?? {}) } as Stripe.Checkout.Session;
      },
      expire: async (id: string) => {
        this.expired.push(id);
        const s = this.sessions.get(id);
        if (s && s.status === 'open') s.status = 'expired';
        return { id } as Stripe.Checkout.Session;
      },
    },
  };

  refunds = {
    create: async (params: Stripe.RefundCreateParams, options?: Stripe.RequestOptions) => {
      this.refundCalls.push({ params, ...(options ? { options } : {}) });
      return { id: `re_${this.refundCalls.length}` } as Stripe.Refund;
    },
    retrieve: async (id: string) => ({ id, status: this.refundStatus }) as Stripe.Refund,
  };
}
