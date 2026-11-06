import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { loadConfig } from '../config/env.js';
import { buildContainer } from '../container.js';
import { createLogger } from '../lib/logger.js';

/**
 * `npm run staff:create-admin` — creates a support-desk admin account directly
 * in the database (for the first admin, or when every admin is locked out).
 * The password is typed without being shown and never appears in shell history.
 */

let muted = false;
const output = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});
// One reader with a line queue: piped input (several lines at once) and typing both work.
const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string, hidden = false): Promise<string> {
  process.stdout.write(question);
  muted = hidden; // hide the typed characters of a password
  const next = await lines.next();
  muted = false;
  if (hidden || !process.stdin.isTTY) process.stdout.write('\n');
  if (next.done) throw new Error('Input ended before all questions were answered.');
  return String(next.value).trim();
}

async function main(): Promise<number> {
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    console.error('DATABASE_URL is not set: accounts would be lost when this command ends. Run it against your real database.');
    return 1;
  }
  const c = buildContainer(config, createLogger('warn'));
  try {
    const email = await ask('Email: ');
    const name = await ask('Name (shown on everything they do): ');
    const password = await ask('Password (12+ characters, not shown): ', true);
    if (password !== (await ask('Repeat password: ', true))) {
      console.error('The passwords do not match.');
      return 1;
    }
    const staff = await c.staff.create('command line', { email, name, role: 'admin', password });
    console.log(`Admin ${staff.name} <${staff.email}> created. Sign in at ${config.PUBLIC_BASE_URL}/desk.html${c.config.STAFF_REQUIRE_2FA !== 'false' && config.NODE_ENV === 'production' ? ' and set up two-step login' : ''}.`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    rl.close();
    await c.repos.close().catch(() => undefined);
  }
}

process.exitCode = await main();
