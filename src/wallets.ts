// Wallet keys: parsed from what people paste (base58, or the JSON byte array Phantom / solana-keygen export) into a
// Keypair in memory. Nothing in this module logs or stringifies a secret.
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export class WalletKeyError extends Error {}

function fromBytes(bytes: Uint8Array): Keypair {
  if (bytes.length === 64) {
    try {
      return Keypair.fromSecretKey(bytes);
    } catch {
      throw new WalletKeyError('that private key is not valid (its public half does not match)');
    }
  }
  if (bytes.length === 32) {
    // 32 bytes is what a wallet ADDRESS decodes to; treating it as a seed would silently make a different wallet.
    throw new WalletKeyError('that is a wallet address, not a private key: export the private key from your wallet');
  }
  throw new WalletKeyError(`that private key has ${bytes.length} bytes; a Solana private key has 64`);
}

/** Accepts a base58 secret key (88 chars) or a JSON array of 64 numbers. */
export function parseSecretKey(input: string): Keypair {
  const text = (input ?? '').trim();
  if (!text) throw new WalletKeyError('paste a private key');
  if (text.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new WalletKeyError('that looks like a byte array but is not valid JSON');
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new WalletKeyError('the byte array must hold numbers from 0 to 255');
    }
    return fromBytes(Uint8Array.from(arr as number[]));
  }
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(text);
  } catch {
    throw new WalletKeyError('that is not a valid private key (not base58)');
  }
  return fromBytes(bytes);
}
