import type { ZodType } from 'zod';
import type { Logger } from '../../../lib/logger.js';

/**
 * Minimal HTTP client for the Duffel API (https://duffel.com/docs/api).
 *
 * Retry policy follows Duffel's error guide: only 429, 503 and 504 are
 * retryable, and only for requests the caller marks `idempotent`. Order
 * creation and payments are never retried here, because Duffel has no
 * idempotency keys and a retried order call can create a duplicate booking.
 */

export interface DuffelErrorDetail {
  type?: string;
  code?: string;
  title?: string;
  message?: string;
}

export class DuffelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly type: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'DuffelApiError';
  }

  /** The request may or may not have taken effect (timeouts, 5xx, 202). */
  get outcomeUnknown(): boolean {
    return this.status === 0 || this.status === 202 || this.status >= 500;
  }
}

export interface DuffelClientOptions {
  accessToken: string;
  baseUrl: string;
  /** Per-request timeout; keep above the `supplier_timeout` sent on searches. */
  timeoutMs: number;
  log: Logger;
  fetchImpl?: typeof fetch;
}

const RETRYABLE = new Set([429, 503, 504]);
const MAX_ATTEMPTS = 3;

export class DuffelClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DuffelClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: ZodType<T>,
    options: { body?: unknown; idempotent: boolean; timeoutMs?: number },
  ): Promise<T> {
    const attempts = options.idempotent ? MAX_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(method, path, schema, options.body, options.timeoutMs ?? this.opts.timeoutMs);
      } catch (err) {
        const retryable = err instanceof DuffelApiError && (RETRYABLE.has(err.status) || (err.status === 0 && method === 'GET'));
        if (!retryable || attempt >= attempts) throw err;
        const delay = Math.min(250 * 2 ** attempt, 2_000);
        this.opts.log.warn('duffel.retry', { path, status: err.status, attempt });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async once<T>(method: string, path: string, schema: ZodType<T>, body: unknown, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.accessToken}`,
          'Duffel-Version': 'v2',
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network failure or timeout: the request may have reached Duffel.
      throw new DuffelApiError(0, 'network_error', 'network_error', err instanceof Error ? err.message : String(err));
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new DuffelApiError(res.status, 'invalid_response', 'api_error', `Non-JSON response (HTTP ${res.status})`);
    }

    if (res.status === 202) {
      // Accepted but not finished: Duffel's guide says not to retry (duplicate risk).
      throw new DuffelApiError(202, 'accepted_pending', 'api_error', 'Request accepted but not completed');
    }
    if (!res.ok) {
      const errors = (json as { errors?: DuffelErrorDetail[]; meta?: { request_id?: string } } | undefined)?.errors ?? [];
      const first = errors[0] ?? {};
      throw new DuffelApiError(
        res.status,
        first.code ?? `http_${res.status}`,
        first.type ?? 'api_error',
        first.message ?? first.title ?? `Duffel returned HTTP ${res.status}`,
        (json as { meta?: { request_id?: string } } | undefined)?.meta?.request_id,
      );
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      this.opts.log.error('duffel.unexpected_response', { path, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
      throw new DuffelApiError(res.status, 'unexpected_response', 'api_error', 'Unexpected response from flight supplier');
    }
    return parsed.data;
  }
}
