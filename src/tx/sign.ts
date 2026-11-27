// Transactions are signed with Node's own ed25519 (OpenSSL): about 40 µs, where web3.js's JavaScript ed25519 takes
// about 360 µs (it works the wallet's public key out again from its secret on every signature). The signatures are
// the same, byte for byte (tests/fast-build.test.ts). The key object is made once per wallet and kept only as long as
// the wallet's Keypair is (the server keeps one per user until the wallet is removed); no secret is ever turned into a
// string, written down or logged.
import { createPrivateKey, sign as edSign, type KeyObject } from 'node:crypto';
import type { Keypair, VersionedTransaction } from '@solana/web3.js';

/** PKCS#8 DER header of an Ed25519 private key: the 32-byte seed follows. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const keys = new WeakMap<Keypair, KeyObject>();

function keyOf(signer: Keypair): KeyObject {
  let k = keys.get(signer);
  if (!k) {
    const der = Buffer.concat([PKCS8_ED25519, signer.secretKey.subarray(0, 32)]);
    try {
      k = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    } finally {
      der.fill(0);
    }
    keys.set(signer, k);
  }
  return k;
}

/** Signs as VersionedTransaction.sign does: each signer's signature in its own place among the required signers. */
export function signTx(tx: VersionedTransaction, signers: Keypair[]): void {
  const message = tx.message.serialize();
  const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  for (const signer of signers) {
    const index = required.findIndex((k) => k.equals(signer.publicKey));
    if (index < 0) throw new Error(`Cannot sign transaction with non signer key ${signer.publicKey.toBase58()}`);
    const sig = edSign(null, message, keyOf(signer));
    tx.signatures[index] = new Uint8Array(sig.buffer, sig.byteOffset, sig.byteLength);
  }
}
