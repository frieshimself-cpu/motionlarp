// Found by the review of how the site hears the copied wallet (27 Nov 2026).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RawTransaction, SignatureInfo } from '../src/chain/rpc.js';
import { fastBuysFromLogs } from '../src/watch/events.js';
import { parseLeaderTrades } from '../src/watch/parse.js';
import { Watcher } from '../src/watch/watcher.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const fx = (name: string) => JSON.parse(readFileSync(`tests/fixtures/tx/${name}.json`, 'utf8')) as RawTransaction;
const LEADER = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
const buy = fx('curve_buy');
const SIG = buy.transaction.signatures[0]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a trade the copied wallet did not sign is not its trade', () => {
  it('fast path: a trade event line written by any program but pump.fun is ignored', () => {
    const real = fx('curve_buy');
    const logs = real.meta!.logMessages!;
    expect(fastBuysFromLogs(logs, 'sig', LEADER, 1)).not.toBeNull();
    const data = logs.find((l) => l.startsWith('Program data: '))!;
    const forged = ['Program Fake1111111111111111111111111111111111 invoke [1]', data, 'Program Fake1111111111111111111111111111111111 success'];
    expect(fastBuysFromLogs(forged, 'sig', LEADER, 1)).toBeNull();
  });

  it('balances: a buy the wallet neither signed nor paid for from its own account is not its buy', () => {
    const tx = fx('curve_buy');
    expect(parseLeaderTrades(tx, LEADER)).toHaveLength(1);
    // The attack: a stranger's transaction sends the wallet coins and drains 5 SOL from a token account they made
    // and handed to the wallet. The wallet did not sign and its own account did not pay.
    const forge = (shape: 'json' | 'parsed') => {
      const f = JSON.parse(JSON.stringify(tx)) as RawTransaction;
      const msg = f.transaction.message as { accountKeys: unknown[]; header?: { numRequiredSignatures: number } };
      const keys = (tx.transaction.message.accountKeys as string[]);
      const me = keys.indexOf(LEADER);
      const m = f.meta!;
      m.postBalances[me] = m.preBalances[me]! - (me === 0 ? m.fee : 0); // its own account paid nothing
      const stuffed = keys.length - 1; // an account handed to the wallet, drained by the stranger
      m.preBalances[stuffed] = m.preBalances[stuffed]! + 5_000_000_000;
      const owned = { accountIndex: stuffed, mint: 'So11111111111111111111111111111111111111112', owner: LEADER, uiTokenAmount: { amount: '0', decimals: 9 } };
      m.preTokenBalances = [...(m.preTokenBalances ?? []), owned];
      m.postTokenBalances = [...(m.postTokenBalances ?? []), { ...owned }];
      if (shape === 'json') msg.header!.numRequiredSignatures = 0;
      else { msg.accountKeys = keys.map((k) => ({ pubkey: k, signer: false })); delete msg.header; }
      return f;
    };
    expect(parseLeaderTrades(forge('json'), LEADER)).toEqual([]);
    expect(parseLeaderTrades(forge('parsed'), LEADER)).toEqual([]);
  });

  it('a wallet that does not sign but pays from its own account (a program account) still counts', () => {
    expect(parseLeaderTrades(fx('curve_buy_fee_payer_bot'), '2SaSfQt2BnS133wWk9Xcaztq8uBCbuZkZXSTvEMVTRaY')).toHaveLength(1);
  });
});

describe('the fast path reads what the wallet handed pump.fun', () => {
  it('sol + fee + creator fee, not the buyback slice or holder rewards a second time', () => {
    const t = fastBuysFromLogs(fx('curve_buy').meta!.logMessages!, 'sig', LEADER, 1)![0]!;
    expect(t.solLamports).toBe(344624513n + 3273933n + 1033874n);
    expect(t.approx).toBe(true);
  });
});

function watcher(opts: { sigs: () => SignatureInfo[]; txs: Record<string, RawTransaction | null | (() => Promise<RawTransaction | null>)>; streamHealthy?: () => boolean; valueInSol?: (m: string, a: bigint) => Promise<bigint> }) {
  const trades: LeaderTrade[] = [];
  const fetched: string[] = [];
  let socket: ((s: string, logs?: string[], slot?: number) => void) | null = null;
  const w = new Watcher({
    leaders: () => [LEADER],
    onTrade: async (t) => { trades.push(t); },
    pollMs: 0,
    getSignatures: async () => opts.sigs(),
    getTransaction: async (s) => { fetched.push(s); const v = opts.txs[s]; return typeof v === 'function' ? v() : v ?? null; },
    subscribe: (_l, cb) => { socket = cb; return () => { socket = null; }; },
    fetchRetryMs: 1,
    streamHealthy: opts.streamHealthy,
    valueInSol: opts.valueInSol,
  });
  return { w, trades, fetched, socket: (s: string, logs?: string[], slot?: number) => socket?.(s, logs, slot) };
}

