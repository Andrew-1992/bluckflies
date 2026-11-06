import type { Db } from '../../src/repositories/prisma/client.js';
import type { Repositories } from '../../src/repositories/types.js';

export interface TestDb {
  url: string;
  keyring: string;
  db: Db;
  repos: Repositories;
}

let current: TestDb | undefined;

export function setTestDb(t: TestDb | undefined): void {
  current = t;
}

/** The current file's Postgres database, or undefined when running in memory mode. */
export function testDb(): TestDb | undefined {
  return current;
}

export const storageMode = (): 'postgres' | 'memory' => (process.env['TEST_DATABASE_URL'] ? 'postgres' : 'memory');
