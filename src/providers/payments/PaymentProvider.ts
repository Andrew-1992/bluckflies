import type { ChargeAmount, Money, PaymentMethod } from '../../domain/types.js';

export interface PaymentRequestInput {
  method: PaymentMethod;
  /** Booking value in USD (for descriptions). */
  amount: Money;
  /** What to collect, in the provider's charge currency. */
  charge: ChargeAmount;
  /** E.164 phone that receives the mobile-money prompt or the payment-link SMS. */
  payerPhone: string;
  payerEmail?: string;
  /** Our booking reference (PNR), echoed back by the provider. */
  merchantReference: string;
  /** Human-readable line item, e.g. "Flight JUB → NBO, 6 Nov 2026". */
  description: string;
  /** First departure, ISO 8601 with offset (some providers record the service date). */
  travelDate?: string;
  /** The request must not be payable after this instant (the seat hold expiry). */
  expiresAt: Date;
  /** Sent to the provider so a retried request never creates a second charge. */
  idempotencyKey: string;
}

export interface PaymentRequestResult {
  providerReference: string;
  approvalInstructions: string;
  /** Hosted payment page the traveller opens (card payments). */
  checkoutUrl?: string;
}

/**
 * Payment boundary (Stripe, mobile money aggregators). The traveller approves
 * every charge on their own device or the provider's hosted page; the agent
 * never handles PINs or card numbers. Final status arrives only via verified
 * webhooks, normalised to `ProviderEvent`.
 */
export interface PaymentProvider {
  readonly name: string;
  /** Currency this provider collects in ("USD" for cards, "SSP" for South Sudanese wallets). */
  readonly chargeCurrency: string;
  /** True if status must be polled (no trustworthy webhooks), e.g. MTN MoMo. */
  readonly needsPolling: boolean;
  /** True for simulated providers that must never be used in production. */
  readonly isSandbox: boolean;
  createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult>;
  /** Makes an unpaid request unpayable (booking cancelled or hold expired). Best effort. */
  cancelPaymentRequest(providerReference: string): Promise<void>;
  /** Throws RefundRequiresManualError when the provider cannot refund automatically. */
  requestRefund(providerReference: string, amount: ChargeAmount, idempotencyKey: string): Promise<{ refundReference: string }>;
  /** Authoritative status, used by reconciliation when a webhook may have been missed. */
  getPaymentStatus(providerReference: string): Promise<RemotePaymentStatus>;
  getRefundStatus(refundReference: string): Promise<RemoteRefundStatus>;
}

export type RemotePaymentStatus =
  | { state: 'paid'; amount: ChargeAmount }
  | { state: 'open' }
  | { state: 'expired' }
  /** Provider cannot be queried (e.g. sandbox): reconciliation skips it. */
  | { state: 'unknown' };

export type RemoteRefundStatus = 'succeeded' | 'pending' | 'failed' | 'unknown';

/** Provider-agnostic, already-verified webhook event. */
export interface ProviderEvent {
  eventId: string;
  kind: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
  providerReference: string;
  /** Present for payment events; compared against the expected charge before ticketing. */
  amount?: ChargeAmount;
  reason?: string;
}

/** The provider cannot refund automatically (no refund API, or not enabled): a person must. */
export class RefundRequiresManualError extends Error {
  constructor(message = 'Automatic refunds are not available for this payment method') {
    super(message);
    this.name = 'RefundRequiresManualError';
  }
}

/** Routes each payment method to the provider that serves it. */
export class PaymentGateway {
  private readonly byProviderName = new Map<string, PaymentProvider>();

  /**
   * Methods without a provider are unavailable (e.g. no real provider in production).
   * `additional` providers serve no method but stay reachable by name, e.g. a
   * previous card provider whose payments may still need refunds.
   */
  constructor(
    private readonly routes: Readonly<Partial<Record<PaymentMethod, PaymentProvider>>>,
    additional: readonly PaymentProvider[] = [],
  ) {
    for (const p of [...additional, ...Object.values(routes)]) if (p) this.byProviderName.set(p.name, p);
  }

  forMethod(method: PaymentMethod): PaymentProvider | undefined {
    return this.routes[method];
  }

  availableMethods(): PaymentMethod[] {
    return (Object.keys(this.routes) as PaymentMethod[]).filter((m) => this.routes[m]);
  }

  /** Providers whose payments must be polled for status. */
  pollingProviders(): string[] {
    return [...this.byProviderName.values()].filter((p) => p.needsPolling).map((p) => p.name);
  }

  /** Distinct provider names, e.g. for reconciliation. */
  providerNames(): string[] {
    return [...this.byProviderName.keys()];
  }

  /** Refunds and cancellations must go to the provider that took the payment. */
  byName(name: string): PaymentProvider {
    const p = this.byProviderName.get(name);
    if (!p) throw new Error(`No payment provider registered as "${name}"`);
    return p;
  }
}
