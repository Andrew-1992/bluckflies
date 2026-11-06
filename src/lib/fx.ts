import type { ChargeAmount, FxQuote, Money } from '../domain/types.js';

/**
 * Exact currency conversion with integer (BigInt) arithmetic. Rates are kept
 * as decimal strings with up to 6 decimal places, never as floats.
 */

const RATE_SCALE = 1_000_000n;
const RATE = /^(\d{1,9})(?:\.(\d{1,6}))?$/;

/** "4612.5" → 4612500000n (rate × 10^6). Throws on anything that is not a plain positive decimal. */
export function parseRate(perUsd: string): bigint {
  const m = RATE.exec(perUsd.trim());
  if (!m || !m[1]) throw new Error(`Invalid exchange rate "${perUsd}"`);
  const scaled = BigInt(m[1]) * RATE_SCALE + BigInt((m[2] ?? '').padEnd(6, '0'));
  if (scaled <= 0n) throw new Error('Exchange rate must be positive');
  return scaled;
}

/** Normalises a rate string ("4612.500" → "4612.5"). */
export function formatRate(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const frac = (scaled % RATE_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Converts a USD fare into the charge currency, applying the markup and
 * rounding UP to a whole unit (wallets transact in whole pounds), so the payer
 * is never asked for a fraction and the business never undercollects.
 */
export function convertCharge(usd: Money, quote: Pick<FxQuote, 'currency' | 'perUsd' | 'markupBps'>): ChargeAmount {
  const rate = parseRate(quote.perUsd);
  const numerator = BigInt(usd.amountCents) * rate * BigInt(10_000 + quote.markupBps); // cents × rate×1e6 × bps
  const denominator = 100n * RATE_SCALE * 10_000n; // → whole currency units
  const units = (numerator + denominator - 1n) / denominator; // ceiling
  return { amountMinor: Number(units * 100n), currency: quote.currency };
}

/**
 * Share of an earlier charge to return when refunding `refundUsd` of a
 * `paidUsd` booking. Rounds DOWN (never refund more than was collected);
 * a full refund returns exactly the original charge.
 */
export function proportionalRefund(charge: ChargeAmount, paidUsd: Money, refundUsd: Money): ChargeAmount {
  if (refundUsd.amountCents >= paidUsd.amountCents) return { ...charge };
  const minor = (BigInt(charge.amountMinor) * BigInt(refundUsd.amountCents)) / BigInt(paidUsd.amountCents);
  return { amountMinor: Number(minor), currency: charge.currency };
}

export function formatCharge(c: ChargeAmount): string {
  const units = c.amountMinor / 100;
  return `${c.currency} ${units.toLocaleString('en-US', { minimumFractionDigits: c.amountMinor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
