import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import type { ChargeAmount } from '../../../domain/types.js';
import { formatCharge } from '../../../lib/fx.js';
import type { Logger } from '../../../lib/logger.js';
import { maskPhone } from '../SandboxPaymentProvider.js';
import {
  RefundRequiresManualError,
  type PaymentProvider,
  type PaymentRequestInput,
  type PaymentRequestResult,
  type RemotePaymentStatus,
  type RemoteRefundStatus,
} from '../PaymentProvider.js';
import { MomoApiError, type MomoClient } from './MomoClient.js';

/**
 * MTN MoMo via the Open API: Collection "request to pay" for payments,
 * Disbursement "transfer" for refunds.
 *
 * Idempotency: MTN treats `X-Reference-Id` as an idempotency key; reusing it
 * returns 409 RESOURCE_ALREADY_EXIST instead of charging again. We derive the
 * reference from our own idempotency key, so any retry of the same attempt
 * (after a timeout, a crash, or a double click) can never create a second
 * charge. A 409 means "already accepted", not "paid": status is always read
 * back from MTN.
 *
 * MTN callbacks are not signed and are not always delivered, so they are only
 * used as a hint to poll sooner (see the /api/webhooks/momo route).
 */

const TransactionStatus = z.object({
  amount: z.union([z.string(), z.number()]).transform(String),
  currency: z.string(),
  status: z.enum(['PENDING', 'SUCCESSFUL', 'FAILED']),
  financialTransactionId: z.string().nullish(),
  externalId: z.string().nullish(),
  payer: z.object({ partyIdType: z.string(), partyId: z.string() }).nullish(),
  reason: z.union([z.string(), z.object({ code: z.string().nullish(), message: z.string().nullish() })]).nullish(),
});

/** Payer errors that a different number or wallet top-up would fix. */
const PAYER_ERRORS: Record<string, string> = {
  PAYER_NOT_FOUND: 'This phone number is not registered for MTN MoMo.',
  PAYEE_NOT_FOUND: 'This phone number is not registered for MTN MoMo.',
  NOT_ALLOWED: 'This MTN MoMo account cannot make this payment.',
  NOT_ALLOWED_TARGET_ENVIRONMENT: 'MTN MoMo payments are not available right now.',
  INVALID_CALLBACK_URL_HOST: 'MTN MoMo payments are not available right now.',
  INVALID_CURRENCY: 'MTN MoMo payments are not available right now.',
};

