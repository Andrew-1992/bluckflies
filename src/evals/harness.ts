import type { AgentBlock, LlmClient, LlmResponse, LlmUsage } from '../agent/llm.js';
import type { Channel } from '../agent/systemPrompt.js';
import { loadConfig } from '../config/env.js';
import { buildContainer } from '../container.js';
import { isAppError } from '../domain/errors.js';
import { hashToken, newId, newSessionToken } from '../lib/ids.js';
import { silentLogger } from '../lib/logger.js';

/**
 * AI quality checks ("evals"): scripted conversations run through the real
 * agent loop, tools and sandbox flights, against a model (the real Claude API
 * from `npm run eval`, or a scripted fake in the unit tests). Each scenario
 * states what a good assistant must and must not do; a scenario passes only if
 * every check passes.
 *
 * Every run uses a fresh in-memory store and sandbox airlines, so evals never
 * touch real bookings, payments or travellers.
 */

export interface ToolUse {
  name: string;
  input: unknown;
}

export interface EvalRun {
  /** One reply per user turn (the error message if the turn failed). */
  replies: string[];
  tools: ToolUse[];
  /** Error code of a failed turn, if any. */
  errors: string[];
  usage: LlmUsage;
  /** Bookings created in this run (holds, not tickets: approval needs the traveller's tap). */
  bookings: number;
}

export interface Check {
  name: string;
  pass(run: EvalRun): boolean;
}

export interface Scenario {
  id: string;
  title: string;
  channel?: Channel;
  turns: string[];
  checks: Check[];
}

export interface ScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  failed: string[];
  run: EvalRun;
}

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

/** Passes calls through and records tool calls and token usage. */
export class RecordingLlm implements LlmClient {
  readonly tools: ToolUse[] = [];
  usage: LlmUsage = { ...ZERO };
  constructor(private readonly inner: LlmClient) {}
  async createMessage(req: Parameters<LlmClient['createMessage']>[0]): Promise<LlmResponse> {
    const res = await this.inner.createMessage(req);
    for (const b of res.content) if (b.type === 'tool_use') this.tools.push({ name: b.name, input: b.input });
    if (res.usage) {
      const u = res.usage;
      this.usage = {
        inputTokens: this.usage.inputTokens + u.inputTokens,
        outputTokens: this.usage.outputTokens + u.outputTokens,
        cacheWriteTokens: this.usage.cacheWriteTokens + u.cacheWriteTokens,
        cacheReadTokens: this.usage.cacheReadTokens + u.cacheReadTokens,
      };
    }
    return res;
  }
}

export async function runScenario(s: Scenario, model: LlmClient, opts: { modelName?: string } = {}): Promise<ScenarioResult> {
  const llm = new RecordingLlm(model);
  const config = loadConfig({
    NODE_ENV: 'development',
    PAYMENT_WEBHOOK_SECRET: newSessionToken(),
    JOBS_ENABLED: 'false',
    ...(opts.modelName ? { ANTHROPIC_MODEL: opts.modelName } : {}),
    // Evals have their own spending guard (--max-usd); don't let a shared limit cut a scenario short.
    AGENT_DAILY_BUDGET_USD: '100',
    AGENT_CONVERSATION_BUDGET_USD: '100',
  });
  const c = buildContainer(config, silentLogger, { llm });
  if (!c.agent) throw new Error('Eval container has no agent.');
  const now = new Date().toISOString();
  const sessionId = newId('ses');
  await c.repos.sessions.create({
    id: sessionId,
    tokenHash: hashToken(newSessionToken()),
    createdAt: now,
    lastSeenAt: now,
    ...(s.channel === 'whatsapp' || s.channel === 'sms' ? { channel: s.channel, channelKey: hashToken(`eval:${sessionId}`) } : {}),
  });

  const replies: string[] = [];
  const errors: string[] = [];
  for (const turn of s.turns) {
    try {
      const r = await c.agent.handle(sessionId, turn, s.channel ? { channel: s.channel } : {});
      replies.push(r.reply);
    } catch (err) {
      if (!isAppError(err)) throw err;
      errors.push(err.code);
      replies.push(err.message);
    }
  }
  const run: EvalRun = { replies, tools: llm.tools, errors, usage: llm.usage, bookings: (await c.repos.bookings.listBySession(sessionId)).length };
  const failed = s.checks.filter((ch) => !safePass(ch, run)).map((ch) => ch.name);
  return { id: s.id, title: s.title, passed: failed.length === 0, failed, run };
}

function safePass(ch: Check, run: EvalRun): boolean {
  try {
    return ch.pass(run);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- check helpers

const allText = (r: EvalRun) => r.replies.join('\n');
const inputText = (t: ToolUse) => JSON.stringify(t.input ?? {});

export const check = {
  noErrors: (): Check => ({ name: 'every turn answered without an error', pass: (r) => r.errors.length === 0 }),
  called: (tool: string, where?: (input: Record<string, unknown>) => boolean, label?: string): Check => ({
    name: label ?? `calls ${tool}`,
    pass: (r) => r.tools.some((t) => t.name === tool && (!where || where((t.input ?? {}) as Record<string, unknown>))),
  }),
  notCalled: (tool: string, label?: string): Check => ({ name: label ?? `does not call ${tool}`, pass: (r) => !r.tools.some((t) => t.name === tool) }),
  noTools: (label = 'answers without tools'): Check => ({ name: label, pass: (r) => r.tools.length === 0 }),
  says: (re: RegExp, label: string): Check => ({ name: label, pass: (r) => re.test(allText(r)) }),
  neverSays: (re: RegExp, label: string): Check => ({ name: label, pass: (r) => !re.test(allText(r)) }),
  /** Secrets the traveller typed must not reach any tool. */
  neverSendsToTools: (re: RegExp, label: string): Check => ({ name: label, pass: (r) => !r.tools.some((t) => re.test(inputText(t))) }),
  noBookings: (): Check => ({ name: 'creates no booking', pass: (r) => r.bookings === 0 }),
  custom: (name: string, pass: (r: EvalRun) => boolean): Check => ({ name, pass }),
};

/** Share of letters in Arabic script (digits and punctuation are not letters; codes like JUB count as Latin). */
export function arabicShare(text: string): number {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) return 0;
  return letters.filter((ch) => /\p{Script=Arabic}/u.test(ch)).length / letters.length;
}

export type { AgentBlock };
