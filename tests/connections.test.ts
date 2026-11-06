import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { runChecks, webhookUrls, type CheckDeps, type CheckResult } from '../src/integrations/checks.js';
import { appSecretProof, WhatsAppSender } from '../src/providers/channels/whatsapp.js';
import { createLogger } from '../src/lib/logger.js';

const SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-secret-value-1234',
  DUFFEL_ACCESS_TOKEN: 'duffel_test_secretvalue1234',
  STRIPE_SECRET_KEY: 'sk_test_secretvalue1234',
  STRIPE_WEBHOOK_SECRET: 'whsec_secretvalue1234',
  MOMO_COLLECTION_API_KEY: 'momo-api-key-secret-1234',
  MOMO_COLLECTION_SUBSCRIPTION_KEY: 'momo-sub-key-secret-1234',
  RESEND_API_KEY: 're_secretvalue1234',
  TWILIO_AUTH_TOKEN: 'twilio-auth-token-secret-1234',
  WHATSAPP_ACCESS_TOKEN: 'EAAG-whatsapp-token-secret-1234',
  WHATSAPP_APP_SECRET: 'whatsapp-app-secret-1234',
};

const FULL_ENV = {
  NODE_ENV: 'development',
  PAYMENT_WEBHOOK_SECRET: 'p'.repeat(40),
  AUTH_SECRET: 'a'.repeat(40),
  ADMIN_API_TOKEN: 't'.repeat(40),
  SUPPORT_ALERT_EMAILS: 'desk@bluckflies.example',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/bluckflies',
  DATA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  ...SECRETS,
  FLIGHT_PROVIDER: 'duffel',
  DUFFEL_WEBHOOK_SECRET: 'duffel-webhook-secret',
  MOMO_BASE_URL: 'https://sandbox.momodeveloper.mtn.com',
  MOMO_TARGET_ENVIRONMENT: 'sandbox',
  MOMO_CURRENCY: 'EUR',
  MOMO_COLLECTION_API_USER: 'c72025f5-5cd1-4630-99e4-8ba4722fad56',
  MOMO_DISBURSEMENT_SUBSCRIPTION_KEY: 'momo-disb-sub-secret-1234',
  MOMO_DISBURSEMENT_API_USER: 'd72025f5-5cd1-4630-99e4-8ba4722fad57',
  MOMO_DISBURSEMENT_API_KEY: 'momo-disb-key-secret-1234',
  EMAIL_FROM: 'BluckFlies <tickets@bluckflies.example>',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_FROM: '+15005550006',
  WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  WHATSAPP_VERIFY_TOKEN: 'verify-token-123456',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '987654321098765',
  LEGAL_COMPANY_NAME: 'BluckFlies Ltd',
  LEGAL_COMPANY_ADDRESS: 'Hai Malakal, Juba, South Sudan',
  SUPPORT_EMAIL: 'help@bluckflies.example',
  SUPPORT_PHONE: '+211912345678',
  LEGAL_PAGES_APPROVED: 'true',
  WHATSAPP_TEMPLATE_HELD: 'bluckflies_seats_held',
  WHATSAPP_TEMPLATE_TICKETED: 'bluckflies_ticket_issued',
  BANK_NAME: 'KCB Bank South Sudan',
  BANK_ACCOUNT_NAME: 'BluckFlies Ltd',
  BANK_ACCOUNT_NUMBER: '1234567890',
  CASH_OFFICES: 'BluckFlies Juba | Hai Malakal, Juba | Mon-Sat 08:00-17:00',
  SSP_PER_USD: '4600',
  SSP_RATE_AS_OF: '2026-11-04T06:00:00Z',
  SSP_RATE_SOURCE: 'test',
};

type Route = (url: URL, init: RequestInit) => { status: number; body?: unknown } | undefined;

