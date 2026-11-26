// ported from velo/src/tx/build.ts
// Assemble one signed v0 transaction: compute budget (priority fee), the venue's instructions, optional tip.
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { config, solToLamports } from '../config.js';
import { getBlockhash } from '../chain/connection.js';

/** The priority fee (SOL) is the total the user wants to pay; spread it over the compute-unit limit. */
export function priorityFeeMicroLamportsPerCu(validatorTipSol: number, cuLimit: number): bigint {
  const lamports = solToLamports(Math.max(0, validatorTipSol || 0));
  if (lamports === 0n || cuLimit <= 0) return 0n;
  // microlamports per CU = lamports × 1e6 / cuLimit
  return (lamports * 1_000_000n) / BigInt(cuLimit);
}

export interface BuildTxArgs {
  signer: Keypair;
  instructions: TransactionInstruction[];
  validatorTipSol: number;
  /** Jito tip in SOL; only added when `tipAccount` is given (i.e. the Jito path). */
  txFeeSol: number;
  tipAccount?: PublicKey;
  cuLimit?: number;
}

export interface BuiltTx {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  priorityFeeMicroLamports: bigint;
  tipLamports: bigint;
}

export async function buildSignedTx(args: BuildTxArgs): Promise<BuiltTx> {
  const cuLimit = args.cuLimit ?? config.computeUnitLimit;
  const price = priorityFeeMicroLamportsPerCu(args.validatorTipSol, cuLimit);
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit })];
  if (price > 0n) ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  ixs.push(...args.instructions);

  let tipLamports = 0n;
  if (args.tipAccount) {
    tipLamports = solToLamports(Math.max(0, args.txFeeSol || 0));
    if (tipLamports > 0n) {
      ixs.push(SystemProgram.transfer({ fromPubkey: args.signer.publicKey, toPubkey: args.tipAccount, lamports: tipLamports }));
    }
  }

  const { blockhash, lastValidBlockHeight } = await getBlockhash();
  const message = new TransactionMessage({ payerKey: args.signer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([args.signer]);
  return { tx, blockhash, lastValidBlockHeight, priorityFeeMicroLamports: price, tipLamports };
}
