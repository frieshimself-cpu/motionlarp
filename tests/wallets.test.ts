import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { parseSecretKey, WalletKeyError } from '../src/wallets.js';
import { redact, scrubText, REDACTED } from '../src/log.js';

describe('parseSecretKey', () => {
  const kp = Keypair.generate();
  it('reads a base58 key', () => {
    expect(parseSecretKey(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('reads a JSON byte array', () => {
    expect(parseSecretKey(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('refuses a public key, junk and a bad array', () => {
    expect(() => parseSecretKey(kp.publicKey.toBase58())).toThrow(WalletKeyError);
    expect(() => parseSecretKey('hello world')).toThrow(WalletKeyError);
    expect(() => parseSecretKey('[1,2,300]')).toThrow(WalletKeyError);
    expect(() => parseSecretKey('')).toThrow(WalletKeyError);
  });
});

describe('redaction', () => {
  const secret = bs58.encode(Keypair.generate().secretKey);
  it('redacts a key in any field and in free text', () => {
    expect(redact({ a: { b: [secret] }, privateKey: 'x' })).toEqual({ a: { b: [REDACTED] }, privateKey: REDACTED });
    expect(scrubText(`bad key ${secret} here`)).toBe(`bad key ${REDACTED} here`);
  });
});
