import { createHash } from 'node:crypto';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';

/**
 * Fixed-window rate limiting shared by every server.
 *
 * Counters live in the database (one atomic upsert per request), so limits
 * hold across several servers and restarts. Keys are hashed before storage:
 * they contain IP addresses, session IDs and phone numbers.
 *
 * If the shared store fails (database blip), each server falls back to its own
 * in-memory counters, so protection weakens to per-server for that moment but
 * never switches off. A database outage must not also block every request.
 */

export interface RateLimitHit {
  count: number;
  resetAt: Date;
}

export interface RateLimitStore {
  /** Counts one request against `keyHash` in the current window (atomic). */
  hit(keyHash: string, windowMs: number, now: Date): Promise<RateLimitHit>;
  /** Deletes windows that ended before `before`. */
  deleteExpired(before: Date): Promise<number>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly rows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxKeys = 50_000) {}

  async hit(keyHash: string, windowMs: number, now: Date): Promise<RateLimitHit> {
    const t = now.getTime();
    let e = this.rows.get(keyHash);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + windowMs };
      this.rows.set(keyHash, e);
    }
    e.count += 1;
    if (this.rows.size > this.maxKeys) await this.deleteExpired(now);
    return { count: e.count, resetAt: new Date(e.resetAt) };
  }

  async deleteExpired(before: Date): Promise<number> {
    let n = 0;
    for (const [k, v] of this.rows) {
      if (v.resetAt <= before.getTime()) {
        this.rows.delete(k);
        n++;
      }
    }
    return n;
  }
}

export interface Limit {
  windowMs: number;
  max: number;
}

export type LimitDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

const WARN_EVERY_MS = 60_000;

export class RateLimiter {
  private readonly fallback = new MemoryRateLimitStore();
  private lastWarnAt = 0;

  constructor(
    private readonly shared: RateLimitStore,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** Counts one request for `key` (e.g. "chat:ses_…") and says whether it is within `limit`. */
  async consume(key: string, limit: Limit): Promise<LimitDecision> {
    const now = this.clock.now();
    // The window length is part of the key, so two limits on the same name never share a counter.
    const keyHash = createHash('sha256').update(`${limit.windowMs}|${key}`).digest('hex');
    let hit: RateLimitHit;
    try {
      hit = await this.shared.hit(keyHash, limit.windowMs, now);
    } catch (err) {
      if (now.getTime() - this.lastWarnAt >= WARN_EVERY_MS) {
        this.lastWarnAt = now.getTime();
        this.log.warn('ratelimit.shared_store_failed', { err: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
      hit = await this.fallback.hit(keyHash, limit.windowMs, now);
    }
    if (hit.count <= limit.max) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((hit.resetAt.getTime() - now.getTime()) / 1000)) };
  }

  async deleteExpired(): Promise<number> {
    const now = this.clock.now();
    await this.fallback.deleteExpired(now);
    return this.shared.deleteExpired(now);
  }
}
