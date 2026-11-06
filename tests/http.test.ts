import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { FRIDAY, ScriptedLlm, testContainer, text, toolCall } from './helpers.js';

async function session(app: ReturnType<typeof createApp>) {
  const res = await request(app).post('/api/sessions').expect(201);
  return res.body.token as string;
}

describe('HTTP API', () => {
  it('serves health, the web client and security headers', async () => {
    const app = createApp(testContainer().c);
    const health = await request(app).get('/healthz').expect(200);
    expect(health.body.agent).toBe('unconfigured');
    const page = await request(app).get('/').expect(200);
    expect(page.text).toContain('BluckFlies');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['x-powered-by']).toBeUndefined();
    // Voice input may use the microphone on our own origin only.
    expect(page.headers['permissions-policy']).toContain('microphone=(self)');
  });

  it('accepts spoken messages on the voice channel and rejects unknown channels', async () => {
    const llm = new ScriptedLlm([text('Short spoken answer.')]);
    const app = createApp(testContainer({ llm }).c);
    const auth = { authorization: `Bearer ${await session(app)}` };
    const res = await request(app).post('/api/chat').set(auth).send({ message: 'Juba to Wau', channel: 'voice' }).expect(200);
    expect(res.body.reply).toBe('Short spoken answer.');
    expect(llm.requests[0]?.system).toContain('## Voice conversation');
    const bad = await request(app).post('/api/chat').set(auth).send({ message: 'hi', channel: 'telepathy' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('serves the web client from versioned URLs so an update never runs with cached old files', async () => {
    const app = createApp(testContainer().c);
    for (const page of ['/', '/desk.html']) {
      const res = await request(app).get(page).expect(200);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.text).not.toMatch(/(?:href|src)="\/(?:styles|app|desk)\.(?:css|js)"/);
    }
    const html = (await request(app).get('/').expect(200)).text;
    const script = /src="(\/v\/[0-9a-f]{12}\/app\.js)"/.exec(html)?.[1];
    const style = /href="(\/v\/[0-9a-f]{12}\/styles\.css)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    expect(style).toBeDefined();
    // Current version: cached long. Relative module imports resolve under the same prefix.
    const js = await request(app).get(script ?? '').expect(200);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['content-type']).toMatch(/javascript/);
    const prefix = (script ?? '').replace('app.js', '');
    await request(app).get(`${prefix}js/i18n.js`).expect(200);
    // A link from an older page still works but is never cached long.
    const old = await request(app).get('/v/000000000000/app.js').expect(200);
    expect(old.headers['cache-control']).toBe('no-cache');
    // Unversioned paths keep working, revalidated on every load.
    const plain = await request(app).get('/app.js').expect(200);
    expect(plain.headers['cache-control']).toBe('no-cache');
    expect(plain.headers['etag']).toBeTruthy();
  });

  it('gives the client a new fingerprint when any client file changes', async () => {
    const { mkdtemp, writeFile, utimes } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { clientFingerprint, versionAssetLinks } = await import('../src/http/webClient.js');
    const dir = await mkdtemp(join(tmpdir(), 'bf-client-'));
    await writeFile(join(dir, 'app.js'), 'console.log(1);');
    const before = await clientFingerprint(dir);
    await writeFile(join(dir, 'app.js'), 'console.log(22);');
    await utimes(join(dir, 'app.js'), new Date(), new Date(Date.now() + 5000));
    expect(await clientFingerprint(dir)).not.toBe(before);
    expect(versionAssetLinks('<script src="/app.js"></script><a href="/api/x">', 'abc')).toBe('<script src="/v/abc/app.js"></script><a href="/api/x">');
  });

  it('serves the brand: absolute link-preview tags, icons, manifest and a font preload that matches the stylesheet', async () => {
    const app = createApp(testContainer({}, { PUBLIC_BASE_URL: 'https://bluckflies.example' }).c);
    const html = (await request(app).get('/').expect(200)).text;
    expect(html).toContain('<meta property="og:image" content="https://bluckflies.example/brand/og.png" />');
    expect(html).not.toContain('%PUBLIC_BASE_URL%');
    // The preloaded font and the stylesheet's font share one versioned URL (no double download).
    const preload = /<link rel="preload" href="(\/v\/[0-9a-f]+\/fonts\/[\w.-]+\.woff2)"/.exec(html)?.[1];
    const css = /href="(\/v\/[0-9a-f]+\/styles\.css)"/.exec(html)?.[1] ?? '';
    expect(preload).toBeDefined();
    expect(new URL('fonts/ibm-plex-sans-latin-700-normal.woff2', `https://x${css}`).pathname).toBe(preload);
    const font = await request(app).get(preload ?? '').expect(200);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(font.headers['cache-control']).toContain('immutable');
    const manifest = await request(app).get('/manifest.webmanifest').expect(200);
    expect(manifest.headers['content-type']).toMatch(/application\/manifest\+json/);
    for (const icon of JSON.parse(manifest.text).icons as Array<{ src: string }>) await request(app).get(icon.src).expect(200);
    await request(app).get('/brand/favicon.svg').expect(200).expect('content-type', /image\/svg\+xml/);
  });

  it('escapes the site address it writes into pages', async () => {
    const { fillSiteAddress } = await import('../src/http/webClient.js');
    expect(fillSiteAddress('<meta content="%PUBLIC_BASE_URL%/x">', 'https://a.example/"><script>')).toBe('<meta content="https://a.example/&#34;&#62;&#60;script&#62;/x">');
    expect(fillSiteAddress('%PUBLIC_BASE_URL%/', 'https://a.example/')).toBe('https://a.example/');
  });

  it('requires a session token and reports 503 when the agent is unconfigured', async () => {
    const app = createApp(testContainer().c);
    await request(app).get('/api/bookings').expect(401);
    await request(app).get('/api/bookings').set('authorization', 'Bearer forged').expect(401);
    const token = await session(app);
    const res = await request(app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'hi' }).expect(503);
    expect(res.body.error.code).toBe('AGENT_UNAVAILABLE');
  });

  it('rejects unsigned webhooks without leaking internals', async () => {
    const app = createApp(testContainer().c);
    const res = await request(app).post('/api/webhooks/sandbox').set('content-type', 'application/json').send('{"id":"x"}').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('runs the full flow: chat → propose → traveller confirms → pay → ticketed', async () => {
    let offerId = '';
    let pnr = '';
    const llm = new ScriptedLlm([
      toolCall('search_flights', { origin: 'JUB', destination: 'EBB', departure_date: FRIDAY, sort_by: 'cheapest' }),
      (req) => {
        const last = req.messages.at(-1);
        const block = Array.isArray(last?.content) ? last.content[0] : undefined;
        offerId = JSON.parse(block && 'content' in block ? block.content : '{}').offers[0].offerId;
        return text('Cheapest is XS420.');
      },
      () =>
        toolCall('propose_reservation', {
          offer_id: offerId,
          passengers: [{ type: 'adult', given_name: 'Nyandeng', family_name: 'Garang', gender: 'f', date_of_birth: '1995-03-02', nationality: 'SS', passport_number: 'R00999888', passport_expiry: '2031-06-30' }],
          contact_phone: '+211912345678',
          contact_email: 'nyandeng@example.com',
        }),
      text('Please tap Confirm to hold your seat.'),
      () => toolCall('request_payment', { reference: pnr, method: 'mtn_momo', payer_phone: '+211912345678' }),
      text('Approve the MoMo prompt on your phone.'),
    ]);
    const { c } = testContainer({ llm });
    const app = createApp(c);
    const auth = { authorization: `Bearer ${await session(app)}` };

    const found = await request(app).post('/api/chat').set(auth).send({ message: 'Juba to Entebbe Friday' }).expect(200);
    expect(found.body.search.offers[0]).toMatchObject({ offerId, tags: expect.arrayContaining(['cheapest']) });
    const proposal = await request(app).post('/api/chat').set(auth).send({ message: 'Book it for Nyandeng Garang' }).expect(200);
    expect(proposal.body.pendingConfirmations).toHaveLength(1);
    expect((await request(app).get('/api/bookings').set(auth)).body.bookings).toHaveLength(0);

    const cid = proposal.body.pendingConfirmations[0].confirmationId;
    const confirmed = await request(app).post(`/api/confirmations/${cid}/confirm`).set(auth).expect(200);
    pnr = confirmed.body.booking.pnr;
    expect(confirmed.body.booking.status).toBe('held');

    // A second session cannot see or pay for this booking.
    const other = { authorization: `Bearer ${await session(app)}` };
    await request(app).get(`/api/bookings/${pnr}`).set(other).expect(404);

    const pay = await request(app).post('/api/chat').set(auth).send({ message: 'Pay with MTN MoMo' }).expect(200);
    expect(pay.body.reply).toContain('MoMo');
    expect((await request(app).get(`/api/bookings/${pnr}`).set(auth)).body.booking.status).toBe('payment_pending');

    const paid = await request(app).post(`/api/sandbox/bookings/${pnr}/payment`).set(auth).send({ outcome: 'succeeded' }).expect(200);
    expect(paid.body.booking.status).toBe('ticketed');
    expect(paid.body.booking.ticketNumbers[0]).toMatch(/^999\d{10}$/);
  });

  it('does not register sandbox endpoints unless enabled', async () => {
    const { c } = testContainer({}, { ENABLE_SANDBOX_ENDPOINTS: 'false' });
    const app = createApp(c);
    const token = await session(app);
    await request(app).post('/api/sandbox/bookings/ABCDEF/payment').set('authorization', `Bearer ${token}`).send({ outcome: 'succeeded' }).expect(404);
  });

  it('refuses to start in production with sandbox endpoints on', async () => {
    const { loadConfig } = await import('../src/config/env.js');
    expect(() => loadConfig({ NODE_ENV: 'production', PAYMENT_WEBHOOK_SECRET: 'x'.repeat(40), ENABLE_SANDBOX_ENDPOINTS: 'true' })).toThrow(/sandbox/i);
  });
});


describe('database outages', () => {
  it('answers 503 with Retry-After (not 500) when the store is unreachable', async () => {
    const { createMemoryRepositories } = await import('../src/repositories/memory.js');
    const repos = createMemoryRepositories();
    const outage = new Error('db down');
    repos.sessions.create = async () => {
      throw outage;
    };
    repos.isUnavailable = (err) => err === outage;
    const app = createApp(testContainer({ repositories: repos }).c);
    const res = await request(app).post('/api/sessions').expect(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('classifies a refused Postgres connection as unavailable', async () => {
    const { createDb } = await import('../src/repositories/prisma/client.js');
    const { isDatabaseUnavailable } = await import('../src/repositories/prisma/repositories.js');
    const { silentLogger } = await import('../src/lib/logger.js');
    const db = createDb({ url: 'postgresql://nobody@127.0.0.1:1/none', poolMax: 1 }, silentLogger);
    const err = await db.session.findFirst().then(
      () => undefined,
      (e: unknown) => e,
    );
    await db.$disconnect();
    expect(isDatabaseUnavailable(err)).toBe(true);
    expect(isDatabaseUnavailable(new Error('other'))).toBe(false);
  });
});
