import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { silentLogger } from '../../src/lib/logger.js';
import { AesGcmFieldCipher, parseKeyring } from '../../src/lib/fieldCipher.js';
import { createDb, type Db } from '../../src/repositories/prisma/client.js';
import { createPrismaRepositories } from '../../src/repositories/prisma/repositories.js';
import { createDatabaseFromTemplate, dropDatabase, TEST_DATABASE_URL, urlForDatabase, withAdmin } from './pgAdmin.js';
import { setTestDb } from '../support/testDb.js';

/**
 * Session IDs the service-level tests use without going through the HTTP
 * session endpoint. Postgres enforces the foreign keys the memory store
 * doesn't, so these rows exist before every test.
 */
export const FIXTURE_SESSION_IDS = ['ses_owner', 'ses_card', 'ses_a', 'ses_b', 'ses_1', 'ses_other', 'ses_intruder', 's'];

if (TEST_DATABASE_URL) {
  const name = `bluckflies_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const keyring = `t1:${randomBytes(32).toString('base64')}`;
  let db: Db | undefined;

  beforeAll(async () => {
    await withAdmin((admin) => createDatabaseFromTemplate(admin, name));
    const url = urlForDatabase(name);
    db = createDb({ url, poolMax: 5 }, silentLogger);
    setTestDb({ url, keyring, db, repos: createPrismaRepositories(db, new AesGcmFieldCipher(parseKeyring(keyring))) });
  });

  beforeEach(async () => {
    if (!db) return;
    // Every application table, discovered rather than listed, so new tables can never leak state between tests.
    const tables = await db.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    const names = tables.map((t) => `"${t.tablename.replaceAll('"', '""')}"`).join(', ');
    if (names) await db.$executeRawUnsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    await db.session.createMany({ data: FIXTURE_SESSION_IDS.map((id) => ({ id, tokenHash: id.padEnd(64, '0').slice(0, 64) })) });
  });

  afterAll(async () => {
    await db?.$disconnect();
    setTestDb(undefined);
    await withAdmin((admin) => dropDatabase(admin, name));
  });
}
