import type { Logger } from './logger.js';

/**
 * A logger that also hands error events to an alert sink. Services keep
 * logging as before; which events page a person is decided in one place
 * (AlertService rules). The sink is attached after the container is built,
 * and it must never throw into the code that logged.
 */
export interface AlertingLogger extends Logger {
  attach(sink: (event: string, ctx: Record<string, unknown>) => void): void;
}

export function createAlertingLogger(base: Logger): AlertingLogger {
  let sink: ((event: string, ctx: Record<string, unknown>) => void) | undefined;
  return {
    debug: (m, c) => base.debug(m, c),
    info: (m, c) => base.info(m, c),
    warn: (m, c) => base.warn(m, c),
    error: (m, c) => {
      base.error(m, c);
      try {
        sink?.(m, c ?? {});
      } catch {
        // alerting is best effort; never break the caller
      }
    },
    attach: (s) => {
      sink = s;
    },
  };
}
