import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { feeLamports, withFee, parseFeeConfig } from '../src/fee.js';

const FEE_WALLET = Keypair.generate().publicKey.toBase58();

describe('platform fee', () => {
  it('is a share of the trade in basis points, rounded down', () => {
    expect(feeLamports(100_000_000n, 100)).toBe(1_000_000n); // 1 % of 0.1 SOL
    expect(feeLamports(99n, 100)).toBe(0n);
    expect(feeLamports(100_000_000n, 0)).toBe(0n);
  });

  it('adds one transfer to the fee wallet after the swap instructions', () => {
    const user = Keypair.generate().publicKey;
    const swap = [SystemProgram.transfer({ fromPubkey: user, toPubkey: user, lamports: 1 })];
    const { instructions, fee } = withFee(swap, user, 50_000_000n, 100, FEE_WALLET);
    expect(fee).toBe(500_000n);
    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toBe(swap[0]);
    const ix = instructions[1]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(user)).toBe(true);
    expect(ix.keys[1]!.pubkey.toBase58()).toBe(FEE_WALLET);
    expect(ix.data.readBigUInt64LE(4)).toBe(500_000n);
  });

  it('no fee wallet or a zero fee: instructions unchanged', () => {
    const user = Keypair.generate().publicKey;
    expect(withFee([], user, 50_000_000n, 100, '').fee).toBe(0n);
    expect(withFee([], user, 50_000_000n, 0, FEE_WALLET).instructions).toHaveLength(0);
  });

  it('config: off by default, refuses a fee without a valid wallet or above 10 %', () => {
    expect(parseFeeConfig({ bps: 0, wallet: '' })).toEqual({ bps: 0, wallet: '' });
    expect(() => parseFeeConfig({ bps: 100, wallet: '' })).toThrow(/FEE_WALLET/);
    expect(() => parseFeeConfig({ bps: 100, wallet: 'nope' })).toThrow(/FEE_WALLET/);
    expect(() => parseFeeConfig({ bps: 1500, wallet: FEE_WALLET })).toThrow(/10 %/);
    expect(parseFeeConfig({ bps: 100, wallet: FEE_WALLET })).toEqual({ bps: 100, wallet: FEE_WALLET });
  });
});
