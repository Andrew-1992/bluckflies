import { loadConfig } from '../src/config/env.js';
import { buildContainer, type Overrides } from '../src/container.js';
import type { AgentBlock, LlmClient, LlmResponse } from '../src/agent/llm.js';
import type { Clock } from '../src/lib/clock.js';
import { silentLogger } from '../src/lib/logger.js';
import type { Passenger } from '../src/domain/types.js';
import { testDb } from './support/testDb.js';

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMinutes(m: number): void {
    this.current = new Date(this.current.getTime() + m * 60_000);
  }
}

export const NOW = new Date('2026-10-30T10:00:00Z');
export const FRIDAY = '2026-11-06';

export function testConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PAYMENT_WEBHOOK_SECRET: 'test-secret-test-secret-test-secret-0123',
    ENABLE_SANDBOX_ENDPOINTS: 'true',
    // A current SSP rate (2 hours before NOW) so mobile money can charge in SSP.
    SSP_PER_USD: '4600',
    SSP_RATE_AS_OF: '2026-10-30T08:00:00Z',
    SSP_RATE_SOURCE: 'test fixture',
    ...extra,
  });
}

/**
 * Builds the app container on the in-memory store, or on this test file's
 * PostgreSQL database when running `npm run test:pg`.
 */
export function testContainer(overrides: Overrides = {}, env: Record<string, string> = {}) {
  const clock = overrides.clock instanceof FixedClock ? overrides.clock : new FixedClock(NOW);
  const pg = testDb();
  const dbEnv = pg ? { DATABASE_URL: pg.url, DATA_ENCRYPTION_KEYS: pg.keyring } : {};
  const c = buildContainer(testConfig({ ...dbEnv, ...env }), silentLogger, {
    clock,
    ...(pg ? { repositories: pg.repos } : {}),
    ...overrides,
  });
  return { c, clock };
}

/** Scripted LLM: each call returns the next response; records requests for assertions. */
export class ScriptedLlm implements LlmClient {
  readonly requests: Parameters<LlmClient['createMessage']>[0][] = [];
  constructor(private readonly script: Array<LlmResponse | ((req: Parameters<LlmClient['createMessage']>[0]) => LlmResponse)>) {}
  async createMessage(req: Parameters<LlmClient['createMessage']>[0]): Promise<LlmResponse> {
    // The callback and stop signal cannot be cloned; tests read them from the live request.
    const { onText: _onText, signal: _signal, ...data } = req;
    this.requests.push(structuredClone(data));
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedLlm: script exhausted');
    return typeof next === 'function' ? next(req) : next;
  }
}

export const text = (t: string): LlmResponse => ({ content: [{ type: 'text', text: t }], stopReason: 'end_turn' });
export const toolCall = (name: string, input: unknown, id = `tu_${name}`): LlmResponse => ({
  content: [{ type: 'tool_use', id, name, input } satisfies AgentBlock],
  stopReason: 'tool_use',
});

export const adult = (over: Partial<Passenger> = {}): Passenger => ({
  type: 'adult',
  givenName: 'Akol',
  familyName: 'Deng',
  gender: 'm',
  dateOfBirth: '1990-05-12',
  nationality: 'SS',
  passportNumber: 'R00123456',
  passportExpiry: '2030-01-01',
  ...over,
});

export const CONTACT = { phone: '+211912345678', email: 'akol.deng@example.com' };

/** One adult traveller, the common search case. */
export const ONE_ADULT = { adults: 1, childAges: [] as number[], infants: 0 };