/** A fake network: each provider's endpoints answer like the real API documented in checks.ts. */
function fakeFetch(overrides: Route[] = []): { fetch: typeof fetch; calls: { url: string; method: string; headers: Record<string, string> }[] } {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const defaults: Route = (u) => {
    const p = u.pathname;
    if (u.host === 'api.anthropic.com' && p.startsWith('/v1/models/')) return { status: 200, body: { id: 'claude-sonnet-5-5' } };
    if (u.host === 'api.duffel.com' && p === '/air/airlines') return { status: 200, body: { data: [] } };
    if (u.host === 'api.stripe.com' && p === '/v1/checkout/sessions') return { status: 200, body: { data: [] } };
    if (p === '/collection/token/' || p === '/disbursement/token/') return { status: 200, body: { access_token: 'tok', expires_in: 3600 } };
    if (p === '/collection/v1_0/account/balance' || p === '/disbursement/v1_0/account/balance') return { status: 200, body: { availableBalance: '1000', currency: 'EUR' } };
    if (u.host === 'api.resend.com' && p === '/domains') return { status: 200, body: { data: [{ name: 'bluckflies.example', status: 'verified' }] } };
    if (u.host === 'api.twilio.com' && p.endsWith(`${FULL_ENV.TWILIO_ACCOUNT_SID}.json`)) return { status: 200, body: { status: 'active', type: 'Full' } };
    if (u.host === 'api.twilio.com' && p.endsWith('/IncomingPhoneNumbers.json')) return { status: 200, body: { incoming_phone_numbers: [{ phone_number: FULL_ENV.TWILIO_FROM }] } };
    if (u.host === 'graph.facebook.com' && p.endsWith('/message_templates')) {
      const data = ['bluckflies_seats_held', 'bluckflies_ticket_issued'].flatMap((name) => ['en', 'ar'].map((language) => ({ name, language, status: 'APPROVED' })));
      return { status: 200, body: { data } };
    }
    if (u.host === 'graph.facebook.com') return { status: 200, body: { verified_name: 'BluckFlies', display_phone_number: '+211 92 000 0000' } };
    return undefined;
  };
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: url.toString(), method: init.method ?? 'GET', headers });
    for (const route of [...overrides, defaults]) {
      const r = route(url, init);
      if (r) return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
    }
    throw new TypeError('fetch failed');
  };
  return { fetch: impl as typeof fetch, calls };
}

function deps(fetchImpl: typeof fetch, over: Partial<CheckDeps> = {}): CheckDeps {
  return {
    fetch: fetchImpl,
    timeoutMs: 1000,
    now: new Date('2026-11-04T09:00:00Z'),
    localMigrations: ['m1', 'm2'],
    readMigrations: async () => ({ applied: ['m1', 'm2'] }),
    ...over,
  };
}

const byService = (results: CheckResult[], service: string) => results.find((r) => r.service === service);

