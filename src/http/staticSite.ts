/**
 * The web client as a static site for Vercel, with everything dynamic
 * forwarded to a BluckFlies server elsewhere (for a test: this PC through an
 * ngrok tunnel). See docs/TUNNEL-TEST.md.
 *
 *   npm run build:web -- --api https://<name>.ngrok-free.app [--site https://<project>.vercel.app]
 *
 * Output: web-dist/ with
 *   - index.html and desk.html, their links pointing at /v/<fingerprint>/…
 *     (same scheme as the server: a new build never mixes with cached files);
 *   - every public file under /v/<fingerprint>/ (cached for a year) and at its
 *     plain path (icons, manifest);
 *   - vercel.json: security headers like the server's, and routes that send
 *     /api, the e-ticket links and the legal pages to --api, adding the
 *     ORIGIN_SECRET header (a Vercel environment variable) to each request.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN_SECRET_HEADER, SECURITY_HEADERS as SERVER_HEADERS } from './middleware.js';
import { fillSiteAddress, versionAssetLinks } from './webClient.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const OUT_DIR = join(ROOT, 'web-dist');
const PAGES = ['index.html', 'desk.html'];

/** Paths the BluckFlies server answers (everything else is a static file). */
export const SERVER_PATHS = '/(api/.*|e/.*|terms|privacy|refunds|healthz|readyz)';

/** The server's security headers, plus HSTS (Vercel serves HTTPS only). */
export const SECURITY_HEADERS: Record<string, string> = {
  ...SERVER_HEADERS,
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

export function parseArgs(argv: string[]): { api: string; site: string } {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const api = value('--api');
  if (!api) throw new Error('Missing --api https://<name>.ngrok-free.app (the address of the BluckFlies server)');
  const url = new URL(api);
  if (url.protocol !== 'https:') throw new Error('--api must be an https:// address');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('--api must be just the origin, e.g. https://name.ngrok-free.app');
  const site = value('--site') ?? '';
  if (site && new URL(site).protocol !== 'https:') throw new Error('--site must be an https:// address');
  return { api: url.origin, site: site.replace(/\/+$/, '') };
}

/** Vercel configuration: headers for everything, the server's paths forwarded with the origin secret. */
export function vercelConfig(api: string): Record<string, unknown> {
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    routes: [
      { src: '/(.*)', headers: SECURITY_HEADERS, continue: true },
      { src: '/v/(.*)', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
      { src: '/(|index\\.html|desk\\.html)', headers: { 'Cache-Control': 'no-cache' }, continue: true },
      {
        src: SERVER_PATHS,
        dest: `${api}/$1`,
        // Answers are per traveller: never cached by Vercel's CDN.
        headers: { 'x-vercel-enable-rewrite-caching': '0' },
        transforms: [
          // Proves to the server that the request came through this proxy (ORIGIN_SECRET on both sides).
          { type: 'request.headers', op: 'set', target: { key: ORIGIN_SECRET_HEADER }, args: '$ORIGIN_SECRET', env: ['ORIGIN_SECRET'] },
          // ngrok's free plan otherwise answers browser requests with its own warning page.
          { type: 'request.headers', op: 'set', target: { key: 'ngrok-skip-browser-warning' }, args: '1' },
        ],
      },
      { handle: 'filesystem' },
    ],
  };
}

async function contentFingerprint(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${relative(dir, file)}\0`).update(await readFile(file)).update('\n');
  return hash.digest('hex').slice(0, 12);
}

export async function buildWeb(argv: string[], outDir = OUT_DIR): Promise<{ outDir: string; fingerprint: string; api: string }> {
  const { api, site } = parseArgs(argv);
  const fingerprint = await contentFingerprint(PUBLIC_DIR);
  // Start clean, but keep .vercel/ (the link to the Vercel project made by `vercel link`).
  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir)) {
    if (entry !== '.vercel') await rm(join(outDir, entry), { recursive: true, force: true });
  }
  await cp(PUBLIC_DIR, outDir, { recursive: true });
  await cp(PUBLIC_DIR, join(outDir, 'v', fingerprint), { recursive: true });
  for (const page of PAGES) {
    const html = await readFile(join(PUBLIC_DIR, page), 'utf8');
    await writeFile(join(outDir, page), fillSiteAddress(versionAssetLinks(html, fingerprint), site));
  }
  await writeFile(join(outDir, 'vercel.json'), `${JSON.stringify(vercelConfig(api), null, 2)}\n`);
  return { outDir, fingerprint, api };
}

