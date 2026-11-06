// Session handling and JSON calls to the BluckFlies API.

import { t } from './i18n.js';

/**
 * fetch() that turns a dropped connection into an error the chat can recognise
 * (code NETWORK) instead of the browser's raw "Failed to fetch".
 */
async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    const err = new Error(t('netDown'));
    err.code = 'NETWORK';
    throw err;
  }
}

/*
 * The session token is kept in localStorage so the conversation survives a
 * closed tab or a phone that reloads the page (common on low-memory Android
 * phones). Trade-off: on a shared phone or a cyber café, the next person could
 * open the same chat. So the token is forgotten after IDLE_MS without use, and
 * the chat has a "New chat" button that forgets it at once.
 */
const TOKEN_KEY = 'bluckflies.session';
const IDLE_MS = 24 * 60 * 60 * 1000;
let token = null;

function readToken() {
  try {
    // Tokens saved by earlier versions (one tab only) move to the new store.
    const legacy = sessionStorage.getItem(TOKEN_KEY);
    if (legacy) { sessionStorage.removeItem(TOKEN_KEY); writeToken(legacy); return legacy; }
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null');
    if (!saved || typeof saved.token !== 'string' || typeof saved.usedAt !== 'number') return null;
    if (Date.now() - saved.usedAt > IDLE_MS) { localStorage.removeItem(TOKEN_KEY); return null; }
    return saved.token;
  } catch {
    return null;
  }
}
function writeToken(value) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: value, usedAt: Date.now() })); } catch { /* storage unavailable: keep in memory */ }
}
/** Each successful call counts as use, so an active chat never expires mid-trip. */
function touchToken() {
  if (token) writeToken(token);
}
function clearToken() {
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

/** Forgets this device's session (logout, "New chat"); the next call starts a new one. */
export function resetSession() {
  clearToken();
}

/** True when this device already has a session (avoids creating one just to look). */
export function hasSession() {
  return Boolean(token ?? readToken());
}

async function ensureSession() {
  token = token ?? readToken();
  if (token) return token;
  const res = await request('/api/sessions', { method: 'POST' });
  if (!res.ok) {
    const err = new Error(t('errGeneric'));
    err.code = res.status >= 500 ? 'SERVER' : 'SESSION';
    throw err;
  }
  token = (await res.json()).token;
  writeToken(token);
  return token;
}

function authHeaders(json) {
  return { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) };
}

/** The error a failed JSON response describes (our API always explains its errors). */
async function errorFrom(res) {
  const data = await res.json().catch(() => ({}));
  // Anything else (a proxy's 502 page) gets a plain message.
  const err = new Error(data?.error?.message ?? t('errGeneric'));
  err.code = data?.error?.code ?? (res.status >= 500 ? 'SERVER' : undefined);
  return err;
}

export async function api(path, { method = 'GET', body } = {}, retried = false) {
  await ensureSession();
  const res = await request(`/api${path}`, {
    method,
    headers: authHeaders(Boolean(body)),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 && !retried) {
    clearToken();
    return api(path, { method, body }, true);
  }
  if (!res.ok) throw await errorFrom(res);
  touchToken();
  if (res.status === 204) return null;
  return res.json().catch(() => ({}));
}

/**
 * One chat turn with progress (server-sent events over POST).
 * onEvent receives { type: 'step', tool, route? } and { type: 'text', delta }.
 * Resolves with the same body as POST /api/chat. Rejects with code:
 *   STOPPED      the signal was aborted (Stop button)
 *   NETWORK      the request could not be sent
 *   INTERRUPTED  the connection dropped mid-answer (the server may have finished it)
 *   or the server's own error code.
 */
export async function streamChat(body, { onEvent, signal }, retried = false) {
  await ensureSession();
  let res;
  try {
    res = await fetch('/api/chat/stream', { method: 'POST', headers: authHeaders(true), body: JSON.stringify(body), signal });
  } catch (e) {
    throw signal?.aborted ? stopped() : networkError();
  }
  if (res.status === 401 && !retried) {
    clearToken();
    return streamChat(body, { onEvent, signal }, true);
  }
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) throw await errorFrom(res);
  touchToken();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw signal?.aborted ? stopped() : interrupted();
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const ev = parseEvent(block);
      if (!ev) continue;
      if (ev.event === 'done') { reader.cancel().catch(() => {}); return ev.data; }
      if (ev.event === 'error') {
        const err = new Error(ev.data.message ?? t('errGeneric'));
        err.code = ev.data.code ?? 'SERVER';
        throw err;
      }
      if (ev.event === 'step') onEvent?.({ type: 'step', tool: ev.data.tool, route: ev.data.route });
      if (ev.event === 'text' && typeof ev.data.delta === 'string') onEvent?.({ type: 'text', delta: ev.data.delta });
    }
  }
  throw signal?.aborted ? stopped() : interrupted();
}

function parseEvent(block) {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return null; // heartbeat comment
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

function coded(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}
const stopped = () => coded(t('stopped'), 'STOPPED');
const networkError = () => coded(t('netDown'), 'NETWORK');
const interrupted = () => coded(t('netCut'), 'INTERRUPTED');
