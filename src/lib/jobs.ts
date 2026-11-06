import { randomUUID } from 'node:crypto';
import type { JobLeaseRepository } from '../repositories/types.js';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';

export interface JobDefinition {
  name: string;
  intervalMs: number;
  run(): Promise<unknown>;
}

/**
 * Runs periodic jobs inside each app instance. A database lease ensures only
 * one instance runs a given job at a time; within an instance a job never
 * overlaps itself. Jobs must be idempotent: a lease can lapse mid-run if a
 * run takes longer than its interval.
 */
export class JobScheduler {
  readonly instanceId = `inst_${randomUUID()}`;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly jobs: readonly JobDefinition[],
    private readonly leases: JobLeaseRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  start(): void {
    for (const job of this.jobs) {
      // Jitter the first run so instances started together don't collide.
      const first = setTimeout(() => void this.tick(job), Math.floor(Math.random() * Math.min(job.intervalMs, 10_000)));
      const every = setInterval(() => void this.tick(job), job.intervalMs);
      first.unref();
      every.unref();
      this.timers.push(first, every);
    }
    this.log.info('jobs.started', { instanceId: this.instanceId, jobs: this.jobs.map((j) => j.name) });
  }

  /** Runs one job now (used by tests and the CLI). Returns false if skipped. */
  async tick(job: JobDefinition): Promise<boolean> {
    if (this.stopped || this.running.has(job.name)) return false;
    const now = this.clock.now();
    const acquired = await this.leases
      .tryAcquire(job.name, this.instanceId, new Date(now.getTime() + job.intervalMs * 2), now)
      .catch((err: unknown) => {
        this.log.warn('jobs.lease_error', { job: job.name, err: String(err) });
        return false;
      });
    if (!acquired) return false;

    const run = (async () => {
      const started = Date.now();
      try {
        const result = await job.run();
        this.log.info('jobs.completed', { job: job.name, ms: Date.now() - started, result });
      } catch (err) {
        this.log.error('jobs.failed', { job: job.name, err: err instanceof Error ? err.message : String(err) });
      } finally {
        this.running.delete(job.name);
      }
    })();
    this.running.set(job.name, run);
    await run;
    return true;
  }

  /** Stops scheduling, waits for in-flight runs, and releases leases. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    await Promise.allSettled(this.running.values());
    await Promise.allSettled(this.jobs.map((j) => this.leases.release(j.name, this.instanceId)));
  }
}
