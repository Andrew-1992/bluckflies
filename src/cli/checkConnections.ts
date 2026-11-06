import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig, type AppConfig } from '../config/env.js';
import { runChecks, webhookUrls, type CheckResult, type CheckStatus, type MigrationState } from '../integrations/checks.js';

/**
 * `npm run connect:check` — tests every service configured in .env with
 * read-only calls and prints what works, what is off and how to fix the rest.
 * Exit code 1 when any check fails, so it can gate a deployment.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations', import.meta.url));

async function localMigrations(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function readMigrations(databaseUrl: string): Promise<MigrationState | null> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 8_000 });
  await client.connect();
  try {
    const exists = await client.query<{ t: string | null }>("select to_regclass('public._prisma_migrations')::text as t");
    if (!exists.rows[0]?.t) return null;
    const rows = await client.query<{ migration_name: string }>(
      'select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null',
    );
    return { applied: rows.rows.map((r) => r.migration_name) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

const ICON: Record<CheckStatus, string> = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', off: '[ -- ]' };

function print(config: AppConfig, results: CheckResult[]): void {
  const color = process.stdout.isTTY;
  const paint = (s: CheckStatus, text: string): string =>
    !color ? text : `\x1b[${{ ok: '32', warn: '33', fail: '31', off: '90' }[s]}m${text}\x1b[0m`;
  console.log(`\nBluckFlies connection check  (NODE_ENV=${config.NODE_ENV}, site ${config.PUBLIC_BASE_URL})\n`);
  for (const r of results) {
    console.log(`${paint(r.status, ICON[r.status])} ${r.service}: ${r.detail}`);
    if (r.fix && r.status !== 'ok') console.log(`         -> ${r.fix}`);
  }
  const hooks = webhookUrls(config);
  if (hooks.length > 0) {
    console.log('\nWebhook addresses to register with each provider:');
    for (const h of hooks) console.log(`  ${h.provider}\n    ${h.url}`);
  }
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  console.log(`\n${count('ok')} ok, ${count('warn')} warnings, ${count('fail')} failed, ${count('off')} not configured. Guide: docs/CONNECT.md\n`);
}

async function main(): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    // The same validation the server runs at start-up; the message names each bad setting.
    console.error(`\n[FAIL] .env: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const results = await runChecks(config, { fetch, timeoutMs: 15_000, now: new Date(), localMigrations: await localMigrations(), readMigrations });
  print(config, results);
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

process.exitCode = await main();
