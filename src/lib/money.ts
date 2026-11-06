import { convertCharge, formatCharge } from './fx.js';
import type { Money } from '../domain/types.js';

export const formatUsd = (m: Money): string => `USD ${(m.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Indicative South Sudanese Pound equivalent for display, with the rate's date.
 * The amount actually charged to a wallet is locked when payment is requested.
 */
export const indicativeSsp = (m: Money, rate: { perUsd: string; asOf: string }): string =>
  `≈ ${formatCharge(convertCharge(m, { currency: 'SSP', perUsd: rate.perUsd, markupBps: 0 }))} (rate of ${rate.asOf.slice(0, 10)})`;

/** "1,234.5" → 123450 minor units. Undefined for anything that is not a plain non-negative amount. */
export function parseMinorUnits(amount: string | undefined): number | undefined {
  const clean = amount?.replace(/,/g, '').trim();
  if (!clean || !/^\d{1,12}(\.\d{1,2})?$/.test(clean)) return undefined;
  const [whole = '0', frac = ''] = clean.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
