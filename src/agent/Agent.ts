import { AppError, isAppError } from '../domain/errors.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { ConversationRepository } from '../repositories/types.js';
import type { AgentBudget } from '../services/AgentBudget.js';
import type { SearchResult } from '../services/FlightSearchService.js';
import type { AgentBlock, AgentMessage, LlmClient, LlmResponse } from './llm.js';
import { buildSystemPrompt, type Channel } from './systemPrompt.js';
import type { ToolExecutor } from './ToolExecutor.js';
import { toolDefinitions, type ToolDefinition } from './tools.js';

export interface AgentTurnResult {
  reply: string;
  toolsUsed: string[];
  /** The last successful flight search in this turn, so the client can show the offers as cards. */
  search?: SearchResult;
  /** Every successful search in this turn, in order (e.g. outbound then return). */
  searches: SearchResult[];
}

/**
 * Progress of one turn, for clients that show it while they wait (the web chat
 * over server-sent events). `step` names the tool being used; `route` is set
 * only for flight searches, from airport codes the model passed.
 */
export type AgentEvent =
  | { type: 'step'; tool: string; route?: { from: string; to: string } }
  | { type: 'text'; delta: string };

export interface HandleOptions {
  channel?: Channel;
  onEvent?: (event: AgentEvent) => void;
  /**
   * The traveller pressed Stop. Checked before each model call and passed to
   * it; a tool that has started (a reservation, a payment request) always
   * finishes, so nothing is left half done.
   */
  signal?: AbortSignal;
}

/** Saved as the assistant's reply when the traveller stops a turn, so the history stays valid. */
export const STOPPED_TEXT = '(The traveller stopped this reply.)';

const AIRPORT_CODE = /^[A-Z]{3,4}$/;

function stepOf(name: string, input: unknown): AgentEvent {
  if (name === 'search_flights' && input && typeof input === 'object') {
    const { origin, destination } = input as { origin?: unknown; destination?: unknown };
    if (typeof origin === 'string' && typeof destination === 'string' && AIRPORT_CODE.test(origin) && AIRPORT_CODE.test(destination)) {
      return { type: 'step', tool: name, route: { from: origin, to: destination } };
    }
  }
  return { type: 'step', tool: name };
}

const MAX_HISTORY_MESSAGES = 40;
const MAX_TOKENS = 1500;

/** Shown when a spending limit is reached; the client then offers step-by-step search and "call me". */
export const BUDGET_MESSAGES = {
  daily: 'The BluckFlies assistant is resting until tomorrow. You can still find flights step by step, or ask us to call you.',
  conversation: 'This chat has reached its limit for today. You can still find flights step by step, or ask us to call you. The assistant is available again tomorrow.',
} as const;

/**
 * Keeps the most recent history without splitting a tool_use from its
 * tool_result: the cut always lands on a plain user text message.
 */
export function trimHistory(messages: AgentMessage[], max = MAX_HISTORY_MESSAGES): AgentMessage[] {
  if (messages.length <= max) return messages;
  for (let start = messages.length - max; start < messages.length; start++) {
    const m = messages[start];
    if (m && m.role === 'user' && typeof m.content === 'string') return messages.slice(start);
  }
  return messages.slice(-1);
}

