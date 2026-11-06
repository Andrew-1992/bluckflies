import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (Node's built-in, memory-hard KDF), using an
 * OWASP-recommended parameter set (N=2^15, r=8, p=3, ~32 MiB). Argon2id would
 * need a native add-on on Node 22; scrypt avoids that while staying memory-hard.
 * Stored format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>, so parameters can be
 * raised later and old hashes still verify (see needsRehash).
 */

const PARAMS = { N: 2 ** 15, r: 8, p: 3 } as const;
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, KEY_LEN, { ...opts, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** True if a hash was made with weaker parameters than today's. */
export function needsRehash(stored: string): boolean {
  const [, n, r, p] = stored.split('$');
  return Number(n) < PARAMS.N || Number(r) < PARAMS.r || Number(p) < PARAMS.p;
}

/**
 * Minimum password policy for staff (NIST 800-63B style): length over
 * complexity rules, and no obvious choices.
 */
export function passwordProblem(password: string, context: { email: string; name: string }): string | undefined {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'Use at most 200 characters.';
  const lower = password.toLowerCase();
  if (lower.includes(context.email.split('@')[0]?.toLowerCase() ?? '\u0000') || lower.includes('bluckflies') || lower.includes('password')) {
    return 'Do not use your email, "password" or "bluckflies" in the password.';
  }
  if (/^(.)\1+$/.test(password) || /^(0123456789|1234567890|qwertyuiop|abcdefghij)/i.test(password)) return 'Choose a less predictable password.';
  return undefined;
}

/** A hash to verify against when the account does not exist, so timing does not reveal valid emails. */
export const DUMMY_HASH = `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEY_LEN).toString('base64')}`;
