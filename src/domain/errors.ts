/**
 * Typed application errors. `code` is stable and safe to expose to clients and
 * to the agent; `message` is written for the traveller and contains no internals.
 */
export type AppErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'CONFLICT'
  | 'OFFER_EXPIRED'
  | 'HOLD_EXPIRED'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'AGENT_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE';

const HTTP_STATUS: Record<AppErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  CONFLICT: 409,
  OFFER_EXPIRED: 410,
  HOLD_EXPIRED: 410,
  INVALID_STATE: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  AGENT_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
