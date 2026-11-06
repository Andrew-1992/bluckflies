import { createHmac } from 'node:crypto';

/** E.164: "+" then 8–15 digits, no leading zero. */
export const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalises user input like "0912 345 678" or "+211 912-345-678" to E.164.
 * Numbers without a country code are taken as South Sudanese (+211).
 * Returns undefined when the result is not a plausible E.164 number.
 */
export function normalizePhone(input: string): string | undefined {
  const raw = input.trim().replace(/[\s().-]/g, '');
  let n = raw;
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  else if (!n.startsWith('+')) n = `+211${n.replace(/^0/, '')}`;
  return E164.test(n) ? n : undefined;
}

export function maskPhone(phone: string): string {
  return phone.length <= 7 ? '****' : `${phone.slice(0, 4)}****${phone.slice(-3)}`;
}

/**
 * Keyed hash used to look phone numbers up without storing them in clear.
 * The purpose label keeps hashes for different uses unlinkable.
 */
export function keyedHash(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`bluckflies:${purpose}:${value}`).digest('hex');
}
