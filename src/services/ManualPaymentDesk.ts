import { AppError } from '../domain/errors.js';
import { MANUAL_PAYMENT_METHODS, type Booking, type ChargeAmount, type Payment } from '../domain/types.js';
import type { Clock } from '../lib/clock.js';
import { formatCharge } from '../lib/fx.js';
import type { Logger } from '../lib/logger.js';
import type { PaymentGateway } from '../providers/payments/PaymentProvider.js';
import type { BookingRepository, PaymentRepository, SupportTicketRepository } from '../repositories/types.js';
import type { PaymentService } from './PaymentService.js';
import { mentionsCode, parseStatement, type StatementLine } from './statements.js';
import type { SupportService } from './SupportService.js';

/**
 * Staff side of payments made at a bank or office: confirming one payment from
 * its desk ticket, and matching a bank statement against every open bank
 * transfer. Every confirmation goes through PaymentService.settleManualPayment
 * (amount check, idempotent state transitions) and leaves an attributed note on
 * the booking's desk ticket.
 */

export type Decision = { received: true; amount: ChargeAmount; reference: string; note?: string } | { received: false; note?: string };

export type StatementMatchStatus =
  /** Booking code and exact amount: safe to confirm. */
  | 'match'
  /** Booking code found, but a different amount or currency: a person must decide. */
  | 'amount_differs'
  /** The booking's payment is already confirmed (e.g. statement imported twice). */
  | 'already_confirmed'
  /** A second line for a booking already matched in this statement. */
  | 'duplicate';

export interface StatementMatch {
  lineId: string;
  row: number;
  date?: string;
  amount?: string;
  bankReference?: string;
  pnr: string;
  amountDue: string;
  status: StatementMatchStatus;
  /** Set after apply: what happened to the booking. */
  bookingStatus?: Booking['status'] | undefined;
  error?: string;
}

export interface StatementResult {
  columns: ReturnType<typeof parseStatement>['columns'];
  linesRead: number;
  /** Incoming payments that mention no open booking (other income): counted, not listed. */
  unrelatedCredits: number;
  matches: StatementMatch[];
  applied: number;
}

/** Bank transfers that may still be confirmed: open, or lapsed/rejected within this window (late money is refunded). */
const LOOKBACK_DAYS = 30;

