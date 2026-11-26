// Wallet keys at rest: AES-256-GCM under the server's MASTER_KEY, bound to the user id (a ciphertext copied to
// another user's row does not decrypt). Passwords: scrypt with a random salt.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export class CryptoError extends Error {}

function masterKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new CryptoError('MASTER_KEY must be 64 hex characters (run: npm run genkey)');
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(secret: Uint8Array, userId: number, masterHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(masterHex), iv);
  cipher.setAAD(Buffer.from(`user:${userId}`));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(blob: string, userId: number, masterHex: string): Uint8Array {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new CryptoError('unknown key format');
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(masterHex), Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(`user:${userId}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]));
  } catch {
    throw new CryptoError('wallet key does not decrypt (wrong MASTER_KEY?)');
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${(await scryptAsync(password, salt)).toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = await scryptAsync(password, Buffer.from(salt, 'base64'));
  const want = Buffer.from(hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
