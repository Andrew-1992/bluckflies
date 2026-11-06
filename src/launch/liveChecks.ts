import { connect } from 'node:tls';

/**
 * Pre-launch checks against a running BluckFlies site, from the outside, the
 * way a traveller or an attacker sees it. Read-only: it never books, pays or
 * changes anything. The one write is an anonymous chat session, needed to run
 * a flight search; the search itself is free at the airline platform.
 *
 * Run before the real-money tests (docs/LAUNCH.md section 3), after every
 * deployment, and whenever settings change:
 *
 *   npm run launch:check -- https://bluckflies.com
 */

export type Status = 'ok' | 'warn' | 'fail';
export interface LiveCheck {
  area: string;
  status: Status;
  detail: string;
  fix?: string;
}

export interface LiveCheckDeps {
  fetch: typeof fetch;
  /** Days until the site's TLS certificate expires (null: could not tell). */
  certificateDaysLeft(host: string): Promise<number | null>;
  /** YYYY-MM-DD in Juba, for the test search date. */
  today(): string;
}

const TIMEOUT_MS = 15_000;
const HSTS_MIN_SECONDS = 180 * 24 * 3600;
const CERT_MIN_DAYS = 14;

export async function certificateDaysLeft(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
      const validTo = socket.getPeerCertificate()?.valid_to;
      socket.end();
      resolve(validTo ? Math.floor((Date.parse(validTo) - Date.now()) / 86_400_000) : null);
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

export const defaultDeps = (): LiveCheckDeps => ({
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
  certificateDaysLeft,
  today: () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Juba' }),
});

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function runLiveChecks(baseUrl: string, deps: LiveCheckDeps): Promise<LiveCheck[]> {
  const base = new URL(baseUrl);
  const url = (path: string) => new URL(path, base).toString();
  const out: LiveCheck[] = [];
  const add = (area: string, status: Status, detail: string, fix?: string) => out.push({ area, status, detail, ...(fix ? { fix } : {}) });

  /** Runs one area; a network error or crash in it is a failure of that area, not of the run. */
  const area = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      add(name, 'fail', `Could not check: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const get = (path: string, init: RequestInit = {}) => deps.fetch(url(path), { redirect: 'manual', ...init });
  /** An anonymous traveller session, as the web app starts one (needed for search and probing /api). */
  const newSession = async (): Promise<string | undefined> => {
    const s = await get('/api/sessions', { method: 'POST' });
    return s.status === 201 ? ((await s.json()) as { token?: string }).token : undefined;
  };

  // ------------------------------------------------------------- transport
  await area('HTTPS', async () => {
    if (base.protocol !== 'https:') {
      add('HTTPS', 'fail', `${base.origin} is not HTTPS: card pages, sign-in codes and passport details would travel unencrypted.`, 'Serve the site through Caddy (docs/DEPLOY.md section 4) and check the https:// address.');
      return;
    }
    const days = await deps.certificateDaysLeft(base.hostname);
    if (days === null) add('HTTPS certificate', 'warn', 'Could not read the certificate expiry.');
    else if (days < CERT_MIN_DAYS) add('HTTPS certificate', 'fail', `Certificate expires in ${days} days.`, 'Caddy renews automatically; check that ports 80 and 443 are reachable and read the caddy logs.');
    else add('HTTPS certificate', 'ok', `Valid for ${days} more days.`);

    const plain = await deps.fetch(`http://${base.host}/`, { redirect: 'manual' }).catch(() => null);
    const to = plain?.headers.get('location') ?? '';
    if (plain && plain.status >= 300 && plain.status < 400 && to.startsWith('https://')) add('HTTP → HTTPS', 'ok', `http:// redirects to ${to}`);
    else add('HTTP → HTTPS', 'fail', plain ? `http:// answered ${plain.status} without redirecting to https://.` : 'http:// did not answer (port 80 closed?): Caddy needs it to renew certificates.', 'Open port 80 and let Caddy redirect it.');
  });

  // --------------------------------------------------------------- health
  await area('Ready', async () => {
    const r = await get('/readyz');
    if (r.status === 200) add('Ready', 'ok', '/readyz: database reachable and migrated.');
    else add('Ready', 'fail', `/readyz answered ${r.status}.`, 'docker compose ps; docker compose logs --tail 100 app');
  });

  // ------------------------------------------------------ security headers
  await area('Security headers', async () => {
    const r = await get('/');
    const h = (n: string) => r.headers.get(n) ?? '';
    const missing: string[] = [];
    if (!/default-src/.test(h('content-security-policy'))) missing.push('Content-Security-Policy');
    if (h('x-content-type-options').toLowerCase() !== 'nosniff') missing.push('X-Content-Type-Options');
    if (!/frame-ancestors 'none'/.test(h('content-security-policy')) && !/deny/i.test(h('x-frame-options'))) missing.push('clickjacking protection');
    if (!h('referrer-policy')) missing.push('Referrer-Policy');
    if (missing.length) add('Security headers', 'fail', `Missing: ${missing.join(', ')}.`);
    else add('Security headers', 'ok', 'CSP, nosniff, framing and referrer policy set.');

    if (base.protocol === 'https:') {
      const maxAge = Number(/max-age=(\d+)/.exec(h('strict-transport-security'))?.[1] ?? 0);
      if (maxAge >= HSTS_MIN_SECONDS) add('HSTS', 'ok', `Strict-Transport-Security max-age=${maxAge}.`);
      else add('HSTS', 'fail', maxAge ? `HSTS max-age only ${maxAge}s.` : 'No Strict-Transport-Security header.', 'Use deploy/caddy/Caddyfile, which sets it.');
    }
    const leaks = ['x-powered-by', 'server'].filter((n) => h(n));
    if (leaks.length) add('Server banner', 'warn', `Reveals ${leaks.map((n) => `${n}: ${h(n)}`).join(', ')}.`, 'Remove it at the proxy (the Caddyfile drops Server).');
  });

  // -------------------------------------------------------------- legal
  await area('Legal pages', async () => {
    const pages = ['/terms', '/privacy', '/refunds'];
    const bodies = await Promise.all(pages.map(async (p) => ({ p, r: await get(p) })));
    const broken = bodies.filter((b) => b.r.status !== 200).map((b) => `${b.p} (${b.r.status})`);
    if (broken.length) {
      add('Legal pages', 'fail', `Not served: ${broken.join(', ')}.`);
      return;
    }
    const texts = await Promise.all(bodies.map((b) => b.r.text()));
    const drafts = pages.filter((_, i) => texts[i]?.includes('Draft for legal review'));
    const gaps = pages.filter((_, i) => /\[to be (decided|reviewed|completed)/i.test(texts[i] ?? ''));
    if (drafts.length || gaps.length) {
      add('Legal pages', 'warn', `${drafts.length ? `Still drafts: ${drafts.join(', ')}. ` : ''}${gaps.length ? `Open [to be …] markers on: ${gaps.join(', ')}.` : ''}`.trim(), 'Lawyer review, then LEGAL_PAGES_APPROVED=true (docs/LAUNCH.md section 1).');
    } else add('Legal pages', 'ok', 'Terms, Privacy and Refunds published and approved.');
  });

  // --------------------------------------------------------- locked doors
  await area('Admin API', async () => {
    const r = await get('/api/admin/tickets');
    if (r.status === 401) add('Admin API', 'ok', 'Refuses requests without a staff sign-in (401).');
    else if (r.status === 404) add('Admin API', 'warn', 'Not found: the support desk is not enabled (no ADMIN_API_TOKEN and no staff accounts?).');
    else add('Admin API', 'fail', `Answered ${r.status} without a staff sign-in.`, 'Stop and investigate before taking payments.');
  });

  await area('Webhooks', async () => {
    const forged = [
      { path: '/api/webhooks/stripe', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"checkout.session.completed"}' } },
      { path: '/api/webhooks/duffel', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"order.airline_initiated_change_detected"}' } },
      { path: '/api/webhooks/momo', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"SUCCESSFUL"}' } },
      { path: '/api/webhooks/whatsapp', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"entry":[]}' } },
      { path: '/api/webhooks/sms', init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'From=%2B211900000000&Body=YES' } },
      { path: `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=launch-check-wrong-token&hub.challenge=x`, init: { method: 'GET' } },
    ];
    const accepted: string[] = [];
    const errors: string[] = [];
    let active = 0;
    for (const f of forged) {
      const r = await get(f.path, f.init);
      const shown = f.path.split('?')[0] ?? f.path;
      if (r.status === 404) continue; // that channel is not configured
      active++;
      if (r.status >= 200 && r.status < 300) accepted.push(shown);
      else if (r.status >= 500) errors.push(`${shown} (${r.status})`);
    }
    if (accepted.length) add('Webhooks', 'fail', `Accepted an unsigned, forged event: ${accepted.join(', ')}.`, 'Check the webhook secrets in .env; a forged payment event could issue tickets without payment.');
    else if (errors.length) add('Webhooks', 'warn', `Forged events refused, but with server errors: ${errors.join(', ')}.`);
    else add('Webhooks', 'ok', `${active} configured webhook endpoint(s) refuse unsigned events.`);
  });

  await area('Sandbox switched off', async () => {
    // The simulated-payment endpoints exist only with ENABLE_SANDBOX_ENDPOINTS=true. Unknown /api paths
    // answer 401 without a session, so probe with one, and with an invalid body so nothing could happen
    // even if they exist: off → 404 (no such route); on → a validation or signature error.
    const token = await newSession();
    if (!token) {
      add('Sandbox switched off', 'fail', 'Could not start a session to probe.');
      return;
    }
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const r = await get('/api/sandbox/bookings/ABC234/payment', { method: 'POST', headers: auth, body: '{"outcome":"launch-check-invalid"}' });
    const hook = await get('/api/webhooks/sandbox', { method: 'POST', headers: auth, body: '{}' });
    if (r.status === 404 && hook.status === 404) add('Sandbox switched off', 'ok', 'No simulated-payment endpoints.');
    else add('Sandbox switched off', 'fail', `Sandbox payment endpoints answer (${r.status}, ${hook.status}): anyone could mark a booking paid.`, 'ENABLE_SANDBOX_ENDPOINTS=false and NODE_ENV=production.');
  });

  // --------------------------------------------------- real inventory
  await area('Flights', async () => {
    const token = await newSession();
    if (!token) {
      add('Flights', 'fail', 'Could not start a session.');
      return;
    }
    const day = addDays(deps.today(), 14);
    const r = await get('/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ origin: 'JUB', destination: 'NBO', departureDate: day, adults: 1 }),
    });
    if (r.status !== 200) {
      add('Flights', 'fail', `Search Juba → Nairobi on ${day} answered ${r.status}.`, 'Check FLIGHT_PROVIDER and the Duffel token (npm run connect:check).');
      return;
    }
    const body = (await r.json()) as { offers?: Array<{ sandbox?: boolean; airline?: string }> };
    const offers = body.offers ?? [];
    if (offers.some((o) => o.sandbox)) add('Flights', 'fail', 'Search returns sandbox (made-up) flights.', 'FLIGHT_PROVIDER=duffel with a live token; production refuses sandbox flights at start-up.');
    else if (offers.length === 0) add('Flights', 'warn', `No offers Juba → Nairobi on ${day}. Try another date in the booking tests; a live Duffel account may still need approval.`);
    else add('Flights', 'ok', `${offers.length} real offers Juba → Nairobi on ${day} (${[...new Set(offers.map((o) => o.airline).filter(Boolean))].slice(0, 3).join(', ')}).`);
  });

  await area('Payment methods', async () => {
    const r = await get('/api/payment-options');
    const methods = r.status === 200 ? (((await r.json()) as { methods?: Array<{ method: string; name: string }> }).methods ?? []) : [];
    if (methods.length === 0) add('Payment methods', 'fail', 'No payment methods offered.', 'Configure DPO/Stripe, BANK_* and CASH_OFFICES (docs/CONNECT.md section 7).');
    else add('Payment methods', 'ok', `Offered: ${methods.map((m) => m.name).join(', ')}. Test each one in docs/LAUNCH.md section 3.`);
  });

  // --------------------------------------------------- the web client
  await area('Web client', async () => {
    const home = await get('/');
    const html = await home.text();
    const asset = /\/v\/[0-9a-f]+\/[^"']+\.js/.exec(html)?.[0];
    if (home.status !== 200 || !asset) {
      add('Web client', 'fail', `Home page ${home.status}${asset ? '' : ', no versioned scripts'}.`);
      return;
    }
    const a = await get(asset);
    const cache = a.headers.get('cache-control') ?? '';
    const desk = await get('/desk.html');
    if (a.status === 200 && /immutable/.test(cache) && desk.status === 200) add('Web client', 'ok', 'Home page, desk and versioned scripts served (cached safely across updates).');
    else add('Web client', 'warn', `Script ${a.status} (${cache || 'no cache header'}), desk ${desk.status}.`);
  });

  return out;
}