export class BluckFliesAgent {
  private readonly tools: ToolDefinition[] = toolDefinitions();
  /** Serialises turns per session so concurrent requests cannot interleave history. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly llm: LlmClient,
    private readonly executor: ToolExecutor,
    private readonly conversations: ConversationRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: { maxToolIterations: number; sandbox: boolean; budget?: AgentBudget },
  ) {}

  async handle(sessionId: string, userText: string, opts: HandleOptions = {}): Promise<AgentTurnResult> {
    if (this.inFlight.has(sessionId)) throw new AppError('CONFLICT', 'Please wait for the previous reply to finish.');
    const turn = this.runTurn(sessionId, userText, opts);
    this.inFlight.set(sessionId, turn);
    try {
      return await turn;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /**
   * The AI provider can fail (outage, rate limit, exhausted credit, revoked
   * key). Travellers get a clear "assistant unavailable" answer; operators get
   * an alert (agent.provider_error) with the status code.
   */
  private async callModel(req: Parameters<LlmClient['createMessage']>[0]): Promise<LlmResponse | 'stopped'> {
    try {
      return await this.llm.createMessage(req);
    } catch (err) {
      if (req.signal?.aborted) return 'stopped';
      if (isAppError(err)) throw err;
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : undefined;
      this.log.error('agent.provider_error', { status: status ?? 'network', err: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      throw new AppError('AGENT_UNAVAILABLE', 'The BluckFlies assistant is not available right now. You can still find flights step by step, or call us.');
    }
  }

  private async runTurn(sessionId: string, userText: string, opts: HandleOptions): Promise<AgentTurnResult> {
    const { onEvent, signal } = opts;
    const channel = opts.channel ?? 'text';
    const stored = (await this.conversations.load(sessionId)) as AgentMessage[];
    const history: AgentMessage[] = trimHistory([...stored, { role: 'user', content: userText }]);
    const system = buildSystemPrompt(this.clock.now(), this.opts.sandbox, channel);
    const toolsUsed: string[] = [];
    const searches: SearchResult[] = [];

    for (let i = 0; i < this.opts.maxToolIterations; i++) {
      if (signal?.aborted) return this.stopTurn(sessionId, history, toolsUsed, searches);
      const budget = this.opts.budget ? await this.opts.budget.check(sessionId) : ({ ok: true } as const);
      if (!budget.ok) {
        // Before any work: nothing to save, the client shows its fallback options.
        if (i === 0) throw new AppError('AGENT_UNAVAILABLE', BUDGET_MESSAGES[budget.scope]);
        // Mid-turn (tools already ran): close the turn and keep the history consistent.
        return this.closeTurn(sessionId, history, BUDGET_MESSAGES[budget.scope], toolsUsed, searches);
      }
      const res = await this.callModel({
        system,
        messages: history,
        tools: this.tools,
        maxTokens: MAX_TOKENS,
        ...(onEvent ? { onText: (delta: string) => onEvent({ type: 'text', delta }) } : {}),
        ...(signal ? { signal } : {}),
      });
      if (res === 'stopped') return this.stopTurn(sessionId, history, toolsUsed, searches);
      if (res.usage) await this.opts.budget?.record(sessionId, res.usage);
      history.push({ role: 'assistant', content: res.content });

      const calls = res.content.filter((b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (res.stopReason !== 'tool_use' || calls.length === 0) {
        await this.conversations.save(sessionId, sanitizeDangling(history));
        return this.result(this.textOf(res.content, res.stopReason), toolsUsed, searches);
      }

      // Sequential on purpose: later calls (e.g. payment) may depend on earlier ones.
      const results: AgentBlock[] = [];
      for (const call of calls) {
        onEvent?.(stepOf(call.name, call.input));
        const outcome = await this.executor.execute(sessionId, call.name, call.input);
        toolsUsed.push(call.name);
        if (call.name === 'search_flights' && !outcome.isError) searches.push(outcome.result as SearchResult);
        this.log.info('agent.tool', { sessionId, tool: call.name, isError: outcome.isError });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      }
      history.push({ role: 'user', content: results });
    }

    // Too many tool rounds: close the turn safely rather than looping.
    this.log.warn('agent.iteration_limit', { sessionId });
    return this.closeTurn(sessionId, history, 'Sorry, I could not finish that request. Could you rephrase it, or shall I connect you with a BluckFlies agent?', toolsUsed, searches);
  }

  /** Ends a stopped turn: tools that ran keep their results; the history stays valid for the next message. */
  private stopTurn(sessionId: string, history: AgentMessage[], toolsUsed: string[], searches: SearchResult[]): Promise<AgentTurnResult> {
    this.log.info('agent.stopped', { sessionId, toolsUsed: toolsUsed.length });
    return this.closeTurn(sessionId, history, STOPPED_TEXT, toolsUsed, searches);
  }

  private async closeTurn(sessionId: string, history: AgentMessage[], text: string, toolsUsed: string[], searches: SearchResult[]): Promise<AgentTurnResult> {
    history.push({ role: 'assistant', content: [{ type: 'text', text }] });
    await this.conversations.save(sessionId, sanitizeDangling(history));
    return this.result(text, toolsUsed, searches);
  }

  private result(reply: string, toolsUsed: string[], searches: SearchResult[]): AgentTurnResult {
    const last = searches.at(-1);
    return { reply, toolsUsed, searches, ...(last ? { search: last } : {}) };
  }

  private textOf(content: AgentBlock[], stop: string): string {
    const text = content
      .filter((b): b is Extract<AgentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
    return stop === 'refusal' ? 'I can’t help with that request.' : 'Sorry, I didn’t get that. Could you say it another way?';
  }
}

/**
 * Removes a trailing assistant message whose tool_use blocks have no results,
 * which the Messages API would reject on the next turn.
 */
function sanitizeDangling(history: AgentMessage[]): AgentMessage[] {
  return history.filter((m, idx) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return true;
    const hasToolUse = m.content.some((b) => b.type === 'tool_use');
    const next = history[idx + 1];
    const answered = next?.role === 'user' && Array.isArray(next.content) && next.content.some((b) => b.type === 'tool_result');
    return !hasToolUse || answered;
  });
}
