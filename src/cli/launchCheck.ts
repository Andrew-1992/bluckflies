/**
 * npm run launch:check -- https://bluckflies.com
 *
 * Read-only checks of a running BluckFlies site from the outside (src/launch/liveChecks.ts):
 * HTTPS, security headers, legal pages, locked admin and webhook doors, sandbox
 * switched off, real flights, payment methods. Exits 1 if anything fails.
 */
import { defaultDeps, runLiveChecks, type Status } from '../launch/liveChecks.js';

const ICON: Record<Status, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };

async function main(): Promise<number> {
  const target = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!target || !/^https?:\/\/[^/]+/.test(target)) {
    console.error('Usage: npm run launch:check -- https://your-domain');
    return 2;
  }
  console.log(`BluckFlies launch check: ${target}\n`);
  const results = await runLiveChecks(target, defaultDeps());
  for (const r of results) {
    console.log(`${ICON[r.status]}  ${r.area.padEnd(22)} ${r.detail}`);
    if (r.fix && r.status !== 'ok') console.log(`${' '.repeat(28)}→ ${r.fix}`);
  }
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log(`\n${fails} failed, ${warns} warning(s). ${fails ? 'Fix the failures before taking real payments.' : 'Ready for the real-money tests (docs/LAUNCH.md section 3).'}`);
  return fails ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
