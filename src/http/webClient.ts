import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import express, { type Express } from 'express';

/**
 * Serves the browser client so that an update can never be mixed with files a
 * browser cached from an older version.
 *
 * Pages (index.html, desk.html) are sent with `no-cache` and their stylesheet
 * and script links are rewritten to `/v/<fingerprint>/…`. The fingerprint
 * changes whenever any client file changes, and relative module imports
 * resolve under the same prefix, so every file of a new version has a URL no
 * browser has seen before. Those versioned files are immutable and cached for
 * a year. Unversioned paths (`/app.js`) still work, revalidated on each load.
 */

const PAGES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/desk.html', 'desk.html'],
]);
const YEAR_SECONDS = 365 * 24 * 60 * 60;
// Fonts too: a preloaded font must have the same versioned URL the stylesheet asks for.
const ASSET_LINK = /\b(href|src)="\/([\w./-]+\.(?:css|js|woff2))"/g;

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
}

/** Fingerprint of every client file's path, size and modification time (cheap: no file reads). */
export async function clientFingerprint(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listFiles(dir)) {
    const s = await stat(file);
    hash.update(`${relative(dir, file)}\0${s.size}\0${s.mtimeMs}\n`);
  }
  return hash.digest('hex').slice(0, 12);
}

/** Points the page's absolute stylesheet and script links at the versioned prefix. */
export function versionAssetLinks(html: string, fingerprint: string): string {
  return html.replace(ASSET_LINK, (_m, attr: string, path: string) => `${attr}="/v/${fingerprint}/${path}"`);
}

/**
 * Link-preview tags (og:image, og:url) need absolute addresses: pages carry
 * `%PUBLIC_BASE_URL%`, replaced with the configured site address (escaped).
 */
export function fillSiteAddress(html: string, publicBaseUrl: string): string {
  const safe = publicBaseUrl.replace(/\/+$/, '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return html.replaceAll('%PUBLIC_BASE_URL%', safe);
}

export function webClientRoutes(app: Express, publicDir: string, publicBaseUrl = ''): void {
  // Recomputed per page load (a directory walk with stat calls), so files
  // replaced while the server runs are picked up without a restart.
  for (const [route, file] of PAGES) {
    app.get(route, async (_req, res, next) => {
      try {
        const [fingerprint, html] = await Promise.all([clientFingerprint(publicDir), readFile(join(publicDir, file), 'utf8')]);
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(fillSiteAddress(versionAssetLinks(html, fingerprint), publicBaseUrl));
      } catch (err) {
        next(err);
      }
    });
  }

  const versioned = express.static(publicDir, { index: false, etag: true });
  app.use('/v/:fingerprint', async (req, res, next) => {
    try {
      const current = await clientFingerprint(publicDir);
      // Only the current version may be cached long; a request from a page of
      // an older version gets today's file, revalidated, so nothing stale sticks.
      res.setHeader('Cache-Control', req.params.fingerprint === current ? `public, max-age=${YEAR_SECONDS}, immutable` : 'no-cache');
      versioned(req, res, next);
    } catch (err) {
      next(err);
    }
  });

  app.use(express.static(publicDir, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
}
