import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ToolDefinition } from './tools.js';

/**
 * Minimal conversation model the agent depends on. It is a subset of the
 * Anthropic Messages format, which keeps the agent loop testable with a fake
 * client and isolates SDK upgrades to the adapter below.
 */
export type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | AgentBlock[];
}

/** Tokens billed for one model call (Anthropic usage fields). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache writes (billed above the input price). */
  cacheWriteTokens: number;
  /** Prompt-cache hits (billed well below the input price). */
  cacheReadTokens: number;
}

export interface LlmResponse {
  content: AgentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  /** Absent only for fakes that do not report usage. */
  usage?: LlmUsage;
}

export interface LlmRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  /** Receives the reply text as it is written (streaming). Clients that cannot stream may ignore it. */
  onText?: (delta: string) => void;
  /** Cancels the call (the traveller pressed Stop). The client then rejects. */
  signal?: AbortSignal;
}

export interface LlmClient {
  createMessage(req: LlmRequest): Promise<LlmResponse>;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  }

  async createMessage(req: LlmRequest): Promise<LlmResponse> {
    const messages: MessageParam[] = req.messages.map((m) =>
      m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content },
    );
    const params = {
      model: this.model,
      max_tokens: req.maxTokens,
      // The system prompt and tool list are stable across turns; cache them.
      system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
      tools: req.tools.map((t, i) => (i === req.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t)),
      messages,
    };
    const options = req.signal ? { signal: req.signal } : {};
    let res: Message;
    if (req.onText) {
      const onText = req.onText;
      const stream = this.client.messages.stream(params, options);
      stream.on('text', (delta) => onText(delta));
      res = await stream.finalMessage();
    } else {
      res = await this.client.messages.create(params, options);
    }

    const content: AgentBlock[] = [];
    for (const block of res.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
    const stop = res.stop_reason;
    return {
      content,
      stopReason: stop === 'end_turn' || stop === 'tool_use' || stop === 'max_tokens' || stop === 'refusal' ? stop : 'other',
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
