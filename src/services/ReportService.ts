import { AppError } from '../domain/errors.js';
import type { Booking, Payment } from '../domain/types.js';
import type { Clock } from '../lib/clock.js';
import { toCsv, type Cell } from '../lib/csv.js';
import { zonedToUtc } from '../lib/time.js';
import type { AgentUsageRepository, BookingRepository, PaymentRepository } from '../repositories/types.js';
import { MANUAL_REFUND_PREFIX } from './PaymentService.js';

/**
 * Finance exports for the accountant (CSV, opened in Excel or Google Sheets).
 * Days are Juba days (Africa/Juba). Amounts are in major units (e.g. 412.50)
 * so spreadsheets can add them up.
 *
 * - payments: every payment created or changed in the period (the ledger).
 * - daily: per day, bookings paid (with tickets), money received by method (by
 *   payment date), refunds completed (by refund date), refunds still owed and
 *   requests not yet paid (current state).
 * - refunds-owed: every refund not yet completed, with how long it has waited.
 * - ai-usage: per day, AI model calls, conversations, tokens and cost (USD).
 */

export type ReportKind = 'payments' | 'daily' | 'refunds-owed' | 'ai-usage';
const TZ = 'Africa/Juba';
const MAX_DAYS = 366;
const LIMIT = 50_000;

const major = (minor: number) => Math.round(minor) / 100;
const jubaDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const jubaTime = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);

const nextDay = (d: string): string => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function route(b: Booking | undefined): string {
  if (!b) return '';
  const path = (segs: Booking['offer']['segments']) => (segs.length ? [segs[0]?.origin, ...segs.map((s) => s.destination)].join('-') : '');
  // Round trip: "JUB-NBO / NBO-JUB"
  return [path(b.offer.segments), path(b.offer.returnSegments ?? [])].filter(Boolean).join(' / ');
}

