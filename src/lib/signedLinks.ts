import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring links for things a traveller opens outside their session
 * (an e-ticket link in an email, opened on another phone or at an internet
 * café). Token: <id>.<expiry seconds>.<HMAC-SHA256(secret, purpose|id|expiry)>.
 * The purpose keeps a token for one use from being valid for another.
 */

const ID = /^[A-Za-z0-9_-]{1,80}$/;

function mac(secret: string, purpose: string, id: string, exp: number): string {
  return createHmac('sha256', secret).update(`bluckflies:link:${purpose}|${id}|${exp}`).digest('base64url');
}

export function signLink(secret: string, purpose: string, id: string, expiresAt: Date): string {
  if (!ID.test(id)) throw new Error('Invalid id for a signed link');
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${id}.${exp}.${mac(secret, purpose, id, exp)}`;
}

/** Returns the id when the token is genuine, for this purpose, and not expired. */
export function verifyLink(secret: string, purpose: string, token: string, now: Date): string | undefined {
  const [id, expRaw, sig, extra] = token.split('.');
  if (!id || !expRaw || !sig || extra !== undefined || !ID.test(id) || !/^\d{1,12}$/.test(expRaw)) return undefined;
  const exp = Number(expRaw);
  const expected = Buffer.from(mac(secret, purpose, id, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  return exp * 1000 > now.getTime() ? id : undefined;
}
