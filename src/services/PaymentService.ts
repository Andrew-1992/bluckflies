import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { BookingEvents } from './notifications/NotificationService.js';
import { MANUAL_PAYMENT_METHODS, type Booking, type ChargeAmount, type FxQuote, type Money, type Payment, type PaymentMethod } from '../domain/types.js';
import { isPast, type Clock } from '../lib/clock.js';
import { newId, safeEqualHex } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { convertCharge, formatCharge, proportionalRefund } from '../lib/fx.js';
import { formatUsd } from '../lib/money.js';
import { withTimeout } from '../lib/withTimeout.js';
import { PermanentTicketingError, type FlightProvider } from '../providers/flights/FlightProvider.js';
import { RefundRequiresManualError, type PaymentGateway, type ProviderEvent } from '../providers/payments/PaymentProvider.js';
import { BankTransferPaymentProvider, type BankAccountDetails } from '../providers/payments/BankTransferPaymentProvider.js';
import { CashOfficePaymentProvider, type CashOffice } from '../providers/payments/CashOfficePaymentProvider.js';
import type { FxService } from './FxService.js';
import { DuplicateKeyError, type BookingRepository, type PaymentRepository, type ProcessedEventRepository } from '../repositories/types.js';

export const SANDBOX_SIGNATURE_HEADER = 'bf-signature';
const SIGNATURE_TOLERANCE_SECONDS = 300;
const PROVIDER_TIMEOUT_MS = 20_000;
/** Refund references for refunds a person must make; reconciliation skips them. */
export const MANUAL_REFUND_PREFIX = 'manual:';
/** Order creation and payment with the airline can take a while; longer than lookups. */
const ISSUANCE_TIMEOUT_MS = 90_000;

/** Wire format of the sandbox provider's webhooks (HMAC-signed). */
const SandboxEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['payment.succeeded', 'payment.failed', 'refund.succeeded']),
  data: z.object({
    providerReference: z.string().min(1).max(200),
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reason: z.string().max(500).optional(),
  }),
});

/** Where work that needs a person is sent (support tickets). */
export interface ManualActionSink {
  open(sessionId: string, reason: string, summary: string, opts?: { bookingId?: string | undefined }): Promise<unknown>;
}

const METHOD_NAMES: Record<PaymentMethod, string> = {
  card: 'Bank card (Visa, Mastercard)',
  mtn_momo: 'MTN MoMo',
  zain_mgurush: 'Zain m-Gurush',
  bank_transfer: 'Bank transfer or branch deposit (USD)',
  cash_office: 'Cash at a BluckFlies office or partner agent (USD)',
};

export interface PaymentView {
  paymentId: string;
  status: Payment['status'];
  /** Booking value in USD. */
  amount: string;
  /** What the payer pays, when not USD (e.g. "SSP 1,472,000"). */
  charge?: string;
  /** Locked exchange rate behind `charge`. */
  exchangeRate?: string;
  method: PaymentMethod;
  provider: string;
  instructions: string;
  checkoutUrl?: string;
  /** For bank transfers: where to pay. The reference is the booking code. */
  bankTransfer?: BankAccountDetails;
  /** For cash payments: the offices and agents that take them. */
  cashOffices?: readonly CashOffice[];
}

