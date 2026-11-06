import type { Express } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config/env.js';

/**
 * Terms, Privacy and Refunds pages.
 *
 * The texts live in /legal/*.html as plain HTML fragments, so a lawyer can
 * review and edit them without touching code. Company details come from
 * configuration and are HTML-escaped; anything not configured shows as a
 * visible "[to be completed: …]" marker. Until LEGAL_PAGES_APPROVED=true
 * every page carries a "draft" banner.
 */

export const LEGAL_DIR = fileURLToPath(new URL('../../legal', import.meta.url));

export const LEGAL_PAGES = {
  '/terms': { file: 'terms.html', title: 'Terms of service' },
  '/privacy': { file: 'privacy.html', title: 'Privacy notice' },
  '/refunds': { file: 'refunds.html', title: 'Cancellations and refunds' },
} as const;

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function legalValues(c: AppConfig): Record<string, string> {
  const todo = (what: string) => `[to be completed: ${what}]`;
  return {
    company: c.LEGAL_COMPANY_NAME ?? todo('company legal name'),
    address: c.LEGAL_COMPANY_ADDRESS ?? todo('registered address'),
    registration: c.LEGAL_COMPANY_REGISTRATION ?? todo('company registration number'),
    email: c.SUPPORT_EMAIL ?? todo('support email'),
    phone: c.SUPPORT_PHONE ?? todo('support phone'),
    site: c.PUBLIC_BASE_URL,
    retentionDays: String(c.DATA_RETENTION_DAYS),
    holdMinutes: String(c.HOLD_TTL_MINUTES),
  };
}

/**
 * Removes reviewer comments (<!-- … -->), then replaces {{name}} with escaped
 * values; an unknown name is a template error, not silent blank text.
 */
export function fillTemplate(fragment: string, values: Record<string, string>): string {
  return fragment.replace(/<!--[\s\S]*?-->\s*/g, '').replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`Legal page uses unknown placeholder {{${name}}}`);
    return escapeHtml(v);
  });
}

export function legalPage(title: string, body: string, approved: boolean): string {
  const nav = Object.entries(LEGAL_PAGES)
    .map(([path, p]) => `<a href="${path}"${p.title === title ? ' aria-current="page"' : ''}>${p.title}</a>`)
    .join(' · ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · BluckFlies</title>
<style>
  :root { --ink: #111c3f; --muted: #4f5b80; --line: #e3e8f6; --blue: #2457e6; --warn-bg: #fff4e5; --warn: #8a4b00; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e8ecf8; --muted: #a9b3d1; --line: #2a3352; --blue: #8fa9ff; --warn-bg: #3a2a10; --warn: #ffcf8a; } body { background: #0e1426; } }
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
  header a.home { font-weight: 800; font-size: 20px; color: var(--blue); text-decoration: none; }
  nav a { color: var(--muted); } nav a[aria-current] { color: var(--ink); font-weight: 650; }
  h1 { font-size: 28px; line-height: 1.25; margin: 24px 0 8px; } h2 { font-size: 20px; margin: 32px 0 8px; }
  a { color: var(--blue); } li { margin: 4px 0; } .updated { color: var(--muted); }
  .draft { background: var(--warn-bg); color: var(--warn); border-radius: 10px; padding: 12px 14px; margin-top: 16px; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: 15px; } th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 8px 6px; vertical-align: top; }
  .table-wrap { overflow-x: auto; }
</style>
</head>
<body>
<main>
<header><a class="home" href="/">BluckFlies</a><nav aria-label="Legal pages">${nav}</nav></header>
${approved ? '' : '<p class="draft" role="note">Draft for legal review. This page is not yet final and may change before BluckFlies launches.</p>'}
${body}
</main>
</body>
</html>`;
}

export function legalRoutes(app: Express, config: AppConfig): void {
  const values = legalValues(config);
  for (const [path, page] of Object.entries(LEGAL_PAGES)) {
    app.get(path, async (_req, res, next) => {
      try {
        const fragment = await readFile(join(LEGAL_DIR, page.file), 'utf8');
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(legalPage(page.title, fillTemplate(fragment, values), config.LEGAL_PAGES_APPROVED));
      } catch (err) {
        next(err);
      }
    });
  }
}
