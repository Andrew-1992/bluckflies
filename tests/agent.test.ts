import { describe, expect, it } from 'vitest';
import { trimHistory } from '../src/agent/Agent.js';
import type { AgentMessage } from '../src/agent/llm.js';
import { toolDefinitions } from '../src/agent/tools.js';
import { FRIDAY, ScriptedLlm, testContainer, text, toolCall } from './helpers.js';

describe('tool definitions', () => {
  it('exposes JSON schemas and no tool that can approve or execute a confirmation', () => {
    const defs = toolDefinitions();
    expect(defs.every((d) => d.input_schema.type === 'object' && !('$schema' in d.input_schema))).toBe(true);
    const names = defs.map((d) => d.name);
    expect(names).toContain('propose_reservation');
    expect(names.some((n) => /confirm|approve|issue|charge/.test(n))).toBe(false);
  });
});

describe('BluckFliesAgent', () => {
  it('runs the tool loop: search, then answer with tool results in context', async () => {
    const llm = new ScriptedLlm([
      toolCall('search_flights', { origin: 'Juba', destination: 'Nairobi', departure_date: FRIDAY }),
      (req) => {
        const last = req.messages.at(-1);
        const result = Array.isArray(last?.content) ? last.content[0] : undefined;
        expect(result?.type).toBe('tool_result');
        expect(result && 'content' in result ? result.content : '').toContain('XS410');
        return text('I found flights on XS410.');
      },
    ]);
    const { c } = testContainer({ llm });
    const out = await c.agent?.handle('ses_a', 'Juba to Nairobi on 6 Nov');
    expect(out?.reply).toBe('I found flights on XS410.');
    expect(out?.toolsUsed).toEqual(['search_flights']);
    // The structured offers come back with the turn so the client can render result cards.
    expect(out?.search?.offers.length).toBeGreaterThan(0);
    expect(out?.search?.offers.some((o) => o.segments.some((s) => s.flight.replace(' ', '') === 'XS410'))).toBe(true);
    expect(llm.requests[0]?.system).toContain('2026-10-30');
  });

  it('adds the voice rules only to spoken turns', async () => {
    const llm = new ScriptedLlm([text('Typed reply.'), text('Spoken reply.')]);
    const { c } = testContainer({ llm });
    await c.agent?.handle('ses_a', 'Juba to Nairobi');
    await c.agent?.handle('ses_a', 'جوبا إلى نيروبي', { channel: 'voice' });
    expect(llm.requests[0]?.system).not.toContain('## Voice conversation');
    expect(llm.requests[1]?.system).toContain('## Voice conversation');
    expect(llm.requests[1]?.system).toContain('Reply in the language they spoke');
  });

  it('returns validation errors to the model instead of throwing', async () => {
    const llm = new ScriptedLlm([
      toolCall('search_flights', { origin: 'JUB', destination: 'NBO', departure_date: 'next friday' }),
      (req) => {
        const last = req.messages.at(-1);
        const block = Array.isArray(last?.content) ? last.content[0] : undefined;
        expect(block && 'is_error' in block ? block.is_error : false).toBe(true);
        return text('Which date exactly?');
      },
    ]);
    const { c } = testContainer({ llm });
    expect((await c.agent?.handle('ses_a', 'flights'))?.reply).toBe('Which date exactly?');
  });

  it('rejects unknown tools and stops at the iteration limit', async () => {
    const llm = new ScriptedLlm(Array.from({ length: 3 }, (_, i) => toolCall('issue_ticket', {}, `tu_${i}`)));
    const { c } = testContainer({ llm }, { AGENT_MAX_TOOL_ITERATIONS: '3' });
    const out = await c.agent?.handle('ses_a', 'just ticket it');
    expect(out?.reply).toMatch(/could not finish/);
  });

  it('cannot reach another session\'s bookings: session comes from auth, not the model', async () => {
    const llm = new ScriptedLlm([toolCall('list_my_bookings', {}), text('none')]);
    const { c } = testContainer({ llm });
    await c.agent?.handle('ses_b', 'show my trips');
    const toolResult = llm.requests[1]?.messages.at(-1);
    expect(JSON.stringify(toolResult)).toContain('\\"bookings\\":[]');
  });
});

describe('trimHistory', () => {
  it('never starts on a tool_result message', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
    ];
    const trimmed = trimHistory(msgs, 4);
    expect(trimmed[0]).toEqual({ role: 'user', content: 'next' });
  });
});
