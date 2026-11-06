import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from '../src/config/env.js';

/**
 * Deployment files must keep up with the settings the app reads. A setting
 * missing from docker-compose.yml is silently ignored in a Compose deployment
 * (this happened: bank transfer, cash offices, DPO and ops alerts were missing).
 */
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const appEnvironment = (): string => {
  const compose = read('docker-compose.yml');
  const app = compose.slice(compose.indexOf('\n  app:\n'));
  return app.slice(app.indexOf('    environment:\n'), app.indexOf('    depends_on:\n'));
};

describe('deployment configuration', () => {
  it('passes every app setting to the app container in docker-compose.yml', () => {
    const env = appEnvironment();
    expect(CONFIG_KEYS.filter((k) => !new RegExp(`^      ${k}:`, 'm').test(env))).toEqual([]);
  });

  it('never gives the app container the database admin or schema-owner passwords', () => {
    const env = appEnvironment();
    expect(env).not.toMatch(/POSTGRES_PASSWORD|BLUCKFLIES_OWNER_PASSWORD|MIGRATION_DATABASE_URL/);
    expect(env).toMatch(/DATABASE_URL: postgresql:\/\/bluckflies_app:/);
  });

  it('documents every setting in .env.example', () => {
    const example = read('.env.example');
    expect(CONFIG_KEYS.filter((k) => !new RegExp(`^#?\\s*${k}=`, 'm').test(example))).toEqual([]);
  });

  it('ships the legal page texts in the production image', () => {
    expect(read('Dockerfile')).toMatch(/^COPY --chown=node:node legal \.\/legal$/m);
  });
});
