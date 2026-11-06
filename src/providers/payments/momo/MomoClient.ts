import { z, type ZodType } from 'zod';
import type { Clock } from '../../../lib/clock.js';
import type { Logger } from '../../../lib/logger.js';

/**
 * Client for the MTN MoMo Open API (https://momodeveloper.mtn.com).
 * Each product (collection, disbursement) has its own subscription key and
 * API user/key; access tokens come from POST /{product}/token/ with HTTP Basic
 * auth and are cached until shortly before they expire.
 */

export type MomoProduct = 'collection' | 'disbursement';

export interface MomoCredentials {
  subscriptionKey: string;
  apiUser: string;
  apiKey: string;
}

export interface MomoClientOptions {
  baseUrl: string;
  targetEnvironment: string;
  collection: MomoCredentials;
  disbursement?: MomoCredentials;
  timeoutMs: number;
  clock: Clock;
  log: Logger;
  fetchImpl?: typeof fetch;
}

export class MomoApiError extends Error {
  constructor(
    readonly status: number,
    /** MTN error code, e.g. RESOURCE_ALREADY_EXIST, PAYER_NOT_FOUND; "network_error" if no response. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MomoApiError';
  }
}

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().int().positive() });

export class MomoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly tokens = new Map<MomoProduct, { token: string; expiresAt: number }>();

  constructor(private readonly opts: MomoClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  hasProduct(product: MomoProduct): boolean {
    return product === 'collection' || Boolean(this.opts.disbursement);
  }

  private creds(product: MomoProduct): MomoCredentials {
    const c = product === 'collection' ? this.opts.collection : this.opts.disbursement;
    if (!c) throw new Error(`MTN MoMo ${product} is not configured`);
    return c;
  }

  private async token(product: MomoProduct): Promise<string> {
    const cached = this.tokens.get(product);
    if (cached && cached.expiresAt > this.opts.clock.now().getTime() + 60_000) return cached.token;
    const c = this.creds(product);
    const res = await this.raw('POST', `/${product}/token/`, {
      Authorization: `Basic ${Buffer.from(`${c.apiUser}:${c.apiKey}`).toString('base64')}`,
      'Ocp-Apim-Subscription-Key': c.subscriptionKey,
    });
    if (res.status !== 200) throw this.errorFrom(res.status, res.json);
    const parsed = TokenResponse.safeParse(res.json);
    if (!parsed.success) throw new MomoApiError(res.status, 'invalid_token_response', 'Unexpected token response from MTN MoMo');
    this.tokens.set(product, { token: parsed.data.access_token, expiresAt: this.opts.clock.now().getTime() + parsed.data.expires_in * 1000 });
    return parsed.data.access_token;
  }

  /**
   * Calls a product endpoint. Returns the status and parsed body; non-2xx
   * statuses other than those in `accept` throw MomoApiError.
   */
  async call<T>(
    product: MomoProduct,
    method: 'GET' | 'POST',
    path: string,
    opts: { headers?: Record<string, string>; body?: unknown; schema?: ZodType<T>; accept?: readonly number[] } = {},
  ): Promise<{ status: number; data: T | undefined }> {
    for (let attempt = 1; ; attempt++) {
      const token = await this.token(product);
      const res = await this.raw(
        method,
        path,
        {
          Authorization: `Bearer ${token}`,
          'X-Target-Environment': this.opts.targetEnvironment,
          'Ocp-Apim-Subscription-Key': this.creds(product).subscriptionKey,
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...opts.headers,
        },
        opts.body,
      );
      if (res.status === 401 && attempt === 1) {
        this.tokens.delete(product); // token revoked or expired early: refresh once
        continue;
      }
      const ok = (res.status >= 200 && res.status < 300) || (opts.accept ?? []).includes(res.status);
      if (!ok) throw this.errorFrom(res.status, res.json);
      if (!opts.schema || res.json === undefined) return { status: res.status, data: undefined };
      const parsed = opts.schema.safeParse(res.json);
      if (!parsed.success) {
        this.opts.log.error('momo.unexpected_response', { path, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
        throw new MomoApiError(res.status, 'unexpected_response', 'Unexpected response from MTN MoMo');
      }
      return { status: res.status, data: parsed.data };
    }
  }

  private async raw(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new MomoApiError(0, 'network_error', err instanceof Error ? err.message : String(err));
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  private errorFrom(status: number, json: unknown): MomoApiError {
    const body = (json ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof body.code === 'string' ? body.code : `http_${status}`;
    const message = typeof body.message === 'string' ? body.message : `MTN MoMo returned HTTP ${status}`;
    return new MomoApiError(status, code, message);
  }
}
