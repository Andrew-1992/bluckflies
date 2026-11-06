import { randomBytes } from 'node:crypto';
import type { ChargeAmount } from '../../domain/types.js';
import { formatUsd } from '../../lib/money.js';
import {
  RefundRequiresManualError,
  type PaymentProvider,
  type PaymentRequestInput,
  type PaymentRequestResult,
  type RemotePaymentStatus,
  type RemoteRefundStatus,
} from './PaymentProvider.js';

/**
 * Bank transfer or cash deposit at a bank branch, in USD, to BluckFlies'
 * account. The traveller writes the booking code as the payment reference.
 * There is no bank API: staff confirm the money arrived on the support desk,
 * which applies the same `payment.succeeded` event as any provider (including
 * the amount check) and then tickets.
 *
 * providerReference = "bt_<random>" (internal; the traveller only sees the booking code).
 */

const JUBA_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Juba', dateStyle: 'medium', timeStyle: 'short' });

export interface BankAccountDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  branch?: string;
  swift?: string;
}

export class BankTransferPaymentProvider implements PaymentProvider {
  readonly name: string;
  readonly chargeCurrency = 'USD';
  readonly needsPolling = false;
  readonly isSandbox: boolean;

  constructor(
    readonly account: BankAccountDetails,
    /** Demo account details for development; never offered in production. */
    opts: { demo?: boolean } = {},
  ) {
    this.isSandbox = Boolean(opts.demo);
    this.name = opts.demo ? 'bank_transfer_demo' : 'bank_transfer';
  }

  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    if (input.method !== 'bank_transfer') throw new Error(`BankTransferPaymentProvider does not handle ${input.method}`);
    if (input.charge.currency !== 'USD') throw new Error('Bank transfers are collected in USD');
    const a = this.account;
    const lines = [
      ...(this.isSandbox ? ['DEMO ONLY: this is not a real bank account. Do not send money.'] : []),
      `Pay ${formatUsd({ amountCents: input.charge.amountMinor, currency: 'USD' })} in US dollars by bank transfer, or as a cash deposit at a branch.`,
      `Bank: ${a.bankName}${a.branch ? ` (${a.branch})` : ''}`,
      `Account name: ${a.accountName}`,
      `Account number: ${a.accountNumber}`,
      ...(a.swift ? [`SWIFT: ${a.swift}`] : []),
      `Reference: ${input.merchantReference} (write your booking code exactly like this)`,
      `Pay before ${JUBA_TIME.format(input.expiresAt)} (Juba time), or the seats are released.`,
      'Keep your receipt. A BluckFlies agent confirms the payment, then your e-ticket is sent by SMS and email.',
    ];
    return { providerReference: `bt_${randomBytes(12).toString('hex')}`, approvalInstructions: lines.join('\n') };
  }

  /** Nothing to cancel at the bank; a deposit arriving later is refunded by staff. */
  async cancelPaymentRequest(): Promise<void> {}

  async requestRefund(_ref: string, _amount: ChargeAmount): Promise<{ refundReference: string }> {
    throw new RefundRequiresManualError('Bank transfers are refunded by staff from the BluckFlies bank account');
  }

  /** Only staff know whether money arrived; reconciliation leaves these alone. */
  async getPaymentStatus(): Promise<RemotePaymentStatus> {
    return { state: 'unknown' };
  }

  async getRefundStatus(): Promise<RemoteRefundStatus> {
    return 'unknown';
  }
}

/** Shown in development so the flow can be tried without a real account. */
export const DEMO_BANK_ACCOUNT: BankAccountDetails = {
  bankName: 'Demo Bank South Sudan',
  accountName: 'BluckFlies Ltd (demo)',
  accountNumber: '0000000000',
  branch: 'Juba Main (demo)',
};
