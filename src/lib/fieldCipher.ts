import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-level encryption for sensitive columns (passport numbers,
 * phone numbers, chat transcripts) using AES-256-GCM from Node's crypto.
 *
 * Format: `<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts).
 * - Keyring: the first key encrypts; every key can decrypt, so keys rotate
 *   without rewriting data immediately.
 * - Associated data binds each ciphertext to its table/row/column, so a
 *   value copied into another row fails authentication instead of decrypting.
 */
export interface FieldCipher {
  encrypt(plaintext: string, aad: string): string;
  decrypt(ciphertext: string, aad: string): string;
}

const KEY_ID = /^[a-z0-9]{1,16}$/;

export function parseKeyring(spec: string): Map<string, Buffer> {
  const ring = new Map<string, Buffer>();
  for (const entry of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    const id = entry.slice(0, idx);
    const key = Buffer.from(entry.slice(idx + 1), 'base64');
    if (idx < 1 || !KEY_ID.test(id)) throw new Error('DATA_ENCRYPTION_KEYS: each entry must be "<id>:<base64 key>"');
    if (key.length !== 32) throw new Error(`DATA_ENCRYPTION_KEYS: key "${id}" must decode to 32 bytes`);
    if (ring.has(id)) throw new Error(`DATA_ENCRYPTION_KEYS: duplicate key id "${id}"`);
    ring.set(id, key);
  }
  if (ring.size === 0) throw new Error('DATA_ENCRYPTION_KEYS: at least one key is required');
  return ring;
}

export class AesGcmFieldCipher implements FieldCipher {
  private readonly activeId: string;

  constructor(private readonly ring: Map<string, Buffer>) {
    const first = ring.keys().next();
    if (first.done) throw new Error('Empty keyring');
    this.activeId = first.value;
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.ring.get(this.activeId);
    if (!key) throw new Error('Active key missing');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [this.activeId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(value: string, aad: string): string {
    const [id, iv, tag, ct] = value.split('.');
    const key = id ? this.ring.get(id) : undefined;
    if (!key || !iv || !tag || ct === undefined) throw new Error('Undecryptable field: unknown key or malformed value');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
