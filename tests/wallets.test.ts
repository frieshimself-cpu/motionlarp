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

describe('redaction tells a private key from a transaction signature (27 Nov 2026)', () => {
  // Both are 64 bytes in base58. Every signature in the trade logs was being blanked, so no trade could be looked up.
  const kp = Keypair.generate();
  const secret = bs58.encode(kp.secretKey);
  const signature = '5K5yKtkkwQ7YE2Us9andNkNSqmvmJ15Tb2AcHjxaQVmQA2fe6svWi9smsioYnVGW69oVSGTMTxkoHHTTMV9qGfQY';
  it('a transaction signature stays readable, in fields and in free text', () => {
    expect(redact({ signature })).toEqual({ signature });
    expect(scrubText(`sent ${signature}`)).toBe(`sent ${signature}`);
  });
  it('a private key is still hidden, however it appears', () => {
    expect(redact({ note: secret })).toEqual({ note: REDACTED });
    expect(scrubText(`key=${secret}.`)).toBe(`key=${REDACTED}.`);
  });
  it('anything else key-length that is not exactly a signature is hidden too (a mangled key)', () => {
    const mangled = secret.slice(0, -2);
    expect(scrubText(mangled)).toBe(REDACTED);
  });
});
