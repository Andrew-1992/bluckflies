import type { AgentBlock } from './llm.js';

export interface TranscriptLine {
  role: 'traveller' | 'agent';
  text: string;
}

/**
 * The human-readable part of a stored conversation: what the traveller typed
 * and what the agent said. Tool calls and tool results are left out (they hold
 * internal IDs and raw supplier data).
 */
export function transcriptOf(messages: readonly unknown[], limit = 60): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const m of messages) {
    if (typeof m !== 'object' || m === null || !('role' in m) || !('content' in m)) continue;
    const { role, content } = m as { role: unknown; content: unknown };
    if (role === 'user' && typeof content === 'string') lines.push({ role: 'traveller', text: content });
    if (role === 'assistant' && Array.isArray(content)) {
      const text = (content as AgentBlock[])
        .filter((b): b is Extract<AgentBlock, { type: 'text' }> => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) lines.push({ role: 'agent', text });
    }
  }
  return lines.slice(-limit);
}