export class PaymentService {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly flights: FlightProvider,
    private readonly payments: PaymentRepository,
    private readonly bookings: BookingRepository,
    private readonly events: ProcessedEventRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly sandboxWebhookSecret: string,
    private readonly fx: FxService,
    private readonly manual: ManualActionSink,
    /** Receives ticketed/refunded events (e-ticket and refund messages). */
    private readonly bookingEvents?: BookingEvents,
    /** Bank and cash payments need time to reach a bank or office before the hold lapses. */
    private readonly opts: { manualPaymentMinMinutes: number } = { manualPaymentMinMinutes: 45 },
  ) {}

  availableMethods(): Array<{ method: PaymentMethod; name: string; currency: string }> {
    return this.gateway.availableMethods().map((method) => ({
      method,
      name: METHOD_NAMES[method],
      currency: this.gateway.forMethod(method)?.chargeCurrency ?? 'USD',
    }));
  }

  /**
   * Sends a payment request for a held booking. Repeating the same request
   * (agent retry, double click) returns the existing request instead of
   * charging twice. A new attempt is allowed only after a failed one.
   */
  async initiate(booking: Booking, method: PaymentMethod, payerPhone: string): Promise<PaymentView> {
    if (booking.status === 'payment_pending') {
      const existing = await this.payments.findLatestForBooking(booking.id);
      if (existing?.status === 'requested' && existing.method === method) return this.toView(existing);
      if (existing?.status === 'requested') {
        // Switching method (e.g. MoMo → card): void the open request first.
        await this.voidRequest(existing);
        await this.bookings.transition(booking.id, ['payment_pending'], { status: 'held', updatedAt: this.clock.now().toISOString() });
        booking = { ...booking, status: 'held' };
      }
    }
    if (booking.status !== 'held') {
      throw new AppError('INVALID_STATE', `Booking ${booking.pnr} is ${booking.status.replace('_', ' ')}; payment is not possible.`);
    }
    if (isPast(booking.holdExpiresAt, this.clock)) throw new AppError('HOLD_EXPIRED', 'The seat hold has expired. Please search and reserve again.');
    if (MANUAL_PAYMENT_METHODS.includes(method)) {
      const minutesLeft = Math.floor((Date.parse(booking.holdExpiresAt) - this.clock.now().getTime()) / 60_000);
      if (minutesLeft < this.opts.manualPaymentMinMinutes) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Only ${Math.max(minutesLeft, 0)} minutes are left before the seats are released: not enough time to pay at a bank or office. Pay by card now, or reserve again closer to when you can pay.`,
        );
      }
    }
    if (!/^\+[1-9]\d{7,14}$/.test(payerPhone)) throw new AppError('VALIDATION_FAILED', 'Payer phone must be in international format, e.g. +211912345678.');

    const previous = await this.payments.findLatestForBooking(booking.id);
    const attempt = previous ? Number(previous.idempotencyKey.split(':').at(-1)) + 1 : 1;
    const idempotencyKey = `pay:${booking.id}:${attempt}`;
    const provider = this.gateway.forMethod(method);
    if (!provider) {
      const available = this.availableMethods().map((m) => m.name).join(', ');
      throw new AppError('VALIDATION_FAILED', `${METHOD_NAMES[method]} is not available right now. Available: ${available || 'none'}.`);
    }
    // Lock the amount the payer will be charged (converted for local-currency wallets).
    const usd = booking.offer.totalPrice;
    let charge: ChargeAmount = { amountMinor: usd.amountCents, currency: 'USD' };
    let fx: FxQuote | undefined;
    if (provider.chargeCurrency !== 'USD') {
      fx = await this.fx.quoteForCharge(provider.chargeCurrency);
      charge = convertCharge(usd, fx);
    }
    const first = booking.offer.segments[0];
    const last = booking.offer.segments.at(-1);

    const result = await withTimeout('Payment request', PROVIDER_TIMEOUT_MS, () =>
      provider.createPaymentRequest({
        method,
        amount: usd,
        charge,
        payerPhone,
        ...(booking.contact.email ? { payerEmail: booking.contact.email } : {}),
        merchantReference: booking.pnr,
        description: `BluckFlies ${booking.pnr}: ${first?.origin} ${booking.offer.returnSegments?.length ? '⇄' : '→'} ${last?.destination}, ${first?.departureTime.slice(0, 10)}${
          booking.offer.returnSegments?.[0] ? ` to ${booking.offer.returnSegments[0].departureTime.slice(0, 10)}` : ''
        }, ${booking.passengers.length} passenger(s)`,
        ...(first ? { travelDate: first.departureTime } : {}),
        expiresAt: new Date(booking.holdExpiresAt),
        idempotencyKey,
      }),
    );
    const now = this.clock.now().toISOString();
    const inserted = await this.payments.insertIfAbsent({
      id: newId('pay'),
      bookingId: booking.id,
      method,
      provider: provider.name,
      amount: usd,
      charge,
      ...(fx ? { fx } : {}),
      status: 'requested',
      providerReference: result.providerReference,
      approvalInstructions: result.approvalInstructions,
      ...(result.checkoutUrl ? { checkoutUrl: result.checkoutUrl } : {}),
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    }).catch(async (err: unknown) => {
      if (!(err instanceof DuplicateKeyError) || err.field !== 'openPaymentRequest') throw err;
      // A concurrent request opened another payment first: make ours unpayable.
      await provider.cancelPaymentRequest(result.providerReference).catch(() => undefined);
      throw new AppError('CONFLICT', 'A payment request is already open for this booking. Please complete or cancel it first.');
    });
    const { payment } = inserted;
    await this.bookings.transition(booking.id, ['held'], { status: 'payment_pending', updatedAt: now });
    if (MANUAL_PAYMENT_METHODS.includes(method)) {
      // Only staff can see whether money arrived: put the request on the support desk.
      const summary =
        method === 'bank_transfer'
          ? `Bank transfer expected: ${formatUsd(usd)} for booking ${booking.pnr}, reference ${booking.pnr}, before ${booking.holdExpiresAt}. Check the bank statement (or import it on the desk), then mark it received or not received.`
          : `Cash payment expected at an office: ${formatUsd(usd)} for booking ${booking.pnr}, before ${booking.holdExpiresAt}. When the traveller pays, issue a numbered receipt and mark it received with the receipt number.`;
      await this.manual
        .open(booking.ownerSessionId, method, summary, { bookingId: booking.id })
        .catch((err: unknown) => this.log.error('manual_payment.ticket_failed', { bookingId: booking.id, method, err: String(err) }));
    }
    this.log.info('payment.requested', { bookingId: booking.id, paymentId: payment.id, method, provider: provider.name, charge: formatCharge(payment.charge) });
    return this.toView(payment);
  }

  /**
   * Staff decision on a bank transfer, branch deposit or office cash payment.
   * "Received" applies a payment.succeeded event (tickets are issued; money that
   * arrives after the hold lapsed is refunded instead). "Not received" fails the
   * request so the traveller can pay another way while the hold lasts.
   * `reference` is the bank's transaction reference or the cash receipt number.
   */
  async settleManualPayment(
    bookingId: string,
    decision: { received: true; amount: ChargeAmount; reference: string } | { received: false },
  ): Promise<{ payment: Payment; bookingStatus: Booking['status'] | undefined }> {
    const payment = await this.payments.findLatestForBooking(bookingId);
    if (!payment || !MANUAL_PAYMENT_METHODS.includes(payment.method)) throw new AppError('INVALID_STATE', 'This booking has no bank or cash payment to confirm.');
    // Money can arrive after the hold lapsed (request cancelled) or after staff first saw nothing
    // (failed): it must still be recorded, and onPaymentSucceeded then refunds instead of ticketing.
    const settleable = decision.received ? ['requested', 'cancelled', 'failed'] : ['requested'];
    if (!settleable.includes(payment.status)) throw new AppError('INVALID_STATE', `This payment is already ${payment.status.replace('_', ' ')}.`);
    if (decision.received) {
      if (decision.amount.currency !== payment.charge.currency || decision.amount.amountMinor !== payment.charge.amountMinor) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Amount received (${formatCharge(decision.amount)}) is not the amount due (${formatCharge(payment.charge)}). Do not confirm a partial or different payment: contact the traveller.`,
        );
      }
      await this.applyEvent({ eventId: `manual:${payment.id}:received`, kind: 'payment.succeeded', providerReference: payment.providerReference, amount: decision.amount });
      this.log.info('manual_payment.received', { paymentId: payment.id, bookingId, method: payment.method, reference: decision.reference });
    } else {
      await this.applyEvent({ eventId: `manual:${payment.id}:not_received`, kind: 'payment.failed', providerReference: payment.providerReference, reason: `${payment.method}_not_received` });
      this.log.info('manual_payment.not_received', { paymentId: payment.id, bookingId, method: payment.method });
    }
    const [updated, booking] = await Promise.all([this.payments.findLatestForBooking(bookingId), this.bookings.findById(bookingId)]);
    return { payment: updated ?? payment, bookingStatus: booking?.status };
  }

  /** Voids an open request when its booking is cancelled or expires. */
  async cancelPending(bookingId: string): Promise<void> {
    const payment = await this.payments.findLatestForBooking(bookingId);
    if (payment?.status === 'requested') await this.voidRequest(payment);
  }

  /**
   * Refunds `amount` (USD) of a booking, returning the same share of what the
   * payer was actually charged (e.g. in SSP at the locked rate). When the
   * provider cannot refund automatically, a person is asked to do it.
   */
  async requestRefund(bookingId: string, amount: Money): Promise<void> {
    const payment = await this.payments.findLatestForBooking(bookingId);
    if (!payment || payment.status !== 'succeeded') throw new AppError('INVALID_STATE', 'No completed payment found to refund.');
    const refund = proportionalRefund(payment.charge, payment.amount, amount);
    const provider = this.gateway.byName(payment.provider);
    let refundReference: string;
    try {
      ({ refundReference } = await withTimeout('Refund request', PROVIDER_TIMEOUT_MS, () =>
        provider.requestRefund(payment.providerReference, refund, `refund:${payment.id}`),
      ));
    } catch (err) {
      if (!(err instanceof RefundRequiresManualError)) throw err;
      refundReference = `${MANUAL_REFUND_PREFIX}${payment.id}`;
      const booking = await this.bookings.findById(bookingId);
      await this.manual.open(
        booking?.ownerSessionId ?? '',
        'payment_issue',
        `Refund ${formatCharge(refund)} (USD ${(amount.amountCents / 100).toFixed(2)}) to the ${payment.method} payer for booking ${booking?.pnr ?? bookingId}; provider reference ${payment.providerReference}. ${err.message}. Mark the refund done once paid.`,
        { bookingId },
      );
      this.log.error('refund.manual_required', { bookingId, paymentId: payment.id, refund: formatCharge(refund) });
    }
    await this.payments.transition(payment.id, ['succeeded'], { status: 'refund_requested', refundReference, updatedAt: this.clock.now().toISOString() });
    this.log.info('refund.requested', { bookingId, paymentId: payment.id, refund: formatCharge(refund), provider: payment.provider });
  }

  private async voidRequest(payment: Payment): Promise<void> {
    await this.payments.transition(payment.id, ['requested'], { status: 'cancelled', updatedAt: this.clock.now().toISOString() });
    await this.gateway
      .byName(payment.provider)
      .cancelPaymentRequest(payment.providerReference)
      .catch((err: unknown) => this.log.warn('payment.cancel_request_failed', { paymentId: payment.id, err: String(err) }));
  }

  // ---------------------------------------------------- sandbox webhook format

  sign(rawBody: string, timestampSeconds: number): string {
    const mac = createHmac('sha256', this.sandboxWebhookSecret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
    return `t=${timestampSeconds},v1=${mac}`;
  }

  /** Verifies HMAC and timestamp (replay window) before any parsing. */
  verifySignature(rawBody: string, header: string | undefined): void {
    const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.split('=', 2) as [string, string]));
    const t = Number(parts['t']);
    const v1 = parts['v1'];
    if (!Number.isInteger(t) || !v1) throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature.');
    const ageSeconds = Math.abs(this.clock.now().getTime() / 1000 - t);
    if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) throw new AppError('UNAUTHENTICATED', 'Webhook timestamp outside tolerance.');
    const expected = this.sign(rawBody, t).split('v1=')[1] ?? '';
    if (!safeEqualHex(expected, v1)) throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature.');
  }

  async handleSandboxWebhook(rawBody: string, signatureHeader: string | undefined): Promise<{ status: 'processed' | 'duplicate' | 'ignored' }> {
    this.verifySignature(rawBody, signatureHeader);
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Malformed webhook body.');
    }
    const parsed = SandboxEventSchema.safeParse(json);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Unrecognised webhook payload.');
    const e = parsed.data;
    return this.applyEvent({
      eventId: e.id,
      kind: e.type,
      providerReference: e.data.providerReference,
      amount: { amountMinor: e.data.amountMinor, currency: e.data.currency },
      ...(e.data.reason ? { reason: e.data.reason } : {}),
    });
  }

  // ------------------------------------------------------- provider-agnostic

  /**
   * Applies an already-verified provider event. Every step is a conditional
   * state transition, so duplicate or retried deliveries converge on the same
   * result. The event ID is recorded only after processing succeeds, so a
   * failure is retried by the provider.
   */
  async applyEvent(event: ProviderEvent): Promise<{ status: 'processed' | 'duplicate' | 'ignored' }> {
    const payment = await this.payments.findByProviderReference(event.providerReference);
    if (!payment) {
      this.log.warn('webhook.unknown_payment', { eventId: event.eventId });
      return { status: 'ignored' };
    }
    switch (event.kind) {
      case 'payment.succeeded':
        await this.onPaymentSucceeded(payment, event);
        break;
      case 'payment.failed':
        await this.onPaymentFailed(payment, event);
        break;
      case 'refund.succeeded':
        await this.onRefundSucceeded(payment);
        break;
    }
    const isNew = await this.events.markIfNew(`${payment.provider}:${event.eventId}`);
    return { status: isNew ? 'processed' : 'duplicate' };
  }

  private async onPaymentSucceeded(payment: Payment, event: ProviderEvent): Promise<void> {
    if (event.amount?.amountMinor !== payment.charge.amountMinor || event.amount.currency !== payment.charge.currency) {
      // Never ticket on an amount or currency mismatch; flag for manual reconciliation.
      this.log.error('payment.amount_mismatch', {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        expected: formatCharge(payment.charge),
        received: event.amount ? formatCharge(event.amount) : null,
      });
      throw new AppError('CONFLICT', 'Payment amount mismatch.');
    }
    const now = this.clock.now().toISOString();
    await this.payments.transition(payment.id, ['requested', 'failed', 'cancelled'], { status: 'succeeded', updatedAt: now });

    const booking = await this.bookings.findById(payment.bookingId);
    if (!booking) throw new Error(`Booking ${payment.bookingId} missing for payment ${payment.id}`);

    // Claim issuance: exactly one webhook delivery, instance or job moves the
    // booking into `ticketing`; everyone else stops here.
    const claimed = await this.bookings.transition(booking.id, ['payment_pending', 'held'], { status: 'ticketing', updatedAt: now });
    if (!claimed) {
      const current = await this.bookings.findById(booking.id);
      if (current?.status === 'ticketed' || current?.status === 'ticketing') return; // done, or in progress / reconciler's job
      // Paid after the booking expired or was cancelled: refund in full rather than ticket.
      this.log.warn('payment.late_for_booking', { bookingId: booking.id, status: current?.status });
      const fresh = await this.payments.findLatestForBooking(booking.id);
      if (fresh?.id === payment.id && fresh.status === 'succeeded') await this.requestRefund(booking.id, payment.amount);
      return;
    }
    await this.issueTickets(claimed, payment.provider);
  }

  /**
   * Issues tickets for a booking in `ticketing`. Asks the supplier first, so a
   * retry after a crash adopts already-issued tickets instead of re-issuing.
   *
   * - 'ticketed': done.
   * - 'retry': temporary or unclear failure; the booking stays in `ticketing`
   *   and the reconciliation job tries again (never blindly re-creating orders).
   * - 'refunded': the airline can never honour this fare (sold out, price rose,
   *   schedule changed); the traveller is refunded in full.
   */
  async issueTickets(booking: Booking, paymentProvider: string): Promise<'ticketed' | 'retry' | 'refunded'> {
    if (booking.status !== 'ticketing') return 'retry';
    const ctx = {
      bookingId: booking.id,
      supplierReference: booking.supplierReference,
      offer: booking.offer,
      passengers: booking.passengers,
      contact: booking.contact,
    };
    try {
      const existing = await withTimeout('Ticket lookup', PROVIDER_TIMEOUT_MS, () => this.flights.findIssuedTickets(ctx));
      const issued =
        existing && existing.ticketNumbers.length >= booking.passengers.length
          ? existing
          : await withTimeout('Ticket issuance', ISSUANCE_TIMEOUT_MS, () => this.flights.issueTickets(ctx));
      const ticketed = await this.bookings.transition(booking.id, ['ticketing'], {
        status: 'ticketed',
        ticketNumbers: issued.ticketNumbers,
        supplierReference: issued.supplierReference,
        updatedAt: this.clock.now().toISOString(),
      });
      if (ticketed) {
        this.log.info('booking.ticketed', { bookingId: booking.id, pnr: booking.pnr, total: formatUsd(booking.offer.totalPrice), paymentProvider });
        await this.emit('ticketed', ticketed);
      }
      return ticketed ? 'ticketed' : 'retry';
    } catch (err) {
      if (err instanceof PermanentTicketingError) return this.refundUnfulfillable(booking, err);
      this.log.error('booking.ticketing_failed', { bookingId: booking.id, err: err instanceof Error ? err.message : String(err) });
      return 'retry';
    }
  }

  private async refundUnfulfillable(booking: Booking, err: PermanentTicketingError): Promise<'refunded' | 'retry'> {
    const moved = await this.bookings.transition(booking.id, ['ticketing'], { status: 'refund_pending', updatedAt: this.clock.now().toISOString() });
    if (!moved) return 'retry';
    const payment = await this.payments.findLatestForBooking(booking.id);
    if (!payment) throw new Error(`Paid booking ${booking.id} has no payment record`);
    await this.requestRefund(booking.id, payment.amount);
    this.log.error('booking.unfulfillable_refunded', { bookingId: booking.id, pnr: booking.pnr, code: err.code, reason: err.message });
    return 'refunded';
  }

  private async onPaymentFailed(payment: Payment, event: ProviderEvent): Promise<void> {
    const now = this.clock.now().toISOString();
    const failed = await this.payments.transition(payment.id, ['requested'], { status: 'failed', updatedAt: now });
    if (!failed) return;
    // Return the booking to "held" so the traveller can retry before the hold lapses.
    await this.bookings.transition(payment.bookingId, ['payment_pending'], { status: 'held', updatedAt: now });
    this.log.info('payment.failed', { paymentId: payment.id, reason: event.reason ?? 'unspecified' });
  }

  private async onRefundSucceeded(payment: Payment): Promise<void> {
    const now = this.clock.now().toISOString();
    await this.payments.transition(payment.id, ['refund_requested'], { status: 'refunded', updatedAt: now });
    await this.finishRefundedBooking(payment.bookingId, now);
  }

  private async finishRefundedBooking(bookingId: string, now: string): Promise<void> {
    const refunded = await this.bookings.transition(bookingId, ['refund_pending', 'cancelled', 'expired'], { status: 'refunded', updatedAt: now });
    if (refunded) await this.emit('refunded', refunded);
  }

  /**
   * Staff have paid a refund the payment provider could not make (bank transfer,
   * office cash): records it with the staff's reference (bank transfer number or
   * cash receipt) and tells the traveller, exactly as an automatic refund would.
   */
  async completeManualRefund(bookingId: string, reference: string): Promise<Payment> {
    const payment = await this.payments.findLatestForBooking(bookingId);
    if (!payment || payment.status !== 'refund_requested') throw new AppError('INVALID_STATE', 'This booking has no refund waiting to be paid.');
    if (!payment.refundReference?.startsWith(MANUAL_REFUND_PREFIX)) {
      throw new AppError('INVALID_STATE', 'The payment provider is making this refund; it completes automatically.');
    }
    const now = this.clock.now().toISOString();
    const done = await this.payments.transition(payment.id, ['refund_requested'], { status: 'refunded', refundReference: `${MANUAL_REFUND_PREFIX}${payment.id}:${reference}`, updatedAt: now });
    if (!done) throw new AppError('CONFLICT', 'The refund changed while saving. Reload the ticket.');
    await this.finishRefundedBooking(bookingId, now);
    this.log.info('refund.manual_completed', { bookingId, paymentId: payment.id });
    return done;
  }

  /** Messages are queued, never sent inline; a failure here must not undo a ticket or refund. */
  private async emit(kind: 'ticketed' | 'refunded', booking: Booking): Promise<void> {
    await this.bookingEvents?.onBooking(kind, booking).catch((err: unknown) => this.log.error('booking.event_failed', { kind, bookingId: booking.id, err: String(err) }));
  }

  async latestForBooking(bookingId: string): Promise<Payment | undefined> {
    return this.payments.findLatestForBooking(bookingId);
  }

  toView(p: Payment): PaymentView {
    return {
      paymentId: p.id,
      status: p.status,
      amount: formatUsd(p.amount),
      ...(p.charge.currency !== 'USD' ? { charge: formatCharge(p.charge) } : {}),
      ...(p.fx
        ? { exchangeRate: `${p.fx.perUsd} ${p.fx.currency}/USD (${p.fx.source}, ${p.fx.asOf.slice(0, 10)})${p.fx.markupBps ? ` + ${p.fx.markupBps / 100}%` : ''}` }
        : {}),
      method: p.method,
      provider: p.provider,
      instructions: p.approvalInstructions,
      ...(p.checkoutUrl && p.status === 'requested' ? { checkoutUrl: p.checkoutUrl } : {}),
      ...(p.status === 'requested' ? this.manualDetails(p.provider) : {}),
    };
  }

  /** Where to pay in person, for bank and cash payments. */
  private manualDetails(providerName: string): { bankTransfer?: BankAccountDetails; cashOffices?: readonly CashOffice[] } {
    let provider;
    try {
      provider = this.gateway.byName(providerName);
    } catch {
      return {}; // provider no longer configured: the stored instructions still apply
    }
    if (provider instanceof BankTransferPaymentProvider) return { bankTransfer: provider.account };
    if (provider instanceof CashOfficePaymentProvider) return { cashOffices: provider.offices };
    return {};
  }
}
