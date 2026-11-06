import { describe, expect, it } from 'vitest';
import { BUDGET_MESSAGES } from '../src/agent/Agent.js';
import type { LlmClient, LlmResponse, LlmUsage } from '../src/agent/llm.js';
import { costMicros, KNOWN_MODEL_PRICES, pricesFor } from '../src/agent/pricing.js';
import { loadConfig } from '../src/config/env.js';
import { isAppError } from '../src/domain/errors.js';
import type { EmailSender } from '../src/providers/notify/senders.js';
import type { ChannelSender, OutboundReply } from '../src/services/ChannelService.js';
import { parseCsv } from '../src/services/statements.js';
import { FixedClock, ScriptedLlm, testContainer } from './helpers.js';

const SONNET = KNOWN_MODEL_PRICES['claude-sonnet-5-5']!;
/** 10,000 output tokens on Sonnet 5.5 = $0.10. */
const DIME: LlmUsage = { inputTokens: 0, outputTokens: 10_000, cacheWriteTokens: 0, cacheReadTokens: 0 };
const reply = (text: string, usage: LlmUsage = DIME): LlmResponse => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage });

/** Answers every call with the same priced reply. */
class PricedLlm implements LlmClient {
  calls = 0;
  async createMessage(): Promise<LlmResponse> {
    this.calls++;
    return reply('Here you go.');
  }
}

class RecordingEmail implements EmailSender {
  readonly name = 'recording';
  readonly delivers = true;
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(m: { to: string; subject: string; text: string }) {
    this.sent.push(m);
  }
}

