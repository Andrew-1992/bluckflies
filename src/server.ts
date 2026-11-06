import { loadConfig } from './config/env.js';
import { buildContainer } from './container.js';
import { createApp } from './http/app.js';
import { createLogger } from './lib/logger.js';

const config = loadConfig();
const log = createLogger(config.NODE_ENV === 'production' ? 'info' : 'debug');
const container = buildContainer(config, log);
const app = createApp(container);

if (container.storage === 'memory') {
  log.warn('storage.memory', { msg: 'DATABASE_URL not set: all data is lost on restart. Development only.' });
}

// Fail fast if the database is unreachable or has not been migrated.
try {
  await container.repos.ping();
} catch (err) {
  log.error('db.not_ready_at_startup', { err: err instanceof Error ? err.message : String(err) });
  await container.repos.close().catch(() => undefined);
  process.exit(1);
}

const server = app.listen(config.PORT, () => {
  log.info('server.started', {
    port: config.PORT,
    storage: container.storage,
    agent: container.agentMode,
    jobs: config.JOBS_ENABLED,
    sandbox: config.ENABLE_SANDBOX_ENDPOINTS,
  });
});
if (config.JOBS_ENABLED) container.scheduler.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('server.stopping', { signal });
  // Force exit if draining takes too long (container runtimes send SIGKILL soon after).
  setTimeout(() => process.exit(1), 15_000).unref();

  // 1. Stop accepting connections and let in-flight requests finish.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // 2. Let running jobs finish and release their leases so another instance can take over.
  await container.scheduler.stop();
  // 3. Close the database pool last; requests and jobs above may still need it.
  await container.repos.close();
  log.info('server.stopped', {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
