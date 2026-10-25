import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

/**
 * Local secret key for encrypting provider credentials and stream tokens at rest.
 * Generated once into data/secret.key (gitignored). Losing it means re-entering providers.
 */
function loadKey(): Buffer {
  const path = join(config.dataDir, 'secret.key');
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  return key;
}

const key = loadKey();

/** AES-256-GCM. Output: base64url(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function decrypt(token: string): string | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, out) => (err ? reject(err) : resolve(out))),
  );
}

/** scrypt hash with a random salt: "scrypt$N$r$p$salt$hash". Used for passwords and PINs. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await new Promise<Buffer>((resolve, reject) =>
    scrypt(secret, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
