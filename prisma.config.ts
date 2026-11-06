import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma ORM 7). The CLI no longer reads `.env`
 * itself, so load it explicitly for local commands; deployed environments
 * provide real environment variables.
 */
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the process environment.
}

/** Blank values (`KEY=` in .env) count as unset, matching the app's config loader. */
const env = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

const shadowDatabaseUrl = env('SHADOW_DATABASE_URL');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Migrations run with the schema-owner role (see README: Database roles).
    url: env('MIGRATION_DATABASE_URL') ?? env('DATABASE_URL') ?? '',
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