export class ManualPaymentDesk {
  constructor(
    private readonly payments: PaymentService,
    private readonly support: SupportService,
    private readonly gateway: PaymentGateway,
    private readonly paymentRepo: PaymentRepository,
    private readonly bookings: BookingRepository,
    private readonly tickets: SupportTicketRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** Confirms or rejects the payment of the booking a desk ticket is about. */
  async settleTicket(ticketId: string, decision: Decision, author: string): Promise<{ bookingStatus: Booking['status'] | undefined; paymentStatus: Payment['status'] }> {
    const ticket = await this.tickets.find(ticketId);
    if (!ticket) throw new AppError('NOT_FOUND', 'No such ticket.');
    if (!ticket.bookingId) throw new AppError('INVALID_STATE', 'This ticket is not linked to a booking.');
    const result = await this.payments.settleManualPayment(ticket.bookingId, decision.received ? { received: true, amount: decision.amount, reference: decision.reference } : { received: false });
    await this.record(ticketId, author, result.payment, decision, result.bookingStatus);
    return { bookingStatus: result.bookingStatus, paymentStatus: result.payment.status };
  }

  /** Records a refund staff have paid by hand (bank transfer or cash), from its desk ticket. */
  async markRefundPaid(ticketId: string, input: { reference: string; note?: string }, author: string): Promise<{ paymentStatus: Payment['status'] }> {
    const ticket = await this.tickets.find(ticketId);
    if (!ticket) throw new AppError('NOT_FOUND', 'No such ticket.');
    if (!ticket.bookingId) throw new AppError('INVALID_STATE', 'This ticket is not linked to a booking.');
    const payment = await this.payments.completeManualRefund(ticket.bookingId, input.reference);
    await this.support.addNote(ticketId, author, `Refund paid by hand (${payment.method.replace('_', ' ')}), reference ${input.reference}.${input.note ? ` ${input.note}` : ''}`);
    await this.support.update(ticketId, { status: 'resolved' }, author);
    return { paymentStatus: payment.status };
  }

  /**
   * Matches a bank statement against bank transfers. With `apply` (line ids
   * from a previous preview), confirms those lines that are still exact matches;
   * anything that changed since the preview is reported, not applied.
   */
  async importStatement(csv: string, author: string, apply: readonly string[] = []): Promise<StatementResult> {
    let parsed;
    try {
      parsed = parseStatement(csv);
    } catch (err) {
      throw new AppError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
    }
    const candidates = await this.candidates();
    const seen = new Set<string>();
    const matches: StatementMatch[] = [];
    let unrelatedCredits = 0;

    for (const line of parsed.lines) {
      if (line.creditMinor === undefined) continue; // debits and unreadable amounts
      const hit = candidates.find((c) => mentionsCode(line.text, c.pnr));
      if (!hit) {
        unrelatedCredits++;
        continue;
      }
      matches.push(this.classify(line, hit, seen));
      seen.add(hit.pnr);
    }

    let applied = 0;
    const wanted = new Set(apply);
    for (const m of matches) {
      if (!wanted.has(m.lineId)) continue;
      if (m.status !== 'match') {
        m.error = 'Not applied: this line is not an exact match any more.';
        continue;
      }
      const c = candidates.find((x) => x.pnr === m.pnr);
      const line = parsed.lines.find((l) => l.id === m.lineId);
      if (!c || !line || line.creditMinor === undefined) continue;
      const reference = line.bankReference ?? `statement row ${line.row}${line.date ? ` (${line.date})` : ''}`;
      try {
        const result = await this.payments.settleManualPayment(c.payment.bookingId, { received: true, amount: { amountMinor: line.creditMinor, currency: c.payment.charge.currency }, reference });
        m.bookingStatus = result.bookingStatus;
        applied++;
        const ticketId = await this.ticketFor(c.payment.bookingId);
        if (ticketId) await this.record(ticketId, author, result.payment, { received: true, amount: c.payment.charge, reference, note: 'Matched from the bank statement import.' }, result.bookingStatus);
      } catch (err) {
        m.error = err instanceof Error ? err.message : String(err);
        this.log.warn('statement.apply_failed', { pnr: m.pnr, err: m.error });
      }
    }
    if (apply.length) this.log.info('statement.applied', { author, applied, requested: apply.length });
    return { columns: parsed.columns, linesRead: parsed.lines.length, unrelatedCredits, matches, applied };
  }

  private classify(line: StatementLine, c: Candidate, seen: Set<string>): StatementMatch {
    const base = {
      lineId: line.id,
      row: line.row,
      ...(line.date ? { date: line.date } : {}),
      ...(line.creditMinor !== undefined ? { amount: formatCharge({ amountMinor: line.creditMinor, currency: line.currency ?? c.payment.charge.currency }) } : {}),
      ...(line.bankReference ? { bankReference: line.bankReference } : {}),
      pnr: c.pnr,
      amountDue: formatCharge(c.payment.charge),
    };
    if (seen.has(c.pnr)) return { ...base, status: 'duplicate' };
    if (c.payment.status === 'succeeded' || c.payment.status === 'refund_requested' || c.payment.status === 'refunded') return { ...base, status: 'already_confirmed' };
    const currencyOk = !line.currency || line.currency === c.payment.charge.currency;
    return { ...base, status: currencyOk && line.creditMinor === c.payment.charge.amountMinor ? 'match' : 'amount_differs' };
  }

  /** Recent bank-transfer payments (latest per booking), with their booking codes. */
  private async candidates(): Promise<Candidate[]> {
    if (!this.gateway.forMethod('bank_transfer')) return [];
    const since = new Date(this.clock.now().getTime() - LOOKBACK_DAYS * 86_400_000);
    const rows = await this.paymentRepo.findRecentByMethod('bank_transfer', since, 2000);
    const out: Candidate[] = [];
    for (const p of rows) {
      const latest = await this.paymentRepo.findLatestForBooking(p.bookingId);
      if (latest?.id !== p.id) continue; // a newer attempt (e.g. card) supersedes it
      const booking = await this.bookings.findById(p.bookingId);
      if (booking) out.push({ pnr: booking.pnr, payment: p });
    }
    return out;
  }

  private async ticketFor(bookingId: string): Promise<string | undefined> {
    const all = await this.tickets.list({ limit: 500 });
    const forBooking = all.filter((t) => t.bookingId === bookingId && MANUAL_PAYMENT_METHODS.includes(t.reason as Payment['method']));
    return (forBooking.find((t) => t.status !== 'resolved') ?? forBooking[0])?.id;
  }

  private async record(ticketId: string, author: string, payment: Payment, decision: Decision, bookingStatus: Booking['status'] | undefined): Promise<void> {
    const what = payment.method === 'cash_office' ? 'Cash payment' : 'Bank transfer';
    const summary = decision.received
      ? `${what} RECEIVED: ${formatCharge(decision.amount)}, ${payment.method === 'cash_office' ? 'receipt' : 'bank reference'} ${decision.reference}. Booking is now ${bookingStatus ?? 'unknown'}.`
      : `${what} NOT RECEIVED. The traveller can pay another way while the hold lasts. Booking is now ${bookingStatus ?? 'unknown'}.`;
    await this.support.addNote(ticketId, author, decision.note ? `${summary} Note: ${decision.note}` : summary);
    await this.support.update(ticketId, { status: 'resolved' }, author);
  }
}

interface Candidate {
  pnr: string;
  payment: Payment;
}