/** Deterministic RFC 4122 v4-format UUID from a stable key (MTN requires UUIDs). */
export function referenceIdFor(key: string): string {
  const h = createHash('sha256').update(`bluckflies:momo:${key}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x40; // version 4
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** MTN amounts are decimal strings in major units: 147200000 minor → "1472000". */
export function toMomoAmount(c: ChargeAmount): string {
  const whole = Math.floor(c.amountMinor / 100);
  const frac = c.amountMinor % 100;
  return frac ? `${whole}.${String(frac).padStart(2, '0')}` : String(whole);
}

export function fromMomoAmount(amount: string, currency: string): ChargeAmount {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return { amountMinor: -1, currency }; // forces an amount mismatch rather than a guess
  return { amountMinor: Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')), currency };
}

const msisdn = (e164: string) => e164.replace(/^\+/, '');

export interface MomoProviderOptions {
  currency: string;
  /** Public HTTPS URL MTN may call when a request completes (a hint only). */
  callbackUrl?: string;
  log: Logger;
}

export class MomoPaymentProvider implements PaymentProvider {
  readonly name = 'mtn_momo';
  readonly chargeCurrency: string;
  readonly needsPolling = true;
  readonly isSandbox = false;

  constructor(
    private readonly client: MomoClient,
    private readonly opts: MomoProviderOptions,
  ) {
    this.chargeCurrency = opts.currency;
  }

  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    if (input.charge.currency !== this.chargeCurrency) throw new Error(`MTN MoMo charges in ${this.chargeCurrency}`);
    const referenceId = referenceIdFor(input.idempotencyKey);
    const body = {
      amount: toMomoAmount(input.charge),
      currency: input.charge.currency,
      externalId: referenceId,
      payer: { partyIdType: 'MSISDN', partyId: msisdn(input.payerPhone) },
      payerMessage: `BluckFlies ${input.merchantReference}`,
      payeeNote: input.description.slice(0, 160),
    };
    const headers = { 'X-Reference-Id': referenceId, ...(this.opts.callbackUrl ? { 'X-Callback-Url': this.opts.callbackUrl } : {}) };

    // Safe to retry: the reference is the idempotency key, and 409 means MTN already has it.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.call('collection', 'POST', '/collection/v1_0/requesttopay', { headers, body, accept: [409] });
        break;
      } catch (err) {
        if (err instanceof MomoApiError && PAYER_ERRORS[err.code]) throw new AppError('VALIDATION_FAILED', PAYER_ERRORS[err.code] ?? err.message);
        const retryable = err instanceof MomoApiError && (err.status === 0 || err.status >= 500);
        if (!retryable || attempt >= 2) {
          this.opts.log.warn('momo.request_failed', { code: err instanceof MomoApiError ? err.code : 'unknown' });
          throw new AppError('UPSTREAM_UNAVAILABLE', 'MTN MoMo could not be reached. Please try again, or pay by card.');
        }
      }
    }
    return {
      providerReference: referenceId,
      approvalInstructions: `An MTN MoMo prompt for ${formatCharge(input.charge)} has been sent to ${maskPhone(input.payerPhone)}. Approve it with your MoMo PIN on your phone within a few minutes.`,
    };
  }

  async cancelPaymentRequest(): Promise<void> {
    // MTN has no cancel for request-to-pay: the prompt times out by itself.
    // A payment approved after cancellation is refunded automatically.
  }

  async getPaymentStatus(providerReference: string): Promise<RemotePaymentStatus> {
    try {
      const { data } = await this.client.call('collection', 'GET', `/collection/v1_0/requesttopay/${encodeURIComponent(providerReference)}`, { schema: TransactionStatus });
      if (!data) return { state: 'open' };
      if (data.status === 'SUCCESSFUL') return { state: 'paid', amount: fromMomoAmount(data.amount, data.currency) };
      if (data.status === 'FAILED') {
        this.opts.log.info('momo.request_failed_status', { reason: typeof data.reason === 'string' ? data.reason : (data.reason?.code ?? null) });
        return { state: 'expired' };
      }
      return { state: 'open' };
    } catch (err) {
      // MTN never accepted this reference: nothing can be paid on it.
      if (err instanceof MomoApiError && err.status === 404) return { state: 'expired' };
      throw err;
    }
  }

  async requestRefund(providerReference: string, amount: ChargeAmount, idempotencyKey: string): Promise<{ refundReference: string }> {
    if (!this.client.hasProduct('disbursement')) {
      throw new RefundRequiresManualError('MTN MoMo automatic refunds need the Disbursement API, which is not configured');
    }
    // The payer's wallet number comes from MTN's own record of the payment.
    const { data } = await this.client.call('collection', 'GET', `/collection/v1_0/requesttopay/${encodeURIComponent(providerReference)}`, { schema: TransactionStatus });
    if (data?.status !== 'SUCCESSFUL' || !data.payer?.partyId) throw new Error(`MTN MoMo payment ${providerReference} is not refundable (status ${data?.status ?? 'unknown'})`);
    const transferId = referenceIdFor(idempotencyKey);
    await this.client.call('disbursement', 'POST', '/disbursement/v1_0/transfer', {
      headers: { 'X-Reference-Id': transferId },
      body: {
        amount: toMomoAmount(amount),
        currency: amount.currency,
        externalId: transferId,
        payee: { partyIdType: 'MSISDN', partyId: data.payer.partyId },
        payerMessage: 'BluckFlies refund',
        payeeNote: `Refund for ${providerReference}`,
      },
      accept: [409], // same refund already submitted
    });
    return { refundReference: transferId };
  }

  async getRefundStatus(refundReference: string): Promise<RemoteRefundStatus> {
    if (!this.client.hasProduct('disbursement')) return 'unknown';
    try {
      const { data } = await this.client.call('disbursement', 'GET', `/disbursement/v1_0/transfer/${encodeURIComponent(refundReference)}`, { schema: TransactionStatus });
      if (data?.status === 'SUCCESSFUL') return 'succeeded';
      if (data?.status === 'FAILED') return 'failed';
      return 'pending';
    } catch (err) {
      if (err instanceof MomoApiError && err.status === 404) return 'failed';
      throw err;
    }
  }
}
