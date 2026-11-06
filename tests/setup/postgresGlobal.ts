import { applyMigrations, dropDatabase, TEMPLATE_DB, TEST_DATABASE_URL, urlForDatabase, withAdmin } from './pgAdmin.js';

/** Builds the template database once per test run (Postgres mode only). */
export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (!TEST_DATABASE_URL) return;
  await withAdmin(async (admin) => {
    await dropDatabase(admin, TEMPLATE_DB);
    await admin.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  });
  await applyMigrations(urlForDatabase(TEMPLATE_DB));

  return async () => {
    await withAdmin((admin) => dropDatabase(admin, TEMPLATE_DB));
  };
}
