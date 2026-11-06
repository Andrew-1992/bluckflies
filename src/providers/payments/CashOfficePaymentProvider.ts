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
 * Cash in US dollars at a BluckFlies office or partner travel agent. The
 * traveller gives the booking code; staff take the cash, issue a numbered
 * receipt and confirm the payment on the support desk with that receipt
 * number. Like bank transfers, there is no provider API and refunds are made
 * by a person.
 *
 * providerReference = "co_<random>" (internal).
 */

export interface CashOffice {
  name: string;
  address: string;
  hours: string;
}

const JUBA_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Juba', dateStyle: 'medium', timeStyle: 'short' });

/**
 * Parses CASH_OFFICES: entries separated by ";", fields by "|":
 * "BluckFlies Juba | Hai Cinema, Juba | Mon-Sat 08:00-17:00; Partner X | ... | ...".
 */
export function parseCashOffices(spec: string): CashOffice[] {
  const offices = spec
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name = '', address = '', hours = ''] = entry.split('|').map((f) => f.trim());
      if (!name || !address || !hours || entry.split('|').length !== 3) {
        throw new Error(`CASH_OFFICES: each office must be "name | address | opening hours" (got "${entry.slice(0, 60)}")`);
      }
      return { name, address, hours };
    });
  if (offices.length === 0) throw new Error('CASH_OFFICES: no offices listed');
  return offices;
}

export class CashOfficePaymentProvider implements PaymentProvider {
  readonly name: string;
  readonly chargeCurrency = 'USD';
  readonly needsPolling = false;
  readonly isSandbox: boolean;

  constructor(
    readonly offices: readonly CashOffice[],
    /** Demo office list for development; never offered in production. */
    opts: { demo?: boolean } = {},
  ) {
    this.isSandbox = Boolean(opts.demo);
    this.name = opts.demo ? 'cash_office_demo' : 'cash_office';
  }

  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    if (input.method !== 'cash_office') throw new Error(`CashOfficePaymentProvider does not handle ${input.method}`);
    if (input.charge.currency !== 'USD') throw new Error('Office cash payments are collected in USD');
    const lines = [
      ...(this.isSandbox ? ['DEMO ONLY: these are not real offices.'] : []),
      `Pay ${formatUsd({ amountCents: input.charge.amountMinor, currency: 'USD' })} in US dollars cash at one of these places:`,
      ...this.offices.map((o) => `- ${o.name}, ${o.address} (${o.hours})`),
      `Give your booking code ${input.merchantReference}. Pay before ${JUBA_TIME.format(input.expiresAt)} (Juba time), or the seats are released.`,
      'Always ask for a printed receipt with a receipt number. Your e-ticket is sent by SMS and email once staff confirm the payment.',
    ];
    return { providerReference: `co_${randomBytes(12).toString('hex')}`, approvalInstructions: lines.join('\n') };
  }

  async cancelPaymentRequest(): Promise<void> {}

  async requestRefund(_ref: string, _amount: ChargeAmount): Promise<{ refundReference: string }> {
    throw new RefundRequiresManualError('Cash payments are refunded in cash at the office (or by transfer) by staff');
  }

  async getPaymentStatus(): Promise<RemotePaymentStatus> {
    return { state: 'unknown' };
  }

  async getRefundStatus(): Promise<RemoteRefundStatus> {
    return 'unknown';
  }
}

/** Shown in development so the flow can be tried without real offices. */
export const DEMO_CASH_OFFICES: readonly CashOffice[] = [
  { name: 'BluckFlies Juba office (demo)', address: 'Juba town centre (demo address)', hours: 'Mon–Sat 08:00–17:00' },
];
