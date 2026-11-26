// Platform fee (the site owner's cut): a SystemProgram transfer from the user's wallet to FEE_WALLET inside the
// same transaction as the swap, after it, so the fee is paid only if the trade goes through. Buys: a share of the
// SOL spent. Sells: a share of the quoted SOL out. Idea and shape from velo/src/fee.ts.
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

export const MAX_FEE_BPS = 1000; // 10 %

export function feeLamports(amountLamports: bigint, feeBps: number): bigint {
  if (amountLamports <= 0n || !(feeBps > 0)) return 0n;
  return (amountLamports * BigInt(Math.floor(feeBps))) / 10_000n;
}

export function withFee(instructions: TransactionInstruction[], from: PublicKey, amountLamports: bigint, feeBps: number, feeWallet: string): { instructions: TransactionInstruction[]; fee: bigint } {
  const fee = feeWallet ? feeLamports(amountLamports, feeBps) : 0n;
  if (fee === 0n) return { instructions, fee: 0n };
  return { instructions: [...instructions, SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(feeWallet), lamports: fee })], fee };
}

/** Checked once at startup: a fee needs a real wallet to go to, and is capped. */
export function parseFeeConfig(c: { bps: number; wallet: string }): { bps: number; wallet: string } {
  if (!(c.bps > 0)) return { bps: 0, wallet: c.wallet };
  if (c.bps > MAX_FEE_BPS) throw new Error(`FEE_BPS ${c.bps} is above the 10 % cap (${MAX_FEE_BPS})`);
  let ok = false;
  try {
    ok = !!c.wallet && new PublicKey(c.wallet).toBytes().length === 32;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('FEE_BPS is set but FEE_WALLET is not a valid wallet address');
  return { bps: c.bps, wallet: c.wallet };
}
