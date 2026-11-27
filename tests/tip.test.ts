import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS, SENDER_TIP_ACCOUNTS, senderEndpoint, tipInstruction, tipLamports } from '../src/tx/tip.js';

const user = Keypair.generate().publicKey;
const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=abc-123';

describe('tip', () => {
  it('with Helius Sender (the default) the tip goes to one of Sender\'s tip accounts', () => {
    const ix = tipInstruction(user, 0.002, 'sender')!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(user)).toBe(true);
    expect(SENDER_TIP_ACCOUNTS).toContain(ix.keys[1]!.pubkey.toBase58());
    expect(ix.data.readBigUInt64LE(4)).toBe(2_000_000n);
  });
  it('without Sender it goes to a Jito tip account', () => {
    expect(JITO_TIP_ACCOUNTS).toContain(tipInstruction(user, 0.002, 'jito')!.keys[1]!.pubkey.toBase58());
  });
  it('no tip, or one under the route\'s minimum: no instruction', () => {
    expect(tipInstruction(user, 0, 'sender')).toBeNull();
    expect(tipLamports(0.000004, 'sender')).toBe(0n); // Sender: 0.000005 SOL minimum
    expect(tipLamports(0.000005, 'sender')).toBe(5_000n);
    expect(tipLamports(0.0000005, 'jito')).toBe(0n);
    expect(tipLamports(0.000001, 'jito')).toBe(1_000n);
  });
});

describe('Sender endpoint', () => {
  const base = 'https://sender.helius-rpc.com/fast';
  it('a tip of 0.001 SOL or more uses every fast lane; a smaller one the SWQOS-only lane', () => {
    expect(senderEndpoint(base, HELIUS, 1_000_000n)).toBe('https://sender.helius-rpc.com/fast?api-key=abc-123');
    expect(senderEndpoint(base, HELIUS, 200_000n)).toBe('https://sender.helius-rpc.com/fast?api-key=abc-123&swqos_only=true');
  });
  it('a non-Helius RPC: no key is added (Sender works keyless, slower limits)', () => {
    expect(senderEndpoint(base, 'https://example-rpc.com/xyz', 1_000_000n)).toBe(base);
  });
  it('switched off, or no tip: no endpoint', () => {
    expect(senderEndpoint('', HELIUS, 1_000_000n)).toBeNull();
    expect(senderEndpoint('off', HELIUS, 1_000_000n)).toBeNull();
    expect(senderEndpoint(base, HELIUS, 0n)).toBeNull();
  });
});
