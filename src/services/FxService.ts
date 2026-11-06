import { AppError } from '../domain/errors.js';
import type { FxQuote } from '../domain/types.js';
import type { Clock } from '../lib/clock.js';
import { formatRate, parseRate } from '../lib/fx.js';
import type { Logger } from '../lib/logger.js';
import type { FxRateRecord, FxRateRepository } from '../repositories/types.js';

const HOUR = 3_600_000;
/** A new rate further than this from the current one must be explicitly confirmed (typo guard). */
const LARGE_CHANGE_BPS = 2_500n; // 25%

export interface FxOptions {
  /** Rate from configuration, used until an operator enters one. */
  bootstrap?: FxRateRecord;
  /** Charges are refused when the newest rate is older than this. */
  maxAgeHours: number;
  /** Markup on the rate for charges, in basis points, to absorb movement before settlement. */
  markupBps: number;
}

export interface FxRateInput {
  currency: string;
  perUsd: string;
  asOf: string;
  source: string;
  confirmLargeChange?: boolean;
}

/**
 * Exchange rates for charging in local currency. The SSP moves quickly and has
 * no reliable public feed, so operators enter the rate (e.g. the Bank of South
 * Sudan daily rate) through the admin API; every change is kept with its
 * source. Charges are refused on a stale rate rather than guessing.
 */
export class FxService {
  constructor(
    private readonly repo: FxRateRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: FxOptions,
  ) {}

  async current(currency: string): Promise<FxRateRecord | undefined> {
    const stored = await this.repo.latest(currency);
    const boot = this.opts.bootstrap?.currency === currency ? this.opts.bootstrap : undefined;
    if (stored && boot) return Date.parse(stored.asOf) >= Date.parse(boot.asOf) ? stored : boot;
    return stored ?? boot;
  }

  private ageHours(rate: FxRateRecord): number {
    return (this.clock.now().getTime() - Date.parse(rate.asOf)) / HOUR;
  }

  /** Locks a rate for a charge in `currency`, or refuses if none is current. */
  async quoteForCharge(currency: string): Promise<FxQuote> {
    const rate = await this.current(currency);
    if (!rate || this.ageHours(rate) > this.opts.maxAgeHours) {
      this.log.error('fx.rate_stale', { currency, asOf: rate?.asOf ?? null });
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        `Payments in ${currency} are paused until today's exchange rate is updated. Card payment in USD is available.`,
      );
    }
    return { currency, perUsd: rate.perUsd, asOf: rate.asOf, source: rate.source, markupBps: this.opts.markupBps };
  }

  /** Indicative display rate (may be stale; callers show its date). */
  async displayRate(currency: string): Promise<{ perUsd: string; asOf: string } | undefined> {
    const r = await this.current(currency);
    return r ? { perUsd: r.perUsd, asOf: r.asOf } : undefined;
  }

  async setRate(input: FxRateInput): Promise<FxRateRecord> {
    const currency = input.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || currency === 'USD') throw new AppError('VALIDATION_FAILED', 'currency must be a 3-letter code other than USD.');
    let scaled: bigint;
    try {
      scaled = parseRate(input.perUsd);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'perUsd must be a positive decimal with at most 6 decimal places, e.g. "4612.5".');
    }
    const asOf = Date.parse(input.asOf);
    const now = this.clock.now().getTime();
    if (Number.isNaN(asOf)) throw new AppError('VALIDATION_FAILED', 'asOf must be an ISO 8601 timestamp.');
    if (asOf > now + 5 * 60_000) throw new AppError('VALIDATION_FAILED', 'asOf cannot be in the future.');
    if (asOf < now - 7 * 24 * HOUR) throw new AppError('VALIDATION_FAILED', 'asOf is more than 7 days old; enter a current rate.');
    const source = input.source.trim();
    if (source.length < 3 || source.length > 200) throw new AppError('VALIDATION_FAILED', 'source must describe where the rate came from (3–200 characters).');

    const previous = await this.current(currency);
    if (previous && !input.confirmLargeChange) {
      const prev = parseRate(previous.perUsd);
      const diff = scaled > prev ? scaled - prev : prev - scaled;
      if (diff * 10_000n > prev * LARGE_CHANGE_BPS) {
        const pct = Number((diff * 10_000n) / prev) / 100;
        throw new AppError('VALIDATION_FAILED', `The new rate differs from the current ${previous.perUsd} by ${pct.toFixed(1)}%. If this is correct, resend with "confirmLargeChange": true.`);
      }
    }
    const record: FxRateRecord = { currency, perUsd: formatRate(scaled), asOf: new Date(asOf).toISOString(), source };
    await this.repo.insert(record);
    this.log.info('fx.rate_set', { currency, perUsd: record.perUsd, asOf: record.asOf, source });
    return record;
  }

  async history(currency: string): Promise<FxRateRecord[]> {
    return this.repo.history(currency.toUpperCase(), 20);
  }
}
