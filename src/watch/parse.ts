// What a followed wallet did in one transaction, read from balance changes (not instruction names, which differ
// between pump.fun's buy/sell variants and PumpSwap's base/quote naming).
//
// The wallet's SOL position = its own lamports + the lamports of every token account it owns (WSOL balances and
// token-account rent included), with the network fee added back when it paid it. A pump.fun / PumpSwap transaction
// where its balance of a coin rises is a buy; where it falls, a sell.
import type { RawTransaction } from '../chain/rpc.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface LeaderTrade {
  signature: string;
  leader: string;
  mint: string;
  side: 'buy' | 'sell';
  /** Buy: SOL the wallet spent (fees and tips it paid included). Sell: SOL it received. */
  solLamports: bigint;
  /** Tokens bought or sold (base units, always positive). */
  tokenAmount: bigint;
  tokensBefore: bigint;
  tokensAfter: bigint;
  venue: 'pumpfun' | 'pumpswap';
  slot: number;
  blockTime: number | null;
}

export function accountKeys(tx: RawTransaction): string[] {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const loaded = tx.meta?.loadedAddresses;
  return loaded ? [...keys, ...loaded.writable, ...loaded.readonly] : keys;
}

/** Share of its bag the wallet sold, 0..1 (1 when it held nothing before, i.e. unknown). */
export function soldShare(t: LeaderTrade): number {
  if (t.side !== 'sell' || t.tokensBefore <= 0n) return 1;
  return Math.min(1, Number((t.tokenAmount * 1_000_000n) / t.tokensBefore) / 1_000_000);
}

export function parseLeaderTrades(tx: RawTransaction, leader: string): LeaderTrade[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const keys = accountKeys(tx);
  const venue = keys.includes(PUMP_AMM_PROGRAM) ? 'pumpswap' : keys.includes(PUMP_PROGRAM) ? 'pumpfun' : null;
  if (!venue) return [];
  const leaderIdx = keys.indexOf(leader);
  if (leaderIdx < 0) return [];

  const lamportDelta = (i: number) => BigInt((meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0));
  let sol = lamportDelta(leaderIdx) + (leaderIdx === 0 ? BigInt(meta.fee) : 0n);

  const before = new Map<string, bigint>();
  const after = new Map<string, bigint>();
  const ownedAccounts = new Set<number>();
  for (const [list, into] of [[meta.preTokenBalances ?? [], before], [meta.postTokenBalances ?? [], after]] as const) {
    for (const b of list) {
      if (b.owner !== leader) continue;
      ownedAccounts.add(b.accountIndex);
      into.set(b.mint, (into.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
    }
  }
  for (const i of ownedAccounts) if (i !== leaderIdx) sol += lamportDelta(i);

  const trades: LeaderTrade[] = [];
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    if (mint === WSOL_MINT) continue;
    const pre = before.get(mint) ?? 0n;
    const post = after.get(mint) ?? 0n;
    if (pre === post) continue;
    const side = post > pre ? 'buy' : 'sell';
    trades.push({
      signature: tx.transaction.signatures[0] ?? '',
      leader,
      mint,
      side,
      solLamports: side === 'buy' ? (sol < 0n ? -sol : 0n) : sol > 0n ? sol : 0n,
      tokenAmount: side === 'buy' ? post - pre : pre - post,
      tokensBefore: pre,
      tokensAfter: post,
      venue,
      slot: tx.slot,
      blockTime: tx.blockTime,
    });
  }
  return trades;
}
