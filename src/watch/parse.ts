// What a followed wallet did in one transaction, read from balance changes, on any launchpad or exchange (not from
// instruction names, which differ between every program and even between pump.fun's own buy/sell variants).
//
// The wallet's SOL position = its own lamports + the lamports of every token account it owns (WSOL balances and
// token-account rent included), with the network fee added back when it paid it. A coin whose balance rises is a
// buy, one that falls a sell — but only when something went the other way: SOL, a stablecoin (USDC-, USDT-,
// USD1-paired coins), or another coin (a coin-for-coin swap). A coin arriving alone is a transfer, not a trade.
import type { RawTransaction } from '../chain/rpc.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Quote currencies: moving them is paying, not trading a coin. */
export const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
]);
/** SOL movements below this (rent, tips, dust) do not make a transfer into a trade. */
const SOL_DUST = 50_000n;

export interface LeaderTrade {
  signature: string;
  leader: string;
  mint: string;
  side: 'buy' | 'sell';
  /**
   * Buy: SOL the wallet spent (fees and tips it paid included). Sell: SOL it received. For a coin bought with a
   * stablecoin or another coin this is 0 until the watcher values `counter` in SOL.
   */
  solLamports: bigint;
  /** What went the other way when it was not SOL: the stablecoin or coin paid (buy) or received (sell). */
  counter?: { mint: string; amount: bigint };
  /** Tokens bought or sold (base units, always positive). */
  tokenAmount: bigint;
  tokensBefore: bigint;
  tokensAfter: bigint;
  venue: 'pumpfun' | 'pumpswap' | 'other';
  slot: number;
  blockTime: number | null;
  /** The coin's decimals, when the transaction's balances carried them (pump.fun coins: 6). */
  decimals?: number;
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

/**
 * What one transaction changed for a wallet, signed and exact, for booking OUR OWN trades: its SOL position (its
 * own lamports plus those of the token accounts it owns, so wrapped SOL and a new token account's rent stay "its"),
 * with everything it paid in that transaction already inside (network fee, priority fee, tip, platform fee); and
 * its balance of one coin. Unlike parseLeaderTrades there is no dust threshold and no guessing what was a trade:
 * a sell that did not cover its own fees is a small loss here, not "nothing happened". Null when the transaction
 * failed or the wallet is not in it.
 */
export function walletChange(tx: RawTransaction, owner: string, mint: string): { lamports: bigint; tokens: bigint } | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = accountKeys(tx);
  const ownerIdx = keys.indexOf(owner);
  if (ownerIdx < 0) return null;
  const delta = (i: number) => BigInt((meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0));
  let lamports = delta(ownerIdx);
  let tokens = 0n;
  const owned = new Set<number>();
  for (const [list, sign] of [[meta.preTokenBalances ?? [], -1n], [meta.postTokenBalances ?? [], 1n]] as const) {
    for (const b of list) {
      if (b.owner !== owner) continue;
      owned.add(b.accountIndex);
      if (b.mint === mint) tokens += sign * BigInt(b.uiTokenAmount.amount);
    }
  }
  for (const i of owned) if (i !== ownerIdx) lamports += delta(i);
  return { lamports, tokens };
}

export function parseLeaderTrades(tx: RawTransaction, leader: string): LeaderTrade[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const keys = accountKeys(tx);
  const venue = keys.includes(PUMP_AMM_PROGRAM) ? 'pumpswap' : keys.includes(PUMP_PROGRAM) ? 'pumpfun' : 'other';
  const leaderIdx = keys.indexOf(leader);
  if (leaderIdx < 0) return [];

  const lamportDelta = (i: number) => BigInt((meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0));
  let sol = lamportDelta(leaderIdx) + (leaderIdx === 0 ? BigInt(meta.fee) : 0n);

  const before = new Map<string, bigint>();
  const after = new Map<string, bigint>();
  const ownedAccounts = new Set<number>();
  const decimalsOf = new Map<string, number>();
  for (const [list, into] of [[meta.preTokenBalances ?? [], before], [meta.postTokenBalances ?? [], after]] as const) {
    for (const b of list) {
      if (b.owner !== leader) continue;
      ownedAccounts.add(b.accountIndex);
      into.set(b.mint, (into.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
      if (typeof b.uiTokenAmount.decimals === 'number') decimalsOf.set(b.mint, b.uiTokenAmount.decimals);
    }
  }
  for (const i of ownedAccounts) if (i !== leaderIdx) sol += lamportDelta(i);

  const delta = new Map<string, bigint>();
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    if (mint === WSOL_MINT) continue; // WSOL is SOL: already in `sol` through the token account's lamports
    const d = (after.get(mint) ?? 0n) - (before.get(mint) ?? 0n);
    if (d !== 0n) delta.set(mint, d);
  }
  const coins = [...delta.keys()].filter((m) => !STABLE_MINTS.has(m));

  const trades: LeaderTrade[] = [];
  for (const mint of coins) {
    const d = delta.get(mint)!;
    const side = d > 0n ? 'buy' : 'sell';
    const solPaid = side === 'buy' ? -sol : sol; // positive = SOL went the other way
    let counter: LeaderTrade['counter'];
    if (solPaid < SOL_DUST) {
      // Not paid in SOL: a stablecoin first, else another coin, moving the opposite way (largest wins).
      const opposite = [...delta.entries()].filter(([m, x]) => m !== mint && (side === 'buy' ? x < 0n : x > 0n));
      const pick = opposite.find(([m]) => STABLE_MINTS.has(m)) ?? opposite.sort((a, b) => (a[1] < 0n ? -a[1] : a[1]) > (b[1] < 0n ? -b[1] : b[1]) ? -1 : 1)[0];
      if (!pick) continue; // nothing went the other way: a transfer, not a trade
      counter = { mint: pick[0], amount: pick[1] < 0n ? -pick[1] : pick[1] };
    }
    const pre = before.get(mint) ?? 0n;
    const post = after.get(mint) ?? 0n;
    trades.push({
      signature: tx.transaction.signatures[0] ?? '',
      leader,
      mint,
      side,
      solLamports: counter ? 0n : solPaid,
      ...(counter ? { counter } : {}),
      tokenAmount: side === 'buy' ? post - pre : pre - post,
      tokensBefore: pre,
      tokensAfter: post,
      venue,
      slot: tx.slot,
      blockTime: tx.blockTime,
      ...(decimalsOf.has(mint) ? { decimals: decimalsOf.get(mint)! } : {}),
    });
  }
  return trades;
}