describe('hearing the wallet when a feed misbehaves', () => {
  it('the stream says it is healthy but does not deliver: the websocket notice is fetched after a short wait', async () => {
    let sigs: SignatureInfo[] = [];
    const { w, socket, trades } = watcher({ sigs: () => sigs, txs: { [SIG]: buy }, streamHealthy: () => true });
    await w.sync(); // first look
    // not a plain curve buy in the logs (so not the fast path): a PumpSwap-style notice with no event
    socket(SIG, ['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]', 'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA success'], 5);
    await sleep(50);
    expect(trades).toHaveLength(0); // the stream gets its chance first
    await sleep(600);
    await w.drain();
    expect(trades).toHaveLength(1);
    sigs = [];
  });

  it('a transaction whose fetch keeps failing is fetched again on later cycles (the cursor has moved past it)', async () => {
    let sigs: SignatureInfo[] = [];
    let available = false;
    const { w, trades } = watcher({ sigs: () => sigs, txs: { [SIG]: () => Promise.resolve(available ? buy : null) } });
    await w.sync();
    sigs = [{ signature: SIG, slot: 2, err: null, blockTime: 2 }];
    await w.sync();
    expect(trades).toHaveLength(0);
    sigs = []; // the RPC only returns signatures newer than the cursor now
    available = true;
    await w.sync();
    expect(trades).toHaveLength(1);
  });

  it('stopping the watcher stops a poll cycle that is running', async () => {
    let polls = 0;
    const w = new Watcher({ leaders: () => [LEADER], onTrade: async () => undefined, pollMs: 5, getSignatures: async () => { polls++; await sleep(20); return []; }, getTransaction: async () => null });
    w.start();
    await sleep(5);
    w.stop();
    const at = polls;
    await sleep(100);
    expect(polls).toBe(at);
  });
});

describe('a buy heard together with the same wallet\'s full exit of that coin', () => {
  it('the late buy is not copied (it would be bought and dumped at once); the exit still goes through', async () => {
    const sell = fx('curve_wallet_sell');
    const seller = parseLeaderTrades(sell, 'GEXh5zqvGrydevffihQ37KKz2s2mQxfDP6tDkQcaCVCM')[0]!;
    // the same wallet bought this coin a few seconds before: build that buy from the real buy, retargeted
    const b = JSON.parse(JSON.stringify(buy)) as RawTransaction;
    const keys = b.transaction.message.accountKeys as string[];
    const at = keys.indexOf(LEADER);
    keys[at] = seller.leader;
    for (const tb of [...(b.meta!.preTokenBalances ?? []), ...(b.meta!.postTokenBalances ?? [])]) { if (tb.owner === LEADER) tb.owner = seller.leader; tb.mint = seller.mint; }
    b.transaction.signatures = ['buySig'];
    let sigs: SignatureInfo[] = [];
    const trades: LeaderTrade[] = [];
    const w = new Watcher({
      leaders: () => [seller.leader], onTrade: async (t) => { trades.push(t); }, pollMs: 0, fetchRetryMs: 1,
      getSignatures: async () => sigs,
      getTransaction: async (s) => (s === 'buySig' ? b : s === sell.transaction.signatures[0] ? sell : null),
    });
    await w.sync();
    sigs = [{ signature: sell.transaction.signatures[0]!, slot: 9, err: null, blockTime: 9 }, { signature: 'buySig', slot: 8, err: null, blockTime: 8 }];
    await w.sync();
    expect(trades.map((t) => t.side)).toEqual(['sell']);
  });
});

describe('a coin bought with USDC while also paying a small SOL tip', () => {
  it('the USDC is valued and added to the SOL (the trade is not taken for a 0.001 SOL buy)', async () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const tx = JSON.parse(JSON.stringify(buy)) as RawTransaction;
    const m = tx.meta!;
    const idx = (tx.transaction.message.accountKeys as string[]).indexOf(LEADER);
    // the wallet pays 250 USDC plus a 0.001 SOL tip instead of 0.35 SOL
    m.postBalances[idx] = m.preBalances[idx]! - 1_000_000 - m.fee;
    for (const tb of m.postTokenBalances ?? []) if (tb.owner !== LEADER) continue;
    m.preTokenBalances = [...(m.preTokenBalances ?? []), { accountIndex: 99, mint: usdc, owner: LEADER, uiTokenAmount: { amount: '300000000', decimals: 6 } }];
    m.postTokenBalances = [...(m.postTokenBalances ?? []), { accountIndex: 99, mint: usdc, owner: LEADER, uiTokenAmount: { amount: '50000000', decimals: 6 } }];
    const [t] = parseLeaderTrades(tx, LEADER);
    expect(t).toMatchObject({ side: 'buy', counter: { mint: usdc, amount: 250_000_000n } });
    let sigs: SignatureInfo[] = [];
    const { w, trades } = watcher({ sigs: () => sigs, txs: { [SIG]: tx }, valueInSol: async () => 1_200_000_000n });
    await w.sync();
    sigs = [{ signature: SIG, slot: 2, err: null, blockTime: null }];
    await w.sync();
    expect(trades[0]!.solLamports).toBe(t!.solLamports + 1_200_000_000n);
  });
});
