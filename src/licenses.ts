// License keys: what a friend needs to sign up. Made by the owner on the admin page, shown once, stored only as a
// hash, redeemed by exactly one account. A key can carry its own platform fee.
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: keys get read out and typed

/** WM-XXXX-XXXX-XXXX-XXXX (80 random bits). */
export function newLicenseKey(): string {
  const bytes = randomBytes(16);
  let chars = '';
  for (let i = 0; i < 16; i++) chars += ALPHABET[bytes[i]! % 32];
  return `WM-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

/** Case and spacing do not matter when a friend types the key. */
export function licenseHash(key: string): string {
  return createHash('sha256').update(key.trim().toUpperCase().replace(/\s+/g, '')).digest('hex');
}