describe('connection checks', () => {
  it('reports every configured service as connected, using read-only calls', async () => {
    const net = fakeFetch();
    const results = await runChecks(loadConfig(FULL_ENV), deps(net.fetch));
    const notOk = results.filter((r) => r.status !== 'ok' && r.status !== 'off' && !/callbacks|webhook|Legal pages/i.test(r.service));
    expect(notOk).toEqual([]);
    // Pages marked approved while the texts still hold the reviewer's [to be …] markers is an error.
    expect(byService(results, 'Legal pages (/terms, /privacy, /refunds)')).toMatchObject({ status: 'fail', detail: expect.stringContaining('/terms, /privacy, /refunds still show [to be …] markers') });
    // The only non-GET calls are MTN's token endpoints, which create nothing.
    expect(net.calls.filter((c) => c.method !== 'GET').map((c) => new URL(c.url).pathname).sort()).toEqual(['/collection/token/', '/disbursement/token/']);
    expect(byService(results, 'WhatsApp (Meta)')?.detail).toContain('BluckFlies');
  });

  it('sends the documented auth headers to each provider', async () => {
    const net = fakeFetch();
    await runChecks(loadConfig(FULL_ENV), deps(net.fetch));
    const call = (host: string) => net.calls.find((c) => new URL(c.url).host === host);
    expect(call('api.anthropic.com')?.headers).toMatchObject({ 'x-api-key': SECRETS.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
    expect(call('api.duffel.com')?.headers).toMatchObject({ authorization: `Bearer ${SECRETS.DUFFEL_ACCESS_TOKEN}`, 'duffel-version': 'v2' });
    const balance = net.calls.find((c) => c.url.includes('/account/balance'));
    expect(balance?.headers).toMatchObject({ 'x-target-environment': 'sandbox', 'ocp-apim-subscription-key': SECRETS.MOMO_COLLECTION_SUBSCRIPTION_KEY });
    const graph = call('graph.facebook.com');
    expect(new URL(graph?.url ?? 'http://x').searchParams.get('appsecret_proof')).toBe(appSecretProof(SECRETS.WHATSAPP_ACCESS_TOKEN, SECRETS.WHATSAPP_APP_SECRET));
  });

  it('explains each provider\'s typical failure with a fix, and never prints a secret', async () => {
    const net = fakeFetch([
      (u) => (u.host === 'api.anthropic.com' ? { status: 404, body: { error: { message: 'model not found' } } } : undefined),
      (u) => (u.host === 'api.duffel.com' ? { status: 401, body: { errors: [{ message: 'invalid token' }] } } : undefined),
      (u) => (u.host === 'api.stripe.com' ? { status: 403, body: { error: { message: 'restricted' } } } : undefined),
      (u) => (u.pathname === '/collection/v1_0/account/balance' ? { status: 500, body: { message: 'target environment not found' } } : undefined),
      (u) => (u.host === 'api.resend.com' ? { status: 200, body: { data: [{ name: 'bluckflies.example', status: 'pending' }] } } : undefined),
      (u) => (u.pathname.endsWith('/IncomingPhoneNumbers.json') ? { status: 200, body: { incoming_phone_numbers: [] } } : undefined),
      (u) => (u.host === 'graph.facebook.com' ? { status: 400, body: { error: { code: 100, message: 'Invalid appsecret_proof provided in the API argument' } } } : undefined),
    ]);
    const results = await runChecks(loadConfig(FULL_ENV), deps(net.fetch, { readMigrations: async () => ({ applied: ['m1'] }) }));
    const expectFail = (service: string, pattern: RegExp) => {
      const r = byService(results, service);
      expect(r?.status, service).toBe('fail');
      expect(`${r?.detail} ${r?.fix ?? ''}`, service).toMatch(pattern);
    };
    expectFail('Claude (AI agent)', /ANTHROPIC_MODEL/);
    expectFail('Duffel (airline flights)', /rejected/);
    expectFail('Stripe (cards)', /Checkout Sessions/);
    expectFail('MTN MoMo payments', /MOMO_TARGET_ENVIRONMENT/);
    expectFail('Resend (email)', /not verified/);
    expectFail('Twilio (SMS)', /TWILIO_FROM/);
    expectFail('WhatsApp (Meta)', /WHATSAPP_APP_SECRET/);
    expectFail('PostgreSQL database', /db:deploy/);
    const printed = JSON.stringify(results);
    for (const secret of [...Object.values(SECRETS), FULL_ENV.MOMO_DISBURSEMENT_API_KEY, 'pw@']) expect(printed).not.toContain(secret);
  });

  it('turns an unreachable provider into a failure instead of crashing the check', async () => {
    const net = fakeFetch([(u) => { if (u.host === 'api.stripe.com') throw new TypeError('fetch failed'); return undefined; }]);
    const results = await runChecks(loadConfig(FULL_ENV), deps(net.fetch, { readMigrations: async () => { throw new Error('connect ECONNREFUSED'); } }));
    expect(byService(results, 'Stripe (cards)')).toMatchObject({ status: 'fail', detail: expect.stringContaining('Could not reach api.stripe.com') });
    expect(byService(results, 'PostgreSQL database')?.fix).toMatch(/Is PostgreSQL running/);
    expect(byService(results, 'Claude (AI agent)')?.status).toBe('ok');
  });

  it('flags a stale exchange rate; live payment keys outside production never reach the checks', async () => {
    const results = await runChecks(loadConfig({ ...FULL_ENV, SSP_RATE_AS_OF: '2026-10-30T06:00:00Z' }), deps(fakeFetch().fetch));
    expect(byService(results, 'SSP exchange rate')?.status).toBe('warn');
    // The CLI reports this configuration error before any network call.
    expect(() => loadConfig({ ...FULL_ENV, STRIPE_SECRET_KEY: 'sk_live_secretvalue1234' })).toThrow(/live Stripe keys/);
  });

  it('with nothing configured, warns about the essentials and fails nothing', async () => {
    const results = await runChecks(loadConfig({ NODE_ENV: 'development', PAYMENT_WEBHOOK_SECRET: 'p'.repeat(40) }), deps(fakeFetch().fetch));
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
    expect(byService(results, 'Claude (AI agent)')?.status).toBe('warn');
    expect(byService(results, 'Legal pages (/terms, /privacy, /refunds)')).toMatchObject({ status: 'warn', detail: expect.stringContaining('Shown as drafts; not set: LEGAL_COMPANY_NAME') });
    expect(webhookUrls(loadConfig({ NODE_ENV: 'development', PAYMENT_WEBHOOK_SECRET: 'p'.repeat(40) }))).toEqual([]);
  });
});

describe('WhatsApp sender', () => {
  it('signs sends with appsecret_proof, so apps that require the app secret still accept them', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const sender = new WhatsAppSender({ accessToken: SECRETS.WHATSAPP_ACCESS_TOKEN, phoneNumberId: '123456789012345', apiVersion: 'v21.0', appSecret: SECRETS.WHATSAPP_APP_SECRET }, createLogger('error'));
      await sender.send('+211920000000', { text: 'Hello' });
      const url = new URL(String(spy.mock.calls[0]?.[0]));
      expect(url.pathname).toBe('/v21.0/123456789012345/messages');
      expect(url.searchParams.get('appsecret_proof')).toBe(appSecretProof(SECRETS.WHATSAPP_ACCESS_TOKEN, SECRETS.WHATSAPP_APP_SECRET));
    } finally {
      spy.mockRestore();
    }
  });

  it('fails WhatsApp templates that Meta has not approved in both languages', async () => {
    const net = fakeFetch([
      (u) => (u.host === 'graph.facebook.com' && u.pathname.endsWith('/message_templates')
        ? { status: 200, body: { data: [
          { name: 'bluckflies_seats_held', language: 'en', status: 'APPROVED' },
          { name: 'bluckflies_seats_held', language: 'ar', status: 'PENDING' },
          { name: 'bluckflies_ticket_issued', language: 'en', status: 'REJECTED' },
        ] } }
        : undefined),
    ]);
    const r = byService(await runChecks(loadConfig(FULL_ENV), deps(net.fetch)), 'WhatsApp templates');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('bluckflies_seats_held (ar): pending');
    expect(r?.detail).toContain('bluckflies_ticket_issued (en): rejected');
    expect(r?.detail).toContain('bluckflies_ticket_issued (ar): not found');
    expect(r?.detail).not.toContain('(en): approved');
    const call = net.calls.find((c) => c.url.includes('/message_templates'));
    expect(call?.method).toBe('GET');
    expect(call?.url).toContain('/987654321098765/message_templates');
  });
});

