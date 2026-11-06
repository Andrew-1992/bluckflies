import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-process fake of the MTN MoMo Open API (collection + disbursement), shaped
 * after https://momodeveloper.mtn.com. Enforces per-product credentials and
 * tokens, X-Target-Environment, UUID reference IDs and MTN's idempotency rule
 * (a reused X-Reference-Id returns 409 RESOURCE_ALREADY_EXIST).
 */

export const MOMO = {
  environment: 'mtnsouthsudan',
  collection: { subscriptionKey: 'collection-sub-key-0001', apiUser: '0b1e6f3c-8f2a-4d6b-9c1e-2a3b4c5d6e7f', apiKey: 'collection-api-key-0001' },
  disbursement: { subscriptionKey: 'disburse-sub-key-00001', apiUser: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', apiKey: 'disburse-api-key-00001' },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Txn {
  ref: string;
  body: Record<string, unknown>;
  status: 'PENDING' | 'SUCCESSFUL' | 'FAILED';
  reason?: string;
}

export class FakeMomo {
  private server: Server | undefined;
  url = '';
  readonly requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }> = [];
  readonly payments = new Map<string, Txn>();
  readonly transfers = new Map<string, Txn>();
  private readonly tokens = new Map<string, 'collection' | 'disbursement'>();
  private seq = 0;
  /** Drop the connection on the next N request-to-pay calls (MTN still records new ones): lost responses. */
  dropRequestToPayResponses = 0;
  /** Number of token requests served, per product. */
  tokenIssues = { collection: 0, disbursement: 0 };
  /** Revoke all tokens (simulates expiry before the stated time). */
  revokeTokens(): void {
    this.tokens.clear();
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  calls(method: string, prefix: string) {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
  }

  approve(ref: string): void {
    const t = this.payments.get(ref);
    if (t) t.status = 'SUCCESSFUL';
  }
  decline(ref: string, reason = 'APPROVAL_REJECTED'): void {
    const t = this.payments.get(ref);
    if (t) Object.assign(t, { status: 'FAILED', reason });
  }
  completeTransfers(status: 'SUCCESSFUL' | 'FAILED' = 'SUCCESSFUL'): void {
    for (const t of this.transfers.values()) t.status = status;
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const method = req.method ?? 'GET';
    this.requests.push({ method, path, headers: req.headers, body });

    const product = path.startsWith('/collection/') ? 'collection' : path.startsWith('/disbursement/') ? 'disbursement' : undefined;
    if (!product) return this.send(res, 404);
    const creds = MOMO[product];
    if (req.headers['ocp-apim-subscription-key'] !== creds.subscriptionKey) return this.send(res, 401, { code: 'UNAUTHORIZED', message: 'bad subscription key' });

    if (method === 'POST' && path === `/${product}/token/`) {
      const expected = `Basic ${Buffer.from(`${creds.apiUser}:${creds.apiKey}`).toString('base64')}`;
      if (req.headers['authorization'] !== expected) return this.send(res, 401, { code: 'UNAUTHORIZED', message: 'bad api user/key' });
      const token = `tok_${product}_${++this.seq}`;
      this.tokens.set(token, product);
      this.tokenIssues[product]++;
      return this.send(res, 200, { access_token: token, token_type: 'access_token', expires_in: 3600 });
    }

    const bearer = (req.headers['authorization'] ?? '').replace(/^Bearer /, '');
    if (this.tokens.get(bearer) !== product) return this.send(res, 401, { code: 'UNAUTHORIZED', message: 'invalid token' });
    if (req.headers['x-target-environment'] !== MOMO.environment) return this.send(res, 400, { code: 'NOT_ALLOWED_TARGET_ENVIRONMENT', message: 'wrong environment' });

    const store = product === 'collection' ? this.payments : this.transfers;
    const create = product === 'collection' ? '/collection/v1_0/requesttopay' : '/disbursement/v1_0/transfer';
    if (method === 'POST' && path === create) {
      const ref = String(req.headers['x-reference-id'] ?? '');
      if (!UUID.test(ref)) return this.send(res, 400, { code: 'INVALID_REFERENCE_ID', message: 'X-Reference-Id must be a UUID' });
      const drop = product === 'collection' && this.dropRequestToPayResponses > 0;
      if (drop) this.dropRequestToPayResponses--;
      if (store.has(ref)) {
        if (drop) return void req.socket.destroy();
        return this.send(res, 409, { code: 'RESOURCE_ALREADY_EXIST', message: 'Duplicated reference id' });
      }
      const b = body as Record<string, unknown>;
      const party = (b['payer'] ?? b['payee']) as { partyId?: string } | undefined;
      if (party?.partyId === '211900000000') return this.send(res, 404, { code: 'PAYER_NOT_FOUND', message: 'Payer not found' });
      store.set(ref, { ref, body: b, status: 'PENDING' });
      if (drop) return void req.socket.destroy(); // MTN accepted it, but the response never arrives
      return this.send(res, 202);
    }
    const m = new RegExp(`^${create}/([^/]+)$`).exec(path);
    if (method === 'GET' && m) {
      const t = store.get(m[1] ?? '');
      if (!t) return this.send(res, 404, { code: 'RESOURCE_NOT_FOUND', message: 'not found' });
      return this.send(res, 200, {
        amount: t.body['amount'],
        currency: t.body['currency'],
        externalId: t.body['externalId'],
        [product === 'collection' ? 'payer' : 'payee']: t.body[product === 'collection' ? 'payer' : 'payee'],
        status: t.status,
        ...(t.status === 'SUCCESSFUL' ? { financialTransactionId: `ft${++this.seq}` } : {}),
        ...(t.reason ? { reason: t.reason } : {}),
      });
    }
    return this.send(res, 404);
  }
}
