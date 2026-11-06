import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30-second steps,
 * 6 digits), as used by Google Authenticator, Microsoft Authenticator, Authy.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 encoded (the form authenticator apps accept). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin = ((mac[offset] ?? 0) & 0x7f) * 2 ** 24 + (mac[offset + 1] ?? 0) * 2 ** 16 + (mac[offset + 2] ?? 0) * 2 ** 8 + (mac[offset + 3] ?? 0);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const totpStep = (at: Date): number => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matching step, so the caller can refuse a replay.
 */
export function verifyTotp(secret: string, code: string, at: Date): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const now = totpStep(at);
  for (const step of [now, now - 1, now + 1]) {
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return undefined;
}

/** otpauth:// link that authenticator apps import (also shown as text to type in). */
export function otpauthUri(secret: string, account: string, issuer = 'BluckFlies'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
