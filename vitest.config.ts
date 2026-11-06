import { defineConfig } from 'vitest/config';

/**
 * `npm test` runs everything against the in-memory store.
 * `npm run test:pg` (TEST_DATABASE_URL set) runs the same suites against
 * PostgreSQL: the global setup builds a template database from the real
 * migrations, and each test file gets its own copy.
 */
export default defineConfig({
  test: {
    globalSetup: ['tests/setup/postgresGlobal.ts'],
    setupFiles: ['tests/setup/postgresPerFile.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
