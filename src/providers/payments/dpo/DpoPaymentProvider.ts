import type { ChargeAmount } from '../../../domain/types.js';
import type { Clock } from '../../../lib/clock.js';
import { parseMinorUnits } from '../../../lib/money.js';
import {
  RefundRequiresManualError,
  type PaymentProvider,
  type PaymentRequestInput,
  type PaymentRequestResult,
  type RemotePaymentStatus,
  type RemoteRefundStatus,
} from '../PaymentProvider.js';
import { DpoApiError, DpoClient } from './DpoClient.js';

/**
 * Bank cards (Visa, Mastercard) through DPO Pay's hosted payment page. Cards
 * from South Sudanese banks (KCB, Equity, Stanbic, …) are accepted when the
 * issuing bank allows online payments. Card details are entered only on DPO's
 * page; BluckFlies never sees them.
 *
 * providerReference = DPO TransToken.
 *
 * DPO's redirect and notifications are not signed, so they are never trusted:
 * every status comes from verifyToken, called with our company token. The
 * provider is polled (needsPolling) so a traveller who never returns to the
 * site is still confirmed.
 */

export interface DpoProviderOptions {
  /** DPO service type ID assigned to the merchant account (Services > ServiceType). */
  serviceType: string;
  publicBaseUrl: string;
  /** Refund through DPO's API; otherwise staff refund in the DPO portal (support ticket). */
  autoRefunds: boolean;
}

/** verifyToken results that mean "not finished yet". */
const OPEN_RESULTS = new Set(['001', '003', '005', '007', '900', '901']);
/** verifyToken results that mean the token can no longer be paid. */
const CLOSED_RESULTS = new Set(['903', '904']);
/** Paid: 000, or 002 (over/under-paid; the amount check then refuses to ticket and alerts staff). */
const PAID_RESULTS = new Set(['000', '002']);

const MIN_PTL_MINUTES = 5;
export const DPO_RETURN_PATH = '/api/payments/dpo/return';

export function toDecimal(c: ChargeAmount): string {
  return (c.amountMinor / 100).toFixed(2);
}

/** "2026-11-06T14:30:00+02:00" → "2026/11/06 14:30" (DPO ServiceDate, the flight's local time). */
export function serviceDate(iso: string | undefined, fallback: Date): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso) : null;
  if (m) return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}`;
  const d = fallback.toISOString();
  return `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)} ${d.slice(11, 16)}`;
}

export class DpoPaymentProvider implements PaymentProvider {
  readonly name = 'dpo';
  readonly chargeCurrency = 'USD';
  readonly needsPolling = true;
  readonly isSandbox = false;

  constructor(
    private readonly client: DpoClient,
    private readonly clock: Clock,
    private readonly opts: DpoProviderOptions,
  ) {}

  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    if (input.method !== 'card') throw new Error(`DpoPaymentProvider does not handle ${input.method}`);
    if (input.charge.currency !== 'USD') throw new Error('DPO card charges are in USD');
    const minutesLeft = Math.floor((input.expiresAt.getTime() - this.clock.now().getTime()) / 60_000);
    const attempt = input.idempotencyKey.split(':').at(-1) ?? '1';
    const returnUrl = `${this.opts.publicBaseUrl}${DPO_RETURN_PATH}`;
    const f = DpoClient.fields;
    const res = await this.client.request(
      'createToken',
      `<Transaction>${f([
        ['PaymentAmount', toDecimal(input.charge)],
        ['PaymentCurrency', 'USD'],
        // One reference per attempt, readable by staff in the DPO portal.
        ['CompanyRef', `${input.merchantReference}-${attempt}`],
        ['RedirectURL', returnUrl],
        ['BackURL', returnUrl],
        ['CompanyRefUnique', '0'],
        ['PTL', String(Math.max(MIN_PTL_MINUTES, minutesLeft))],
        ['PTLtype', 'minutes'],
        ['customerEmail', input.payerEmail],
      ])}</Transaction><Services><Service>${f([
        ['ServiceType', this.opts.serviceType],
        ['ServiceDescription', input.description.slice(0, 200)],
        ['ServiceDate', serviceDate(input.travelDate, input.expiresAt)],
      ])}</Service></Services>`,
    );
    const token = res['TransToken'];
    if (res['Result'] !== '000' || !token) {
      throw new DpoApiError(res['Result'] ?? 'unknown', `DPO could not create the card payment: ${res['ResultExplanation'] ?? 'no explanation'}`);
    }
    return {
      providerReference: token,
      checkoutUrl: this.client.paymentPageUrl(token),
      approvalInstructions:
        'Open the secure DPO payment page and pay with your Visa or Mastercard bank card. Your bank may ask you to confirm with a code (3-D Secure). The card must be enabled for online payments.',
    };
  }

  async cancelPaymentRequest(providerReference: string): Promise<void> {
    const res = await this.client.request('cancelToken', DpoClient.fields([['TransactionToken', providerReference]]));
    if (res['Result'] !== '000') throw new DpoApiError(res['Result'] ?? 'unknown', `DPO cancelToken: ${res['ResultExplanation'] ?? ''}`);
  }

  async requestRefund(providerReference: string, amount: ChargeAmount, idempotencyKey: string): Promise<{ refundReference: string }> {
    if (!this.opts.autoRefunds) throw new RefundRequiresManualError('Refund this card payment in the DPO portal (automatic DPO refunds are off)');
    const res = await this.client.request(
      'refundToken',
      DpoClient.fields([
        ['TransactionToken', providerReference],
        ['refundAmount', toDecimal(amount)],
        ['refundDetails', `BluckFlies refund ${idempotencyKey}`],
        ['refundRef', idempotencyKey],
      ]),
    );
    // Anything but an explicit success goes to a person: money owed must not be lost in a retry loop.
    if (res['Result'] !== '000') throw new RefundRequiresManualError(`DPO refused the refund (${res['Result'] ?? '?'}: ${res['ResultExplanation'] ?? 'no explanation'})`);
    return { refundReference: `dpo:${providerReference}:${idempotencyKey}` };
  }

  async getPaymentStatus(providerReference: string): Promise<RemotePaymentStatus> {
    const res = await this.client.request('verifyToken', DpoClient.fields([['TransactionToken', providerReference]]));
    const result = res['Result'] ?? '';
    if (PAID_RESULTS.has(result)) {
      const amountMinor = parseMinorUnits(res['TransactionAmount']);
      const currency = res['TransactionCurrency']?.toUpperCase();
      if (amountMinor === undefined || !currency || !/^[A-Z]{3}$/.test(currency)) {
        throw new DpoApiError('invalid_response', 'DPO reported a payment without a readable amount');
      }
      return { state: 'paid', amount: { amountMinor, currency } };
    }
    if (OPEN_RESULTS.has(result)) return { state: 'open' };
    if (CLOSED_RESULTS.has(result)) return { state: 'expired' };
    throw new DpoApiError(result || 'unknown', `DPO verifyToken: ${res['ResultExplanation'] ?? 'unexpected result'}`);
  }

  /** refundToken answers synchronously: a recorded refund reference means DPO accepted it. */
  async getRefundStatus(refundReference: string): Promise<RemoteRefundStatus> {
    return refundReference.startsWith('dpo:') ? 'succeeded' : 'unknown';
  }
}
