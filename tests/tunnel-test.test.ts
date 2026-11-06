// Testing from a PC before the Anthropic key exists: the scripted demo
// assistant, the origin secret that keeps the tunnel private to the Vercel
// proxy, and the static build of the web client for Vercel.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { dateIn, DemoLlmClient, placesIn } from '../src/agent/demoLlm.js';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/http/app.js';
import { SECURITY_HEADERS as SERVER_HEADERS } from '../src/http/middleware.js';
import { buildWeb, parseArgs, SERVER_PATHS, vercelConfig } from '../src/http/staticSite.js';
import { FixedClock, testContainer } from './helpers.js';

const SECRET = 'origin-secret-for-tests-0123456789abcdef';
const today = new Date('2026-11-06T09:00:00Z');

describe('demo assistant (testing without an Anthropic key)', () => {
  it('finds the places a traveller names, in order, in English or Arabic, whole words only', () => {
    expect(placesIn('Juba to Nairobi on 20 November').map((a) => a.iata)).toEqual(['JUB', 'NBO']);
    expect(placesIn('from NBO to juba please').map((a) => a.iata)).toEqual(['NBO', 'JUB']);
    expect(placesIn('من جوبا إلى نيروبي').map((a) => a.iata)).toEqual(['JUB', 'NBO']);
    expect(placesIn('I want to go today')).toEqual([]);
  });

  it('reads the travel date, and moves a date already past to next year', () => {
    expect(dateIn('on 20 November', today)).toBe('2026-11-20');
    expect(dateIn('November 21st', today)).toBe('2026-11-21');
    expect(dateIn('2026-12-01', today)).toBe('2026-12-01');
    expect(dateIn('tomorrow', today)).toBe('2026-11-07');
    expect(dateIn('غداً', today)).toBe('2026-11-07');
    expect(dateIn('on 3 March', today)).toBe('2027-03-03');
    expect(dateIn('some day', today)).toBe('2026-11-13');
  });

  it('searches with the real tool, streams its answer, and says it is the demo', async () => {
    const app = createApp(testContainer({ llm: new DemoLlmClient(new FixedClock(today), 0) }).c);
    const token = (await request(app).post('/api/sessions').expect(201)).body.token as string;
    const res = await request(app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'Juba to Nairobi on 20 November' }).expect(200);
    expect(res.body.reply).toMatch(/^\(Demo assistant, not AI\.\) I found \d+ flights? from Juba to Nairobi on Friday 20 November\. The cheapest is USD/);
    expect(res.body.search.offers.length).toBeGreaterThan(0);

    const help = await request(app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'hello' }).expect(200);
    expect(help.body.reply).toMatch(/Demo assistant.*Try: "Juba to Nairobi/);
  });

  it('passes "talk to a person" to the support desk, and answers in Arabic when written to in Arabic', async () => {
    const { c } = testContainer({ llm: new DemoLlmClient(new FixedClock(new Date('2026-10-30T10:00:00Z')), 0) });
    const app = createApp(c);
    const token = (await request(app).post('/api/sessions').expect(201)).body.token as string;
    const res = await request(app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'I want to talk to a person' }).expect(200);
    expect(res.body.reply).toMatch(/passed your request to the BluckFlies team/);
    expect(await c.support.list('open')).toHaveLength(1);
    const ar = await request(app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'مرحبا' }).expect(200);
    expect(ar.body.reply).toMatch(/^\(مساعد تجريبي/);
  });

  it('is switched on by AGENT_DEMO only without a real key, and refused in production', () => {
    expect(testContainer({}, { AGENT_DEMO: 'true' }).c.agentMode).toBe('demo');
    expect(testContainer({}, { AGENT_DEMO: 'true', ANTHROPIC_API_KEY: 'sk-ant-test' }).c.agentMode).toBe('anthropic');
    expect(testContainer().c.agentMode).toBe('unconfigured');
    expect(() =>
      loadConfig({ NODE_ENV: 'production', AGENT_DEMO: 'true', PAYMENT_WEBHOOK_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://a.example' }),
    ).toThrow(/AGENT_DEMO must be false in production/);
  });
});

