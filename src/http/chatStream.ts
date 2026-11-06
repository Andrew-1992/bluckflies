import type { Request, Response } from 'express';
import type { AgentEvent } from '../agent/Agent.js';
import type { Logger } from '../lib/logger.js';
import { errorReply } from './middleware.js';

/** A comment line every so often keeps mobile networks and proxies from closing a quiet stream. */
const HEARTBEAT_MS = 15_000;

/**
 * Runs one chat turn as server-sent events over the POST response:
 *
 *   event: step   {"tool":"search_flights","route":{"from":"JUB","to":"NBO"}}
 *   event: text   {"delta":"I found"}
 *   event: done   { …same body as POST /api/chat… }
 *   event: error  {"code":"AGENT_UNAVAILABLE","message":"…"}
 *
 * Exactly one `done` or `error` ends the stream. When the client goes away
 * (Stop button, closed tab), the turn is told to stop: it ends at the next safe
 * point and the conversation stays consistent.
 */
export async function streamChatTurn(
  req: Request,
  res: Response,
  log: Logger,
  isUnavailable: (err: unknown) => boolean,
  run: (onEvent: (e: AgentEvent) => void, signal: AbortSignal) => Promise<Record<string, unknown>>,
): Promise<void> {
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) stop.abort();
  });

  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no'); // nginx-style proxies: do not buffer
  res.flushHeaders();

  const send = (event: string, data: unknown): void => {
    if (res.writableEnded || stop.signal.aborted) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  try {
    const body = await run((e) => (e.type === 'step' ? send('step', { tool: e.tool, ...(e.route ? { route: e.route } : {}) }) : send('text', { delta: e.delta })), stop.signal);
    send('done', body);
  } catch (err) {
    send('error', errorReply(err, req, log, isUnavailable).body.error);
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}