async function unavailable(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isAppError(err) && err.code === 'AGENT_UNAVAILABLE') return err.message;
    throw err;
  }
  throw new Error('expected AGENT_UNAVAILABLE');
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('AI model pricing', () => {
  it('prices every kind of token, in micro-dollars, rounding up', () => {
    expect(costMicros({ inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, SONNET)).toBe(2_000_000);
    expect(costMicros({ inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000, cacheReadTokens: 10_000 }, SONNET)).toBe(1000 * 2 + 500 * 10 + 2000 * 2.5 + 10_000 * 0.2);
    expect(costMicros({ inputTokens: 1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, KNOWN_MODEL_PRICES['claude-haiku-5-5']!)).toBe(1); // 0.1 → 1
  });

  it('uses the table, .env overrides, or the most expensive rates for an unknown model', () => {
    expect(pricesFor('claude-haiku-5-5')).toEqual({ prices: KNOWN_MODEL_PRICES['claude-haiku-5-5'], source: 'table' });
    expect(pricesFor('claude-future-9')).toEqual({ prices: SONNET, source: 'fallback' });
    expect(pricesFor('claude-future-9', { input: 1, output: 4 })).toEqual({ prices: { input: 1, output: 4, cacheWrite: 1.25, cacheRead: 0.1 }, source: 'env' });
    expect(pricesFor('claude-sonnet-5-5', { cacheRead: 0.1 })).toEqual({ prices: { ...SONNET, cacheRead: 0.1 }, source: 'env' });
  });

  it('rejects inconsistent budget settings at startup', () => {
    const base = { NODE_ENV: 'test', PAYMENT_WEBHOOK_SECRET: 'p'.repeat(40) };
    expect(() => loadConfig({ ...base, AGENT_DAILY_BUDGET_USD: '1', AGENT_CONVERSATION_BUDGET_USD: '2' })).toThrow(/cannot be larger/);
    expect(() => loadConfig({ ...base, AGENT_PRICE_INPUT_PER_MTOK: '1' })).toThrow(/together/);
    expect(() => loadConfig({ ...base, AGENT_DAILY_BUDGET_USD: '0' })).toThrow();
  });
});

describe('AI spending limits', () => {
  it('stops one conversation at its daily budget without affecting others, and resets at Juba midnight', async () => {
    const llm = new PricedLlm();
    const clock = new FixedClock(new Date('2026-10-30T10:00:00Z'));
    const { c } = testContainer({ llm, clock }, { AGENT_CONVERSATION_BUDGET_USD: '0.25', AGENT_DAILY_BUDGET_USD: '10' });
    const agent = c.agent!;
    for (let i = 0; i < 3; i++) await agent.handle('ses_owner', `message ${i}`); // $0.30 spent: the third call crossed the line
    expect(await unavailable(agent.handle('ses_owner', 'one more'))).toBe(BUDGET_MESSAGES.conversation);
    expect(llm.calls).toBe(3); // the model was not called once the limit was reached

    await expect(agent.handle('ses_other', 'hello')).resolves.toMatchObject({ reply: 'Here you go.' });

    clock.advanceMinutes(12 * 60 + 1); // 22:01 UTC = 00:01 next day in Juba
    await expect(agent.handle('ses_owner', 'good morning')).resolves.toMatchObject({ reply: 'Here you go.' });
  });

  it('pauses the assistant for everyone at the daily budget, and alerts ops at 80% and 100% once each', async () => {
    const llm = new PricedLlm();
    const email = new RecordingEmail();
    const { c } = testContainer({ llm, email }, { AGENT_DAILY_BUDGET_USD: '0.5', AGENT_CONVERSATION_BUDGET_USD: '0.5', OPS_ALERT_EMAILS: 'ops@bluckflies.com' });
    const agent = c.agent!;
    // Fixture sessions (they exist in the PostgreSQL test database too).
    for (const s of ['ses_owner', 'ses_card', 'ses_a', 'ses_b', 'ses_1']) await agent.handle(s, 'hi'); // 5 × $0.10 = $0.50
    for (const s of ['ses_other', 'ses_owner', 'ses_intruder']) expect(await unavailable(agent.handle(s, 'hi'))).toBe(BUDGET_MESSAGES.daily);
    expect(llm.calls).toBe(5);

    await settle();
    await c.notifications.dispatch();
    const subjects = email.sent.filter((m) => m.to === 'ops@bluckflies.com').map((m) => m.subject);
    expect(subjects.filter((s) => /80% of its daily budget/.test(s))).toHaveLength(1);
    expect(subjects.filter((s) => /daily budget reached/.test(s))).toHaveLength(1); // three refusals, one alert
  });

  it('closes a turn cleanly when the limit is reached between tool rounds', async () => {
    const search = { type: 'tool_use' as const, id: 'tu_1', name: 'find_airports', input: { query: 'Bor' } };
    const llm = new ScriptedLlm([{ content: [search], stopReason: 'tool_use', usage: { ...DIME, outputTokens: 30_000 } }]); // $0.30
    const { c } = testContainer({ llm }, { AGENT_CONVERSATION_BUDGET_USD: '0.25' });
    const r = await c.agent!.handle('ses_owner', 'Where is Bor?');
    expect(r.reply).toBe(BUDGET_MESSAGES.conversation);
    expect(r.toolsUsed).toEqual(['find_airports']);
    const saved = (await c.repos.conversations.load('ses_owner')) as Array<{ role: string; content: unknown }>;
    expect(saved.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']); // tool_use answered, then the closing text
  });

  it('reports AI usage per day for the accountant', async () => {
    const clock = new FixedClock(new Date('2026-10-30T10:00:00Z'));
    const { c } = testContainer({ llm: new PricedLlm(), clock });
    await c.agent!.handle('ses_a', 'hi');
    await c.agent!.handle('ses_a', 'again');
    await c.agent!.handle('ses_b', 'hi');
    const { body, filename } = await c.reports.csv('ai-usage', '2026-10-29', '2026-10-30');
    expect(filename).toBe('bluckflies-ai-usage-2026-10-29-to-2026-10-30.csv');
    const rows = parseCsv(body);
    expect(rows[0]).toEqual(['Day (Juba)', 'AI calls', 'Conversations', 'Input tokens', 'Output tokens', 'Cache write tokens', 'Cache read tokens', 'Cost (USD)']);
    expect(rows[1]).toEqual(['2026-10-29', '0', '0', '0', '0', '0', '0', '0']);
    expect(rows[2]).toEqual(['2026-10-30', '3', '2', '0', '30000', '0', '0', '0.3']);
  });

  it('adds up concurrent model calls without losing any (several servers at once)', async () => {
    const { c } = testContainer();
    const at = new Date().toISOString();
    await Promise.all(Array.from({ length: 25 }, () => c.repos.agentUsage.add({ day: '2026-10-30', sessionId: 'ses_owner', inputTokens: 100, outputTokens: 10, cacheWriteTokens: 1, cacheReadTokens: 1000, costMicros: 777 }, at)));
    const [day] = await c.repos.agentUsage.daily('2026-10-30', '2026-10-30');
    expect(day).toEqual({ day: '2026-10-30', calls: 25, conversations: 1, inputTokens: 2500, outputTokens: 250, cacheWriteTokens: 25, cacheReadTokens: 25_000, costMicros: 25 * 777 });
    expect(await c.repos.agentUsage.sessionCostMicros('ses_owner', '2026-10-30')).toBe(25 * 777);
    expect(await c.repos.agentUsage.dayCostMicros('2026-10-31')).toBe(0);
  });

  it('on WhatsApp, asks a person to call back (one desk ticket a day) instead of a dead end', async () => {
    const { c } = testContainer({ llm: new PricedLlm() }, { AGENT_DAILY_BUDGET_USD: '0.1', AGENT_CONVERSATION_BUDGET_USD: '0.1' });
    const out: Array<{ to: string; reply: OutboundReply }> = [];
    const sender: ChannelSender = { send: async (to, reply) => void out.push({ to, reply }) };
    const from = '+211955123456';
    const say = (id: string, text: string) => c.channels!.handleInbound('whatsapp', { id, from, kind: 'text', text }, sender);
    await say('m1', 'Flights Juba to Nairobi?'); // $0.10: limit reached
    await say('m2', 'Hello?');
    await say('m3', 'مرحبا');
    expect(out.map((m) => m.reply.text)).toEqual([
      'Here you go.',
      'Our assistant is not available right now. We have asked a BluckFlies agent to contact you on this number soon.',
      'المساعد غير متاح الآن. طلبنا من موظف في بلك فلايز أن يتصل بك على هذا الرقم قريباً.',
    ]);
    const tickets = (await c.support.list('open')).filter((t) => t.reason === 'callback_request');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.summary).toContain('They wrote: "Hello?"');
  });
});
