import type { ChargeAmount, PaymentMethod } from '../../domain/types.js';
import { formatCharge } from '../../lib/fx.js';
import { newId } from '../../lib/ids.js';
import type { PaymentProvider, PaymentRequestInput, PaymentRequestResult, RemotePaymentStatus, RemoteRefundStatus } from './PaymentProvider.js';

const METHOD_LABEL: Record<PaymentMethod, string> = {
  mtn_momo: 'MTN MoMo',
  zain_mgurush: 'Zain m-Gurush',
  card: 'card',
  bank_transfer: 'bank transfer',
  cash_office: 'cash payment',
};

/**
 * Sandbox payments. Honours idempotency keys like a real provider. Approval is
 * simulated through the sandbox endpoint, which emits a correctly signed webhook.
 * The mobile-money sandbox charges in SSP like real South Sudanese wallets.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name: string;
  readonly chargeCurrency: string;
  readonly needsPolling = false;
  readonly isSandbox = true;

  constructor(opts: { name?: string; chargeCurrency?: string } = {}) {
    this.name = opts.name ?? 'sandbox';
    this.chargeCurrency = opts.chargeCurrency ?? 'SSP';
  }
  private readonly byIdempotencyKey = new Map<string, PaymentRequestResult>();
  readonly cancelled = new Set<string>();

  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    const existing = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existing) return existing;

    const providerReference = newId('sbxpay');
    const approvalInstructions = `A ${METHOD_LABEL[input.method]} prompt for ${formatCharge(input.charge)} has been sent to ${maskPhone(input.payerPhone)}. Approve it with your PIN on your phone. (Sandbox: approve from the demo panel.)`;

    const result = { providerReference, approvalInstructions };
    this.byIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async cancelPaymentRequest(providerReference: string): Promise<void> {
    this.cancelled.add(providerReference);
  }

  async requestRefund(_providerReference: string, _amount: ChargeAmount, idempotencyKey: string): Promise<{ refundReference: string }> {
    return { refundReference: `sbxref_${idempotencyKey.slice(-12)}` };
  }

  async getPaymentStatus(): Promise<RemotePaymentStatus> {
    return { state: 'unknown' };
  }

  async getRefundStatus(): Promise<RemoteRefundStatus> {
    return 'unknown';
  }
}

export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `${phone.slice(0, 4)}****${phone.slice(-3)}`;
}
