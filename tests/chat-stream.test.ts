// Streaming chat (POST /api/chat/stream) and the Stop button: progress events,
// errors after the headers are sent, and a stopped turn that leaves the
// conversation valid.
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { STOPPED_TEXT } from '../src/agent/Agent.js';
import type { LlmClient, LlmResponse } from '../src/agent/llm.js';
import { createApp } from '../src/http/app.js';
import { FRIDAY, ScriptedLlm, testContainer, text, toolCall } from './helpers.js';

type App = ReturnType<typeof createApp>;

async function session(app: App): Promise<string> {
  const res = await request(app).post('/api/sessions').expect(201);
  return res.body.token as string;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(raw: string): SseEvent[] {
  return raw
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => !l.startsWith(':')))
    .filter((lines) => lines.length >= 2)
    .map((lines) => ({
      event: (lines.find((l) => l.startsWith('event: ')) ?? '').slice(7),
      data: JSON.parse((lines.find((l) => l.startsWith('data: ')) ?? 'data: {}').slice(6)) as Record<string, unknown>,
    }));
}

async function stream(app: App, token: string, body: unknown): Promise<{ status: number; type: string; events: SseEvent[] }> {
  const res = await request(app)
    .post('/api/chat/stream')
    .set('authorization', `Bearer ${token}`)
    .send(body as object)
    .buffer(true)
    .parse((r, cb) => {
      let d = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (d += c));
      r.on('end', () => cb(null, d));
    });
  return { status: res.status, type: String(res.headers['content-type']), events: parseSse(String(res.body)) };
}

describe('streaming chat', () => {
  it('reports each step, streams the reply text, and ends with the same body as /api/chat', async () => {
    const llm = new ScriptedLlm([
      toolCall('search_flights', { origin: 'JUB', destination: 'NBO', departure_date: FRIDAY }),
      (req) => {
        req.onText?.('I found ');
        req.onText?.('flights.');
        return text('I found flights.');
      },
    ]);
    const app = createApp(testContainer({ llm }).c);
    const { status, type, events } = await stream(app, await session(app), { message: 'Juba to Nairobi Friday' });

    expect(status).toBe(200);
    expect(type).toContain('text/event-stream');
    expect(events.map((e) => e.event)).toEqual(['step', 'text', 'text', 'done']);
    expect(events[0]?.data).toEqual({ tool: 'search_flights', route: { from: 'JUB', to: 'NBO' } });
    expect(events.filter((e) => e.event === 'text').map((e) => e.data.delta).join('')).toBe('I found flights.');
    const done = events.at(-1)?.data as { reply: string; stopped: boolean; search: { offers: unknown[] } };
    expect(done.reply).toBe('I found flights.');
    expect(done.stopped).toBe(false);
    expect(done.search.offers.length).toBeGreaterThan(0);
  });

  it('sends a route only for airport codes, never free text the model wrote', async () => {
    const llm = new ScriptedLlm([toolCall('search_flights', { origin: 'Juba <b>', destination: 'Nairobi', departure_date: FRIDAY }), text('Done.')]);
    const app = createApp(testContainer({ llm }).c);
    const { events } = await stream(app, await session(app), { message: 'Juba to Nairobi' });
    expect(events[0]).toEqual({ event: 'step', data: { tool: 'search_flights' } });
  });

  it('answers ordinary JSON errors before any work starts', async () => {
    const noAgent = createApp(testContainer().c);
    const t1 = await session(noAgent);
    await request(noAgent).post('/api/chat/stream').set('authorization', `Bearer ${t1}`).send({ message: 'hi' }).expect(503);

    const app = createApp(testContainer({ llm: new ScriptedLlm([]) }).c);
    const t2 = await session(app);
    await request(app).post('/api/chat/stream').set('authorization', `Bearer ${t2}`).send({ message: '' }).expect(400);
    await request(app).post('/api/chat/stream').send({ message: 'hi' }).expect(401);
  });

  it('reports a failure during the turn as an error event, without internal details', async () => {
    const failing: LlmClient = {
      async createMessage(): Promise<LlmResponse> {
        throw Object.assign(new Error('upstream secret: key sk-ant-xyz rejected'), { status: 401 });
      },
    };
    const app = createApp(testContainer({ llm: failing }).c);
    const { status, events } = await stream(app, await session(app), { message: 'hi' });
    expect(status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('error');
    expect(events[0]?.data.code).toBe('AGENT_UNAVAILABLE');
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});

describe('Stop', () => {
  it('stops before the next model call; tools that ran keep their results and the next turn works', async () => {
    const stop = new AbortController();
    const llm = new ScriptedLlm([
      toolCall('search_flights', { origin: 'JUB', destination: 'NBO', departure_date: FRIDAY }),
      (req) => {
        // The traveller pressed Stop while this call was running: the SDK rejects.
        stop.abort();
        expect(req.signal?.aborted).toBe(true);
        throw new Error('Request was aborted.');
      },
      (req) => {
        // Next turn: the stopped turn is closed, with its tool result kept.
        const roles = req.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
        expect(req.messages[3]?.content).toEqual([{ type: 'text', text: STOPPED_TEXT }]);
        return text('Here you go.');
      },
    ]);
    const { c } = testContainer({ llm });
    // Fixture sessions: they exist in the PostgreSQL test database too.
    const first = await c.agent?.handle('ses_a', 'Juba to Nairobi', { signal: stop.signal });
    expect(first?.reply).toBe(STOPPED_TEXT);
    expect(first?.searches).toHaveLength(1);
    const next = await c.agent?.handle('ses_a', 'Show me again');
    expect(next?.reply).toBe('Here you go.');
  });

  it('does not call the model at all when stopped before it starts', async () => {
    const llm = new ScriptedLlm([]);
    const { c } = testContainer({ llm });
    const out = await c.agent?.handle('ses_b', 'hi', { signal: AbortSignal.abort() });
    expect(out?.reply).toBe(STOPPED_TEXT);
    expect(llm.requests).toHaveLength(0);
  });

  it('a client that disconnects mid-reply stops the turn on the server and frees the session', async () => {
    let started!: () => void;
    const waiting = new Promise<void>((r) => (started = r));
    const hanging: LlmClient = {
      createMessage(req): Promise<LlmResponse> {
        started();
        return new Promise((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    };
    const app = createApp(testContainer({ llm: hanging }).c);
    const token = await session(app);
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat/stream`;
      const client = new AbortController();
      const pending = fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
        signal: client.signal,
      }).then((r) => r.text()).catch(() => 'aborted');
      await waiting;
      client.abort();
      expect(await pending).toBe('aborted');

      // The turn ends on the server: the history holds the stopped reply and a new message is accepted.
      let messages: Array<{ role: string; text: string }> = [];
      for (let i = 0; i < 50 && messages.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
        messages = (await request(app).get('/api/chat/history').set('authorization', `Bearer ${token}`)).body.messages;
      }
      expect(messages).toEqual([{ role: 'traveller', text: 'hi' }, { role: 'agent', text: STOPPED_TEXT }]);
    } finally {
      server.close();
    }
  });
});