describe('origin secret (server reachable only through the Vercel proxy)', () => {
  it('refuses requests without the secret, except health checks', async () => {
    const app = createApp(testContainer({}, { ORIGIN_SECRET: SECRET }).c);
    expect((await request(app).post('/api/sessions').expect(403)).text).toBe('Forbidden');
    await request(app).get('/').expect(403);
    await request(app).post('/api/sessions').set('x-origin-secret', `${SECRET}x`).expect(403);
    await request(app).get('/healthz').expect(200);
    const ok = await request(app).post('/api/sessions').set('x-origin-secret', SECRET).expect(201);
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('needs at least 32 characters', () => {
    expect(() => loadConfig({ PAYMENT_WEBHOOK_SECRET: 'x'.repeat(40), ORIGIN_SECRET: 'short' })).toThrow(/ORIGIN_SECRET must be at least 32/);
  });
});

describe('static web build for Vercel', () => {
  it('accepts only an https origin for the server', () => {
    expect(parseArgs(['--api', 'https://abc.ngrok-free.app/']).api).toBe('https://abc.ngrok-free.app');
    expect(() => parseArgs([])).toThrow(/Missing --api/);
    expect(() => parseArgs(['--api', 'http://abc.ngrok-free.app'])).toThrow(/https/);
    expect(() => parseArgs(['--api', 'https://abc.ngrok-free.app/api'])).toThrow(/just the origin/);
  });

  it('forwards the server paths with the origin secret and keeps the server security headers', () => {
    const cfg = vercelConfig('https://abc.ngrok-free.app') as { routes: Array<Record<string, unknown>> };
    const proxy = cfg.routes.find((r) => r['src'] === SERVER_PATHS);
    expect(proxy?.['dest']).toBe('https://abc.ngrok-free.app/$1');
    expect(JSON.stringify(proxy?.['transforms'])).toContain('"key":"x-origin-secret"');
    expect(JSON.stringify(proxy?.['transforms'])).toContain('"args":"$ORIGIN_SECRET"');
    const headers = cfg.routes[0]?.['headers'] as Record<string, string>;
    for (const [k, v] of Object.entries(SERVER_HEADERS)) expect(headers[k]).toBe(v);
    // Static files are served last, after the forwarded paths.
    expect(cfg.routes.at(-1)).toEqual({ handle: 'filesystem' });
    for (const path of ['/api/chat/stream', '/e/abc', '/terms', '/privacy', '/refunds']) expect(new RegExp(`^${SERVER_PATHS}$`).test(path)).toBe(true);
    for (const path of ['/', '/index.html', '/v/abc/app.js', '/brand/og.png']) expect(new RegExp(`^${SERVER_PATHS}$`).test(path)).toBe(false);
  });

  it('writes versioned pages, the files under /v/<version>/, and vercel.json', async () => {
    const out = await mkdtemp(join(tmpdir(), 'bf-web-'));
    try {
      await mkdir(join(out, '.vercel'), { recursive: true });
      await writeFile(join(out, '.vercel', 'project.json'), '{"projectId":"prj_1"}');
      await writeFile(join(out, 'stale.js'), 'old build');
      const { fingerprint } = await buildWeb(['--api', 'https://abc.ngrok-free.app', '--site', 'https://bf.vercel.app'], out);
      // The Vercel project link survives a rebuild; files from an older build do not.
      expect(await readFile(join(out, '.vercel', 'project.json'), 'utf8')).toContain('prj_1');
      await expect(readFile(join(out, 'stale.js'))).rejects.toThrow();
      const index = await readFile(join(out, 'index.html'), 'utf8');
      expect(index).toContain(`href="/v/${fingerprint}/styles.css"`);
      expect(index).toContain('content="https://bf.vercel.app/brand/og.png"');
      expect(index).not.toContain('%PUBLIC_BASE_URL%');
      await readFile(join(out, 'v', fingerprint, 'app.js'));
      expect(JSON.parse(await readFile(join(out, 'vercel.json'), 'utf8')).routes).toHaveLength(5);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