describe('DPO and bank transfer checks', () => {
  const dpoEnv = { ...FULL_ENV, DPO_COMPANY_TOKEN: '9F416C11-127B-4DE2-AC7F-D5710E4C5E0A', DPO_SERVICE_TYPE: '5525', CARD_PROVIDER: 'dpo' };

  async function run(result: string) {
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.host === 'secure.3gdirectpay.com') {
        calls.push(String(init.body));
        return new Response(`<API3G><Result>${result}</Result><ResultExplanation>x</ResultExplanation></API3G>`, { status: 200 });
      }
      return fakeFetch().fetch(input, init);
    }) as typeof fetch;
    return { results: await runChecks(loadConfig(dpoEnv), deps(impl)), calls };
  }

  it('accepts a valid DPO company token using a read-only verify, and says Stripe is kept for refunds', async () => {
    const { results, calls } = await run('950');
    expect(byService(results, 'DPO Pay (bank cards)')).toMatchObject({ status: 'ok', detail: expect.stringContaining('Company token accepted') });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('<Request>verifyToken</Request>');
    expect(byService(results, 'Stripe (cards)')?.detail).toMatch(/kept for refunds/);
    expect(byService(results, 'Bank transfer / branch deposit')).toMatchObject({ status: 'ok', detail: expect.stringContaining('ending 7890') });
  });

  it('fails a rejected DPO company token without printing it', async () => {
    const { results } = await run('802');
    expect(byService(results, 'DPO Pay (bank cards)')?.status).toBe('fail');
    expect(JSON.stringify(results)).not.toContain(dpoEnv.DPO_COMPANY_TOKEN);
  });
});
