import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS, tipInstruction } from '../src/tx/tip.js';

describe('tip to the block builder', () => {
  const user = Keypair.generate().publicKey;
  it('is a plain transfer of the tip to one of Jito\'s tip accounts', () => {
    const ix = tipInstruction(user, 0.002)!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(user)).toBe(true);
    expect(JITO_TIP_ACCOUNTS).toContain(ix.keys[1]!.pubkey.toBase58());
    expect(ix.data.readBigUInt64LE(4)).toBe(2_000_000n);
  });
  it('no tip, or one under Jito\'s 1000-lamport minimum: no instruction', () => {
    expect(tipInstruction(user, 0)).toBeNull();
    expect(tipInstruction(user, 0.0000005)).toBeNull();
  });
});
