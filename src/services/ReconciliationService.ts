import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { PaymentGateway } from '../providers/payments/PaymentProvider.js';
import type { Payment } from '../domain/types.js';
import type { BookingRepository, PaymentRepository } from '../repositories/types.js';
import { MANUAL_REFUND_PREFIX, type PaymentService } from './PaymentService.js';

export interface ReconcileReport {
  paymentsChecked: number;
  paymentsResolved: number;
  refundsResolved: number;
  ticketingRetried: number;
  ticketingCompleted: number;
  /** Paid bookings the airline could no longer honour; the traveller was refunded. */
  ticketingRefunded: number;
}

const BATCH = 50;

/**
 * Safety net for missed or failed asynchronous steps. Webhooks are the fast
 * path; this asks the providers directly for anything left open too long.
 * Every action goes through the same idempotent state transitions as webhooks,
 * so running it concurrently with webhook delivery is safe.
 */
export class ReconciliationService {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly payments: PaymentService,
    private readonly paymentRepo: PaymentRepository,
    private readonly bookingRepo: BookingRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: { providers: readonly string[]; staleAfterMinutes: number; stuckTicketingAfterMinutes: number },
  ) {}

  async run(): Promise<ReconcileReport> {
    const report: ReconcileReport = { paymentsChecked: 0, paymentsResolved: 0, refundsResolved: 0, ticketingRetried: 0, ticketingCompleted: 0, ticketingRefunded: 0 };
    const staleBefore = new Date(this.clock.now().getTime() - this.opts.staleAfterMinutes * 60_000);

    for (const name of this.opts.providers) {
      const provider = this.gateway.byName(name);
      if (provider.isSandbox) continue; // simulated providers have nothing to reconcile against

      for (const p of await this.paymentRepo.findStale(['requested'], name, staleBefore, BATCH)) {
        report.paymentsChecked++;
        if ((await this.checkPayment(p)) !== 'open') report.paymentsResolved++;
      }

      for (const p of await this.paymentRepo.findStale(['refund_requested'], name, staleBefore, BATCH)) {
        // Refunds made by a person (no provider API) are closed by them, not polled.
        if (!p.refundReference || p.refundReference.startsWith(MANUAL_REFUND_PREFIX)) continue;
        try {
          const status = await provider.getRefundStatus(p.refundReference);
          if (status === 'succeeded') {
            await this.payments.applyEvent({ eventId: `reconcile:refund:${p.refundReference}`, kind: 'refund.succeeded', providerReference: p.providerReference });
            report.refundsResolved++;
          } else if (status === 'failed') {
            // Money owed to a traveller: needs a person.
            this.log.error('reconcile.refund_failed_needs_attention', { paymentId: p.id, bookingId: p.bookingId });
          }
        } catch (err) {
          this.log.warn('reconcile.refund_check_failed', { paymentId: p.id, err: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    const stuckBefore = new Date(this.clock.now().getTime() - this.opts.stuckTicketingAfterMinutes * 60_000);
    for (const b of await this.bookingRepo.findStuckTicketing(stuckBefore, BATCH)) {
      report.ticketingRetried++;
      const payment = await this.paymentRepo.findLatestForBooking(b.id);
      const outcome = await this.payments.issueTickets(b, payment?.provider ?? 'unknown');
      if (outcome === 'ticketed') report.ticketingCompleted++;
      else if (outcome === 'refunded') report.ticketingRefunded++;
      else this.log.error('reconcile.ticketing_still_failing', { bookingId: b.id, pnr: b.pnr, since: b.updatedAt });
    }

    return report;
  }

  /**
   * Asks the provider for a payment's authoritative status and applies it
   * through the same idempotent path as verified webhooks.
   */
  async checkPayment(p: Payment): Promise<'paid' | 'failed' | 'open'> {
    try {
      const remote = await this.gateway.byName(p.provider).getPaymentStatus(p.providerReference);
      if (remote.state === 'paid') {
        await this.payments.applyEvent({ eventId: `reconcile:paid:${p.providerReference}`, kind: 'payment.succeeded', providerReference: p.providerReference, amount: remote.amount });
        return 'paid';
      }
      if (remote.state === 'expired') {
        await this.payments.applyEvent({ eventId: `reconcile:expired:${p.providerReference}`, kind: 'payment.failed', providerReference: p.providerReference, reason: 'reconciled_expired' });
        return 'failed';
      }
    } catch (err) {
      this.log.warn('reconcile.payment_failed', { paymentId: p.id, err: err instanceof Error ? err.message : String(err) });
    }
    return 'open';
  }

  /**
   * Fast path for providers without trustworthy webhooks (MTN MoMo): polls
   * every open request older than a few seconds.
   */
  async pollPending(minAgeSeconds = 15): Promise<{ checked: number; resolved: number }> {
    const before = new Date(this.clock.now().getTime() - minAgeSeconds * 1000);
    let checked = 0;
    let resolved = 0;
    for (const name of this.gateway.pollingProviders()) {
      for (const p of await this.paymentRepo.findStale(['requested'], name, before, BATCH)) {
        checked++;
        if ((await this.checkPayment(p)) !== 'open') resolved++;
      }
    }
    return { checked, resolved };
  }

  /** A provider callback (unsigned) says something changed: verify with the provider. */
  async checkByReference(provider: string, providerReference: string): Promise<'paid' | 'failed' | 'open' | 'unknown'> {
    const p = await this.paymentRepo.findByProviderReference(providerReference);
    if (!p || p.provider !== provider || p.status !== 'requested') return 'unknown';
    return this.checkPayment(p);
  }
}
