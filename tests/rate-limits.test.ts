import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import type { Logger } from '../src/lib/logger.js';
import { silentLogger } from '../src/lib/logger.js';
import { MemoryRateLimitStore, RateLimiter, type RateLimitHit, type RateLimitStore } from '../src/lib/rateLimiter.js';
import { FixedClock, NOW, testContainer } from './helpers.js';

/** Two servers: separate apps and containers over the same database (or memory store). */
function twoServers() {
  const clock = new FixedClock(NOW);
  const a = testContainer({ clock });
  const b = testContainer({ clock, repositories: a.c.repos });
  return { clock, a: createApp(a.c), b: createApp(b.c), repos: a.c.repos };
}

class RecordingStore implements RateLimitStore {
  readonly keys: string[] = [];
  private readonly inner = new MemoryRateLimitStore();
  fail = false;
  async hit(keyHash: string, windowMs: number, now: Date): Promise<RateLimitHit> {
    if (this.fail) throw new Error('connection refused');
    this.keys.push(keyHash);
    return this.inner.hit(keyHash, windowMs, now);
  }
  deleteExpired(before: Date) {
    return this.inner.deleteExpired(before);
  }
}

function recordingLog(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { ...silentLogger, warnings, warn: (event: string) => void warnings.push(event) };
}

describe('shared rate limits', () => {
  it('counts requests on every server against one limit, then resets after the window', async () => {
    const { clock, a, b } = twoServers();
    // New sessions: 20 per minute per address, wherever the request lands.
    for (let i = 0; i < 10; i++) {
      await request(a).post('/api/sessions').expect(201);
      await request(b).post('/api/sessions').expect(201);
    }
    const limited = await request(a).post('/api/sessions').expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await request(b).post('/api/sessions').expect(429);

    clock.advanceMinutes(1);
    await request(b).post('/api/sessions').expect(201);
  });

  it('never loses a count under concurrent requests (several servers at once)', async () => {
    const { repos } = twoServers();
    const key = 'a'.repeat(64);
    const hits = await Promise.all(Array.from({ length: 40 }, () => repos.rateLimits.hit(key, 60_000, NOW)));
    expect(hits.map((h) => h.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(new Set(hits.map((h) => h.resetAt.getTime()))).toEqual(new Set([NOW.getTime() + 60_000]));
  });

  it('starts a new window once the old one ends, and cleanup deletes only ended windows', async () => {
    const { repos } = twoServers();
    const [old, live] = ['b'.repeat(64), 'c'.repeat(64)];
    await repos.rateLimits.hit(old, 60_000, NOW);
    await repos.rateLimits.hit(old, 60_000, NOW);
    await repos.rateLimits.hit(live, 10 * 60_000, NOW);
    const later = new Date(NOW.getTime() + 2 * 60_000);
    expect(await repos.rateLimits.deleteExpired(later)).toBe(1);
    expect((await repos.rateLimits.hit(old, 60_000, later)).count).toBe(1);
    expect((await repos.rateLimits.hit(live, 10 * 60_000, later)).count).toBe(2);
  });

  it('stores only hashes, never IP addresses, sessions or phone numbers, and keeps limits apart', async () => {
    const store = new RecordingStore();
    const limiter = new RateLimiter(store, new FixedClock(NOW), silentLogger);
    await limiter.consume('otp-start:203.0.113.7', { windowMs: 60_000, max: 5 });
    await limiter.consume('whatsapp-sender:+211955123456', { windowMs: 60_000, max: 5 });
    await limiter.consume('otp-start:203.0.113.7', { windowMs: 10 * 60_000, max: 5 }); // other window, other counter
    expect(store.keys).toHaveLength(3);
    for (const k of store.keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(store.keys).size).toBe(3);
  });

  it('keeps limiting per server if the database fails, and warns at most once a minute', async () => {
    const store = new RecordingStore();
    store.fail = true;
    const clock = new FixedClock(NOW);
    const log = recordingLog();
    const limiter = new RateLimiter(store, clock, log);
    const limit = { windowMs: 60_000, max: 3 };
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await limiter.consume('chat:ses_1', limit)).allowed);
    expect(results).toEqual([true, true, true, false, false]);
    expect(log.warnings).toEqual(['ratelimit.shared_store_failed']);
    clock.advanceMinutes(1);
    await limiter.consume('chat:ses_1', limit);
    expect(log.warnings).toHaveLength(2);

    store.fail = false; // database back: the shared counters are used again
    expect((await limiter.consume('chat:ses_1', limit)).allowed).toBe(true);
    expect(store.keys).toHaveLength(1);
  });

  it('limits each visitor separately behind a load balancer, without trusting addresses visitors make up', async () => {
    const { c } = testContainer({}, { TRUST_PROXY_HOPS: '2' });
    const app = createApp(c);
    // X-Forwarded-For as received from: visitor's own (possibly fake) entries, then the load balancer's view.
    const via = (visitor: string, fake = '') => request(app).post('/api/sessions').set('x-forwarded-for', `${fake}${visitor}, 10.0.0.2`);
    for (let i = 0; i < 20; i++) await via('198.51.100.1').expect(201);
    await via('198.51.100.1').expect(429);
    await via('198.51.100.1', '203.0.113.99, ').expect(429); // a made-up address in front changes nothing
    await via('198.51.100.2').expect(201); // another visitor is not affected
  });
});

