import { AppError } from '../domain/errors.js';

/** Bounds a call to an external dependency and converts failures to a safe error. */
export async function withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError('UPSTREAM_UNAVAILABLE', `${label} is taking too long. Please try again shortly.`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