export class ReportService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly bookings: BookingRepository,
    private readonly clock: Clock,
    private readonly agentUsage: AgentUsageRepository,
  ) {}

  /** UTC bounds of the Juba days [from, to] inclusive. */
  private bounds(from: string, to: string): { start: Date; end: Date } {
    const start = zonedToUtc(from, '00:00', TZ);
    const end = new Date(zonedToUtc(to, '00:00', TZ).getTime() + 86_400_000);
    if (!(start < end)) throw new AppError('VALIDATION_FAILED', 'The end date must be on or after the start date.');
    if (end.getTime() - start.getTime() > MAX_DAYS * 86_400_000) throw new AppError('VALIDATION_FAILED', `Choose at most ${MAX_DAYS} days.`);
    return { start, end };
  }

  private async withBookings(payments: Payment[]): Promise<Map<string, Booking>> {
    const list = await this.bookings.findByIds(payments.map((p) => p.bookingId));
    return new Map(list.map((b) => [b.id, b]));
  }

  async csv(kind: ReportKind, from: string, to: string): Promise<{ filename: string; body: string }> {
    switch (kind) {
      case 'payments':
        return { filename: `bluckflies-payments-${from}-to-${to}.csv`, body: await this.paymentsCsv(from, to) };
      case 'daily':
        return { filename: `bluckflies-daily-${from}-to-${to}.csv`, body: await this.dailyCsv(from, to) };
      case 'refunds-owed':
        return { filename: `bluckflies-refunds-owed-${jubaDay(this.clock.now().toISOString())}.csv`, body: await this.refundsOwedCsv() };
      case 'ai-usage':
        return { filename: `bluckflies-ai-usage-${from}-to-${to}.csv`, body: await this.aiUsageCsv(from, to) };
    }
  }

  private async paymentsCsv(from: string, to: string): Promise<string> {
    const { start, end } = this.bounds(from, to);
    const rows = await this.payments.listActiveBetween(start, end, LIMIT);
    const bookings = await this.withBookings(rows);
    return toCsv(
      ['Created (Juba)', 'Paid (Juba)', 'Refunded (Juba)', 'Last change (Juba)', 'Booking code', 'Route', 'Booking status', 'Method', 'Provider', 'Payment status', 'Amount USD', 'Charged', 'Charge currency', 'Exchange rate', 'Rate source', 'Provider reference', 'Refund reference', 'Payment id'],
      rows.map((p): Cell[] => {
        const b = bookings.get(p.bookingId);
        return [
          jubaTime(p.createdAt),
          p.paidAt ? jubaTime(p.paidAt) : undefined,
          p.refundedAt ? jubaTime(p.refundedAt) : undefined,
          jubaTime(p.updatedAt),
          b?.pnr,
          route(b),
          b?.status,
          p.method,
          p.provider,
          p.status,
          major(p.amount.amountCents),
          major(p.charge.amountMinor),
          p.charge.currency,
          p.fx?.perUsd,
          p.fx ? `${p.fx.source} ${p.fx.asOf.slice(0, 10)}` : undefined,
          p.providerReference,
          p.refundReference,
          p.id,
        ];
      }),
    );
  }

  private async dailyCsv(from: string, to: string): Promise<string> {
    const { start, end } = this.bounds(from, to);
    const rows = await this.payments.listActiveBetween(start, end, LIMIT);
    const days = new Map<string, { tickets: Set<string>; received: Map<string, number>; refundsRequested: number; refunded: number; outstanding: number }>();
    const day = (d: string) => {
      let v = days.get(d);
      if (!v) days.set(d, (v = { tickets: new Set(), received: new Map(), refundsRequested: 0, refunded: 0, outstanding: 0 }));
      return v;
    };
    // Every day of the period appears, even with no activity.
    for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) day(jubaDay(new Date(t + 12 * 3_600_000).toISOString()));
    const bookings = await this.withBookings(rows);
    const inPeriod = (iso: string) => Date.parse(iso) >= start.getTime() && Date.parse(iso) < end.getTime();
    for (const p of rows) {
      const usd = p.amount.amountCents;
      if (p.paidAt && inPeriod(p.paidAt)) {
        const d = day(jubaDay(p.paidAt));
        d.received.set(p.method, (d.received.get(p.method) ?? 0) + usd);
        const b = bookings.get(p.bookingId);
        if (b && (b.status === 'ticketed' || b.ticketNumbers.length > 0)) d.tickets.add(b.id);
      }
      if (p.refundedAt && inPeriod(p.refundedAt)) day(jubaDay(p.refundedAt)).refunded += usd;
      // Current state, dated by its last change: refunds still owed and requests not yet paid.
      if (p.status === 'refund_requested' && inPeriod(p.updatedAt)) day(jubaDay(p.updatedAt)).refundsRequested += usd;
      if (p.status === 'requested' && inPeriod(p.createdAt)) day(jubaDay(p.createdAt)).outstanding += usd;
    }
    const methods = ['card', 'bank_transfer', 'cash_office', 'mtn_momo', 'zain_mgurush'] as const;
    return toCsv(
      ['Day (Juba)', 'Bookings paid and ticketed', ...methods.map((m) => `Received ${m} (USD)`), 'Received total (USD)', 'Refund requested, still owed (USD)', 'Refunded (USD)', 'Requested that day, not yet paid (USD)'],
      [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, v]): Cell[] => [
          d,
          v.tickets.size,
          ...methods.map((m) => major(v.received.get(m) ?? 0)),
          major([...v.received.values()].reduce((a, b) => a + b, 0)),
          major(v.refundsRequested),
          major(v.refunded),
          major(v.outstanding),
        ]),
    );
  }

  private async aiUsageCsv(from: string, to: string): Promise<string> {
    this.bounds(from, to); // validates the range
    const rows = await this.agentUsage.daily(from, to);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out: Cell[][] = [];
    for (let d = from; d <= to; d = nextDay(d)) {
      const r = byDay.get(d);
      out.push([d, r?.calls ?? 0, r?.conversations ?? 0, r?.inputTokens ?? 0, r?.outputTokens ?? 0, r?.cacheWriteTokens ?? 0, r?.cacheReadTokens ?? 0, (r?.costMicros ?? 0) / 1_000_000]);
    }
    return toCsv(['Day (Juba)', 'AI calls', 'Conversations', 'Input tokens', 'Output tokens', 'Cache write tokens', 'Cache read tokens', 'Cost (USD)'], out);
  }

  private async refundsOwedCsv(): Promise<string> {
    const now = this.clock.now();
    const rows = await this.payments.findByStatus(['refund_requested'], LIMIT);
    const bookings = await this.withBookings(rows);
    return toCsv(
      ['Requested (Juba)', 'Days waiting', 'Booking code', 'Route', 'Method', 'Provider', 'Refund USD', 'Refund handled by', 'Refund reference', 'Payment id'],
      rows
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .map((p): Cell[] => {
          const b = bookings.get(p.bookingId);
          return [
            jubaTime(p.updatedAt),
            Math.floor((now.getTime() - Date.parse(p.updatedAt)) / 86_400_000),
            b?.pnr,
            route(b),
            p.method,
            p.provider,
            major(p.amount.amountCents),
            p.refundReference?.startsWith(MANUAL_REFUND_PREFIX) ? 'Staff (manual)' : 'Payment provider',
            p.refundReference,
            p.id,
          ];
        }),
    );
  }
}
