import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ZodError, type ZodType } from 'zod';
import { AppError, isAppError } from '../domain/errors.js';
import { hashToken } from '../lib/ids.js';
import type { Limit, RateLimiter } from '../lib/rateLimiter.js';
import type { Logger } from '../lib/logger.js';
import type { SessionRepository } from '../repositories/types.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    sessionId?: string;
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

/** Headers on every response. The static build for Vercel uses the same list (src/http/staticSite.ts). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // Voice input needs the microphone on our own pages only; nothing else is granted.
  'permissions-policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    next();
  };
}

export const ORIGIN_SECRET_HEADER = 'x-origin-secret';

/**
 * Refuses requests that did not come through the front proxy, which adds the
 * shared secret to each one (Vercel `transforms`, see docs/TUNNEL-TEST.md).
 * Health checks stay open for uptime monitors. Compared in constant time
 * (hashes of equal length), so the secret cannot be guessed byte by byte.
 */
export function requireOriginSecret(secret: string): RequestHandler {
  const expected = createHash('sha256').update(secret).digest();
  return (req, res, next) => {
    if (req.path === '/healthz' || req.path === '/readyz') { next(); return; }
    const given = createHash('sha256').update(req.header(ORIGIN_SECRET_HEADER) ?? '').digest();
    if (!timingSafeEqual(given, expected)) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    next();
  };
}

/** Authenticates the anonymous traveller session from a bearer token. */
export function requireSession(sessions: SessionRepository): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new AppError('UNAUTHENTICATED', 'Missing session token.');
    const session = await sessions.findByTokenHash(hashToken(token));
    if (!session) throw new AppError('UNAUTHENTICATED', 'Session not found or expired.');
    req.sessionId = session.id;
    await sessions.touch(session.id, new Date().toISOString());
    next();
  };
}

/**
 * Rate-limit middleware: counts each request against `key` in the shared
 * store (all servers together) and answers 429 with Retry-After past `max`.
 */
export function rateLimit(limiter: RateLimiter, opts: Limit & { key: (req: Request) => string }): RequestHandler {
  return async (req, res, next) => {
    const d = await limiter.consume(opts.key(req), opts);
    if (!d.allowed) {
      res.setHeader('retry-after', d.retryAfterSec);
      throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down.');
    }
    next();
  };
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new AppError('VALIDATION_FAILED', 'Invalid request.', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export interface ErrorReply {
  status: number;
  body: { error: { code: string; message: string; details?: unknown; requestId?: string } };
  retryAfter?: string;
}

/**
 * Maps any error to the public reply: AppErrors keep their code and message;
 * anything else becomes a generic message (details go to the log only). Shared
 * by the error middleware and the streaming chat, which reports errors after
 * its headers are sent.
 */
export function errorReply(err: unknown, req: Request, log: Logger, isUnavailable: (err: unknown) => boolean = () => false): ErrorReply {
  if (isUnavailable(err)) {
    log.warn('request.store_unavailable', { requestId: req.requestId });
    return { status: 503, retryAfter: '5', body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'BluckFlies is temporarily unavailable. Please try again in a moment.' } } };
  }
  if (isAppError(err)) {
    if (err.httpStatus >= 500) log.warn('request.upstream_error', { requestId: req.requestId, code: err.code });
    return { status: err.httpStatus, body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } } };
  }
  if (err instanceof ZodError) return { status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'Invalid request.' } } };
  if (err instanceof SyntaxError && 'body' in err) return { status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON body.' } } };
  log.error('request.unhandled', { requestId: req.requestId, err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', ...(req.requestId ? { requestId: req.requestId } : {}) } } };
}

export function errorHandler(log: Logger, isUnavailable: (err: unknown) => boolean = () => false) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const reply = errorReply(err, req, log, isUnavailable);
    if (reply.retryAfter) res.setHeader('retry-after', reply.retryAfter);
    res.status(reply.status).json(reply.body);
  };
}
