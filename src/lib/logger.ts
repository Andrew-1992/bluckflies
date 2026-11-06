/**
 * Minimal structured JSON logger with key-based redaction. Swap for pino in
 * production; the redaction list must travel with it.
 */
const REDACT_KEYS = new Set([
  'authorization',
  'token',
  'passportnumber',
  'phone',
  'payerphone',
  'email',
  'dateofbirth',
  'apikey',
  'secret',
  'signature',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export function createLogger(minLevel: Level = 'info', sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const log = (level: Level) => (msg: string, ctx?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    sink(JSON.stringify({ level, time: new Date().toISOString(), msg, ...(ctx ? (redact(ctx) as object) : {}) }));
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
