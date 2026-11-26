// The tip ("bribe"): a transfer to one of Jito's tip accounts inside the trade's own transaction. Block builders
// order by tip, so a tipped transaction sent through Jito's block engine lands sooner. Tip accounts as published
// by Jito (the same list Velo uses).
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const MIN_TIP_LAMPORTS = 1000n;

export function tipLamports(tipSol: number): bigint {
  const l = BigInt(Math.round(Math.max(0, tipSol || 0) * 1e9));
  return l >= MIN_TIP_LAMPORTS ? l : 0n;
}

export function tipInstruction(from: PublicKey, tipSol: number): TransactionInstruction | null {
  const lamports = tipLamports(tipSol);
  if (lamports === 0n) return null;
  const to = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(to), lamports });
}
