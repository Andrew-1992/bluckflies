import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { runLiveChecks, type LiveCheck, type LiveCheckDeps } from '../src/launch/liveChecks.js';
import { testContainer } from './helpers.js';
import { FAKE_TOKEN, FakeDuffel } from './support/fakeDuffel.js';

const SITE = 'https://bluckflies.test';
const READY = {
  LEGAL_COMPANY_NAME: 'BluckFlies Ltd',
  LEGAL_COMPANY_ADDRESS: 'Hai Malakal, Juba, South Sudan',
  SUPPORT_EMAIL: 'help@bluckflies.example',
  SUPPORT_PHONE: '+211912345678',
  LEGAL_PAGES_APPROVED: 'true',
  ADMIN_API_TOKEN: 'a'.repeat(40),
  BANK_NAME: 'KCB Bank South Sudan',
  BANK_ACCOUNT_NAME: 'BluckFlies Ltd',
  BANK_ACCOUNT_NUMBER: '1234567890',
  ENABLE_SANDBOX_ENDPOINTS: 'false',
};

/** The legal texts as they will be after the lawyer review: no open [to be …] markers. */
const reviewed = async (path: string, r: Response): Promise<Response | undefined> => {
  if (!['/terms', '/privacy', '/refunds'].includes(path)) return undefined;
  const html = (await r.text()).replace(/\[to be (decided|reviewed|completed)[^\]]*\]/gi, 'Decided.');
  return new Response(html, { status: r.status, headers: r.headers });
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(c: Container): Promise<string> {
  const server = createServer(createApp(c));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Stands in for Caddy and the internet: https://bluckflies.test reaches the local
 * app (adding HSTS, as the Caddyfile does), http:// redirects to https://.
 * `tamper` lets a test change a response, as a misconfigured server would.
 */
function deps(local: string, opts: { certDays?: number | null; tamper?: (path: string, r: Response) => Response | undefined | Promise<Response | undefined> } = {}): LiveCheckDeps {
  return {
    today: () => '2026-11-06',
    certificateDaysLeft: async () => (opts.certDays === undefined ? 80 : opts.certDays),
    fetch: async (input, init) => {
      const u = new URL(String(input));
      if (u.protocol === 'http:' && u.host === 'bluckflies.test') return new Response(null, { status: 308, headers: { location: `${SITE}${u.pathname}` } });
      const r = await fetch(`${local}${u.pathname}${u.search}`, init);
      const withHsts = new Response(r.body, { status: r.status, headers: new Headers(r.headers) });
      withHsts.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
      return (await opts.tamper?.(u.pathname, withHsts)) ?? withHsts;
    },
  };
}

const byArea = (rs: LiveCheck[]) => Object.fromEntries(rs.map((r) => [r.area, r.status]));

describe('launch check (live site, read-only)', () => {
  let duffel: FakeDuffel | undefined;
  afterEach(() => duffel?.stop());

  it('passes a correctly configured site with real flights and approved legal pages', async () => {
    duffel = new FakeDuffel();
    duffel.templates = [{ owner: { iata_code: 'KQ', name: 'Kenya Airways' }, totalCents: 52000, requiresInstantPayment: false, departLocal: '14:30', arriveLocal: '17:25', flightNumber: '351', refund: { allowed: true, penaltyCents: 5000 } }];
    await duffel.start();
    const { c } = testContainer({}, { ...READY, FLIGHT_PROVIDER: 'duffel', DUFFEL_ACCESS_TOKEN: FAKE_TOKEN, DUFFEL_API_URL: duffel.url, DUFFEL_WEBHOOK_SECRET: 'duffel-webhook-secret-123456' });
    const results = await runLiveChecks(SITE, deps(await serve(c), { tamper: reviewed }));
    expect(results.filter((r) => r.status !== 'ok')).toEqual([]);
    expect(byArea(results)).toMatchObject({ 'HTTPS certificate': 'ok', 'HTTP → HTTPS': 'ok', HSTS: 'ok', Ready: 'ok', 'Legal pages': 'ok', 'Admin API': 'ok', Webhooks: 'ok', 'Sandbox switched off': 'ok', Flights: 'ok', 'Payment methods': 'ok', 'Web client': 'ok' });
  });

  it('fails sandbox flights and sandbox payment endpoints, and warns about draft legal pages', async () => {
    const { c } = testContainer({}, { ENABLE_SANDBOX_ENDPOINTS: 'true' });
    const results = await runLiveChecks(SITE, deps(await serve(c)));
    expect(byArea(results)).toMatchObject({ Flights: 'fail', 'Sandbox switched off': 'fail', 'Legal pages': 'warn' });
  });

  it('fails a site that accepts a forged payment event or exposes the admin API', async () => {
    const { c } = testContainer({}, READY);
    const tamper = (path: string) =>
      path === '/api/webhooks/stripe' ? new Response('{}', { status: 200 }) : path === '/api/admin/tickets' ? new Response('[]', { status: 200 }) : undefined;
    const results = await runLiveChecks(SITE, deps(await serve(c), { tamper }));
    const webhooks = results.find((r) => r.area === 'Webhooks');
    expect(webhooks).toMatchObject({ status: 'fail', detail: expect.stringContaining('/api/webhooks/stripe') });
    expect(byArea(results)['Admin API']).toBe('fail');
  });

  it('fails plain HTTP, an expiring certificate and missing HSTS', async () => {
    const { c } = testContainer({}, READY);
    const local = await serve(c);
    expect(byArea(await runLiveChecks(local, deps(local)))).toMatchObject({ HTTPS: 'fail' });
    expect(byArea(await runLiveChecks(SITE, deps(local, { certDays: 5 })))).toMatchObject({ 'HTTPS certificate': 'fail' });
    const noHsts = (_p: string, r: Response) => {
      r.headers.delete('strict-transport-security');
      return r;
    };
    expect(byArea(await runLiveChecks(SITE, deps(local, { tamper: noHsts })))).toMatchObject({ HSTS: 'fail' });
  });

  it('reports an unreachable part as a failure of that part, and keeps checking the rest', async () => {
    const { c } = testContainer({}, READY);
    const local = await serve(c);
    const d = deps(local);
    const broken: LiveCheckDeps = { ...d, fetch: async (input, init) => (String(input).endsWith('/readyz') ? Promise.reject(new Error('connection reset')) : d.fetch(input, init)) };
    const results = await runLiveChecks(SITE, broken);
    expect(results.find((r) => r.area === 'Ready')).toMatchObject({ status: 'fail', detail: 'Could not check: connection reset' });
    expect(byArea(results)['Admin API']).toBe('ok');
  });
});
