import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

/** Server-level URL for tests, e.g. postgresql://postgres@127.0.0.1:5432/postgres */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
export const TEMPLATE_DB = 'bluckflies_test_template';

const IDENT = /^[a-z0-9_]+$/;

export function urlForDatabase(name: string): string {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL not set');
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  if (!IDENT.test(name)) throw new Error(`Unsafe database name ${name}`);
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

export async function createDatabaseFromTemplate(admin: pg.Client, name: string): Promise<void> {
  if (!IDENT.test(name)) throw new Error(`Unsafe database name ${name}`);
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`);
}

/** Applies every migration.sql in order, exactly as `prisma migrate deploy` would run them. */
export async function applyMigrations(databaseUrl: string): Promise<string[]> {
  const dir = join(process.cwd(), 'prisma', 'migrations');
  const migrations = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const m of migrations) {
      const sql = await readFile(join(dir, m, 'migration.sql'), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
  return migrations;
}
