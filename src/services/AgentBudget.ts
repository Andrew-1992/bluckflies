import type { LlmUsage } from '../agent/llm.js';
import { costMicros, usd, type ModelPrices } from '../agent/pricing.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { AgentUsageRepository } from '../repositories/types.js';

/**
 * Spending limits for the AI assistant, checked before every model call and
 * metered after it, in Juba days:
 *
 * - daily: the whole service. At 80% ops get a warning; at 100% the assistant
 *   pauses until midnight Juba time. Travellers keep the step-by-step search
 *   and "call me".
 * - conversation: one session per day, so a loop, an abusive user or a very
 *   long chat cannot spend the day's budget alone.
 *
 * Totals live in the database, so every server enforces the same limits. Two
 * calls racing at the edge can overshoot by at most one call each, which is
 * bounded by the per-call token limit; that is accepted rather than locking.
 */

export type BudgetDecision = { ok: true } | { ok: false; scope: 'daily' | 'conversation' };

export interface AgentBudgetOptions {
  dailyUsd: number;
  conversationUsd: number;
  prices: ModelPrices;
  /** Share of the daily budget that triggers the ops warning. */
  warnAt?: number;
}

const TZ = 'Africa/Juba';

export class AgentBudget {
  private readonly dailyMicros: number;
  private readonly conversationMicros: number;
  private readonly warnMicros: number;

  constructor(
    private readonly usage: AgentUsageRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: AgentBudgetOptions,
  ) {
    this.dailyMicros = Math.round(opts.dailyUsd * 1_000_000);
    this.conversationMicros = Math.round(opts.conversationUsd * 1_000_000);
    this.warnMicros = Math.round(this.dailyMicros * (opts.warnAt ?? 0.8));
  }

  today(): string {
    return this.clock.now().toLocaleDateString('en-CA', { timeZone: TZ });
  }

  async check(sessionId: string): Promise<BudgetDecision> {
    const day = this.today();
    const [spent, conversation] = await Promise.all([this.usage.dayCostMicros(day), this.usage.sessionCostMicros(sessionId, day)]);
    if (spent >= this.dailyMicros) {
      // Alerted once per day (AlertService rule).
      this.log.error('agent.daily_budget_reached', { day, spentUsd: usd(spent), limitUsd: usd(this.dailyMicros) });
      return { ok: false, scope: 'daily' };
    }
    if (conversation >= this.conversationMicros) {
      this.log.warn('agent.conversation_budget_reached', { sessionId, day, spentUsd: usd(conversation), limitUsd: usd(this.conversationMicros) });
      return { ok: false, scope: 'conversation' };
    }
    return { ok: true };
  }

  /** Meters one call. Never throws: metering must not break a traveller's reply. */
  async record(sessionId: string, u: LlmUsage): Promise<void> {
    const cost = costMicros(u, this.opts.prices);
    const day = this.today();
    try {
      const before = await this.usage.dayCostMicros(day);
      await this.usage.add({ day, sessionId, ...u, costMicros: cost }, this.clock.now().toISOString());
      if (before < this.warnMicros && before + cost >= this.warnMicros) {
        this.log.error('agent.daily_budget_warning', { day, spentUsd: usd(before + cost), limitUsd: usd(this.dailyMicros) });
      }
    } catch (err) {
      this.log.warn('agent.usage_record_failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }
}
