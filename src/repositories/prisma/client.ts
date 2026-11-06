import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { Logger } from '../../lib/logger.js';

export type Db = InstanceType<typeof PrismaClient>;

export interface DbOptions {
  url: string;
  poolMax: number;
}

/**
 * Prisma ORM 7 client over node-postgres via the official driver adapter.
 * Timeouts are bounded so a slow database surfaces as an error instead of
 * piling up requests.
 */
export function createDb(opts: DbOptions, log: Logger): Db {
  const adapter = new PrismaPg(
    {
      connectionString: opts.url,
      max: opts.poolMax,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      application_name: 'bluckflies',
    },
    {
      onPoolError: (err) => log.error('db.pool_error', { err: err.message }),
      onConnectionError: (err) => log.error('db.connection_error', { err: err.message }),
    },
  );
  return new PrismaClient({ adapter });
}
