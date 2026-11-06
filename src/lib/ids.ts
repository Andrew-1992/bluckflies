import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`;

/** Six-character record locator without ambiguous characters (0/O, 1/I). */
export function newPnr(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** High-entropy bearer token for anonymous traveller sessions. */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

/** Tokens are stored only as SHA-256 hashes so a data leak does not leak sessions. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}
