import type { AppConfig } from '../config/env.js';
import type { LlmUsage } from './llm.js';

/**
 * Claude API prices in USD per million tokens, used to meter the assistant's
 * spend against the budgets (AGENT_DAILY_BUDGET_USD, AGENT_CONVERSATION_BUDGET_USD).
 *
 * The table holds the standard-context rates for the models BluckFlies is set
 * up for (cache write = the 5-minute rate, which is what the agent uses).
 * Anthropic changes prices: check https://platform.claude.com/docs/en/about-claude/pricing
 * and override with AGENT_PRICE_*_PER_MTOK when they differ. For a model not
 * in the table and no overrides, the most expensive known rates are used, so
 * the budget errs on the side of stopping early rather than overspending.
 */
export interface ModelPrices {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const KNOWN_MODEL_PRICES: Readonly<Record<string, ModelPrices>> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

const MOST_EXPENSIVE: ModelPrices = Object.values(KNOWN_MODEL_PRICES).reduce((a, b) => (b.output > a.output ? b : a));

export interface ResolvedPrices {
  prices: ModelPrices;
  source: 'table' | 'env' | 'fallback';
}

/** Overrides from env apply field by field on top of the table (or the fallback). */
export function pricesFor(model: string, overrides: Partial<ModelPrices> = {}): ResolvedPrices {
  const known = KNOWN_MODEL_PRICES[model];
  const { input, output } = overrides;
  if (input !== undefined && output !== undefined) {
    // Explicit rates. Cache rates default to Anthropic's ratios to the input rate (write 1.25x, read 0.1x).
    return { prices: { input, output, cacheWrite: overrides.cacheWrite ?? input * 1.25, cacheRead: overrides.cacheRead ?? input * 0.1 }, source: 'env' };
  }
  const base = known ?? MOST_EXPENSIVE;
  return { prices: { ...base, ...overrides }, source: known ? (Object.keys(overrides).length ? 'env' : 'table') : 'fallback' };
}

/**
 * Cost of one call in micro-USD (millionths of a dollar), rounded up.
 * tokens × (USD per million tokens) is exactly micro-USD.
 */
export function costMicros(u: LlmUsage, p: ModelPrices): number {
  return Math.ceil(u.inputTokens * p.input + u.outputTokens * p.output + u.cacheWriteTokens * p.cacheWrite + u.cacheReadTokens * p.cacheRead);
}

export const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(micros < 10_000_000 ? 4 : 2)}`;

/** Prices for the configured model, with any AGENT_PRICE_*_PER_MTOK overrides. */
export function configuredPrices(c: AppConfig): ResolvedPrices {
  const o: Partial<ModelPrices> = {};
  if (c.AGENT_PRICE_INPUT_PER_MTOK !== undefined) o.input = c.AGENT_PRICE_INPUT_PER_MTOK;
  if (c.AGENT_PRICE_OUTPUT_PER_MTOK !== undefined) o.output = c.AGENT_PRICE_OUTPUT_PER_MTOK;
  if (c.AGENT_PRICE_CACHE_WRITE_PER_MTOK !== undefined) o.cacheWrite = c.AGENT_PRICE_CACHE_WRITE_PER_MTOK;
  if (c.AGENT_PRICE_CACHE_READ_PER_MTOK !== undefined) o.cacheRead = c.AGENT_PRICE_CACHE_READ_PER_MTOK;
  return pricesFor(c.ANTHROPIC_MODEL, o);
}
