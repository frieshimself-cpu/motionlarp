// ported from velo/src/venues/types.ts
// A venue knows how to turn (pool, wallet, amount) into instructions for one program family.
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';

export type VenueKind = 'pumpfun_curve' | 'pumpswap';

export interface ResolvedPool {
  kind: VenueKind;
  /** The account the instructions target: bonding curve PDA or PumpSwap pool. */
  pool: PublicKey;
  mint: PublicKey;
  /** SPL Token or Token-2022 program that owns the mint. */
  tokenProgram: PublicKey;
  /** Graduated curve: the PumpSwap pool it migrated to (kind is then 'pumpswap'). */
  migratedFrom?: PublicKey;
}

export interface BuildResult {
  instructions: TransactionInstruction[];
  /** What the quote said the user gets (buy) or receives (sell), before slippage. */
  expectedOut: bigint;
  /** Worst-case after slippage, as encoded in the instruction. */
  minOut: bigint;
}

export interface Venue {
  readonly kind: VenueKind;
  /** Tokens out for `lamportsIn`, before slippage. */
  quoteBuy(pool: ResolvedPool, lamportsIn: bigint): Promise<bigint>;
  /** Lamports out for `tokensIn`, before slippage. */
  quoteSell(pool: ResolvedPool, tokensIn: bigint): Promise<bigint>;
  buildBuy(args: { pool: ResolvedPool; user: PublicKey; lamportsIn: bigint; slippagePct: number }): Promise<BuildResult>;
  buildSell(args: { pool: ResolvedPool; user: PublicKey; tokensIn: bigint; slippagePct: number }): Promise<BuildResult>;
}

export class VenueError extends Error {
  constructor(message: string, readonly code: string = 'venue_error') {
    super(message);
  }
}
