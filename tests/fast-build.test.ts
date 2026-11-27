// The copy's transaction is built and signed faster (27 Nov 2026): program addresses are worked out once and
// remembered, and transactions are signed with Node's own ed25519. Both must give exactly what web3.js gives.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

/** The derivation as web3.js does it (from its createProgramAddressSync, which is not remembered): the first bump from
 *  255 down whose address is off the curve. */
function derive(seeds: Uint8Array[], program: PublicKey): [PublicKey, number] {
  for (let bump = 255; bump > 0; bump--) {
    try {
      return [PublicKey.createProgramAddressSync([...seeds, Buffer.from([bump])], program), bump];
    } catch (err) {
      if (!/Invalid seeds/.test((err as Error).message)) throw err; // (off the curve: the next bump)
    }
  }
  throw new Error('no bump');
}
const { rememberProgramAddresses, rememberAddressText } = await import('../src/chain/pda.js');
const { signTx } = await import('../src/tx/sign.js');
rememberProgramAddresses();
rememberAddressText();

describe('program addresses, remembered', () => {
  it('are the addresses and bumps web3.js works out, asked once or many times', () => {
    for (let i = 0; i < 40; i++) {
      const program = new PublicKey(randomBytes(32));
      const seeds = [Buffer.from('bonding-curve'), randomBytes(32), randomBytes(i % 5)];
      const [want, bump] = derive(seeds, program);
      for (let j = 0; j < 3; j++) {
        const [got, gotBump] = PublicKey.findProgramAddressSync(seeds, program);
        expect(got.toBase58()).toBe(want.toBase58());
        expect(gotBump).toBe(bump);
      }
    }
  });

  it('tells apart seeds that differ only in how they are split, and other programs', () => {
    const program = new PublicKey(randomBytes(32));
    const other = new PublicKey(randomBytes(32));
    const a = [Buffer.from('ab'), Buffer.from('c')];
    const b = [Buffer.from('a'), Buffer.from('bc')];
    expect(PublicKey.findProgramAddressSync(a, program)[0].toBase58()).toBe(derive(a, program)[0].toBase58());
    expect(PublicKey.findProgramAddressSync(b, program)[0].toBase58()).toBe(derive(b, program)[0].toBase58());
    expect(PublicKey.findProgramAddressSync(a, other)[0].toBase58()).toBe(derive(a, other)[0].toBase58());
  });

  it('still refuses a seed that is too long, every time', () => {
    const program = new PublicKey(randomBytes(32));
    for (let i = 0; i < 2; i++) expect(() => PublicKey.findProgramAddressSync([randomBytes(33)], program)).toThrow(/Max seed length/);
  });

  it('hands back a new pair each time (a caller changing it changes nothing for the next)', () => {
    const program = new PublicKey(randomBytes(32));
    const seeds = [randomBytes(32)];
    const first = PublicKey.findProgramAddressSync(seeds, program);
    const want = first[0].toBase58();
    (first as unknown as unknown[])[0] = null;
    expect(PublicKey.findProgramAddressSync(seeds, program)[0].toBase58()).toBe(want);
  });

  it('serves the token account addresses the libraries work out (spl-token derives through it)', () => {
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
    const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(ata.toBase58()).toBe(derive([owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0].toBase58());
  });
});

describe('addresses as text, remembered', () => {
  it('are the base58 text web3.js gives, for new keys, keys asked many times, and the all-zero key', async () => {
    const bs58 = (await import('bs58')).default;
    for (let i = 0; i < 50; i++) {
      const k = new PublicKey(randomBytes(32));
      const want = bs58.encode(k.toBytes());
      for (let j = 0; j < 3; j++) expect(k.toBase58()).toBe(want);
      expect(k.toString()).toBe(want);
      expect(JSON.parse(JSON.stringify({ k }))).toEqual({ k: want });
    }
    expect(PublicKey.default.toBase58()).toBe('11111111111111111111111111111111');
    expect(new PublicKey('11111111111111111111111111111111').toBase58()).toBe('11111111111111111111111111111111');
  });
});

describe("transactions signed with Node's own ed25519", () => {
  const transaction = (payer: Keypair, extra: Keypair[] = []) => new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 + Math.floor(Math.random() * 1e9) }),
      ...extra.map((k) => SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: payer.publicKey, lamports: 1 })),
    ],
  }).compileToV0Message());

  it('carry exactly the signatures web3.js gives them, byte for byte', () => {
    for (let i = 0; i < 25; i++) {
      const payer = Keypair.generate();
      const a = transaction(payer);
      const b = new VersionedTransaction(a.message);
      a.sign([payer]);
      signTx(b, [payer]);
      expect(Buffer.from(b.serialize()).equals(Buffer.from(a.serialize()))).toBe(true);
    }
  });

  it('put each signature in its signer\'s place when there are several', () => {
    const payer = Keypair.generate();
    const second = Keypair.generate();
    const a = transaction(payer, [second]);
    const b = new VersionedTransaction(a.message);
    a.sign([payer, second]);
    signTx(b, [second, payer]);
    expect(Buffer.from(b.serialize()).equals(Buffer.from(a.serialize()))).toBe(true);
  });

  it('refuse a key that is not one of the transaction\'s signers, as web3.js does', () => {
    const tx = transaction(Keypair.generate());
    expect(() => signTx(tx, [Keypair.generate()])).toThrow(/non signer key/);
  });

  it('sign again with the same wallet after its transaction changed (a new blockhash)', () => {
    const payer = Keypair.generate();
    const a = transaction(payer);
    signTx(a, [payer]);
    a.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    signTx(a, [payer]);
    const b = new VersionedTransaction(a.message);
    b.sign([payer]);
    expect(Buffer.from(a.serialize()).equals(Buffer.from(b.serialize()))).toBe(true);
  });
});
