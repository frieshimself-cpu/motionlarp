import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword, CryptoError } from '../src/crypto.js';

const KEY = 'ab'.repeat(32);
describe('wallet key encryption', () => {
  const secret = new Uint8Array(64).map((_, i) => i);
  it('round-trips for the same user', () => {
    expect(decryptSecret(encryptSecret(secret, 7, KEY), 7, KEY)).toEqual(secret);
  });
  it('does not decrypt for another user or another master key', () => {
    const blob = encryptSecret(secret, 7, KEY);
    expect(() => decryptSecret(blob, 8, KEY)).toThrow(CryptoError);
    expect(() => decryptSecret(blob, 7, 'cd'.repeat(32))).toThrow(CryptoError);
  });
  it('never stores the key in plain text', () => {
    expect(encryptSecret(secret, 7, KEY)).not.toContain(Buffer.from(secret).toString('base64'));
  });
  it('refuses a malformed master key', () => {
    expect(() => encryptSecret(secret, 1, 'short')).toThrow(/64 hex/);
  });
});
describe('passwords', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('hunter22');
    expect(await verifyPassword('hunter22', h)).toBe(true);
    expect(await verifyPassword('hunter23', h)).toBe(false);
  });
});
