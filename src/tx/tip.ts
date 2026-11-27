// The tip: a transfer inside the trade's own transaction that buys a faster landing.
//
//  * Helius Sender (default): the tip goes to one of Sender's tip accounts, and the transaction is sent through
//    Sender, which submits it to Jito and to staked validator connections at once. A tip of 0.001 SOL or more uses
//    every lane; a smaller one (0.000005 SOL at least) the SWQOS-only lane. Sender also wants a priority fee.
//    (Accounts, minimums and endpoints from Helius's Sender docs, 27 Nov 2026.)
//  * Without Sender (SENDER_URL=off): the tip goes to a Jito tip account and the transaction through Jito's block
//    engine (the list Velo uses).
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

export type TipRoute = 'sender' | 'jito';

export const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

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

const MIN_TIP: Record<TipRoute, bigint> = { sender: 5_000n, jito: 1_000n };
/** At or above this, Sender uses every lane ("Sender Max"). */
export const SENDER_MAX_TIP = 1_000_000n;

export function tipRoute(senderUrl: string): TipRoute {
  return senderUrl && senderUrl !== 'off' ? 'sender' : 'jito';
}

export function tipLamports(tipSol: number, route: TipRoute): bigint {
  const l = BigInt(Math.round(Math.max(0, tipSol || 0) * 1e9));
  return l >= MIN_TIP[route] ? l : 0n;
}

export function tipAccount(route: TipRoute): PublicKey {
  const list = route === 'sender' ? SENDER_TIP_ACCOUNTS : JITO_TIP_ACCOUNTS;
  return new PublicKey(list[Math.floor(Math.random() * list.length)]!);
}

export function tipInstruction(from: PublicKey, tipSol: number, route: TipRoute): TransactionInstruction | null {
  const lamports = tipLamports(tipSol, route);
  if (lamports === 0n) return null;
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: tipAccount(route), lamports });
}

/** Where a tipped transaction goes on Sender, or null (switched off / no tip). The Helius key lifts its rate limit. */
export function senderEndpoint(senderUrl: string, rpcUrl: string, tip: bigint): string | null {
  if (tipRoute(senderUrl) !== 'sender' || tip <= 0n) return null;
  const u = new URL(senderUrl);
  try {
    const rpc = new URL(rpcUrl);
    const key = rpc.searchParams.get('api-key');
    if (key && rpc.hostname.endsWith('helius-rpc.com')) u.searchParams.set('api-key', key);
  } catch {
    // no usable RPC URL: keyless
  }
  if (tip < SENDER_MAX_TIP) u.searchParams.set('swqos_only', 'true');
  return u.toString();
}
