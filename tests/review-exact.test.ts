// A trade is booked from its quote the moment it lands; its exact SOL is read from its transaction a moment later.
// Timing fuzzer case 14 (27 Nov 2026): an update in between (the server restarts as soon as the last sale of an exit
// is confirmed), or a read that failed all its tries, left the quote standing for good in History and the profit.
// The fill now says it is an estimate until the exact figure is in, and the safety pass reads it from the chain.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/store.js';
import { validateSettings } from '../src/engine/settings.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const SOL = 1_000_000_000n;
const LEADER = 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih';
const MINT = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';
const never = <T>() => new Promise<T>(() => undefined);

function server(refine: 'never' | 'fails' | 'works') {
  const store = new Store(':memory:');
  const uid = store.createUser('u', 'x');
  const wallet = Keypair.generate();
  store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
  store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 1, minLeaderBuySol: 0, sell: { mirror: { enabled: true, mode: 'exit' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } } }));
  const settled: string[] = [];
  let held = 0n; // the coins in the wallet: the buy's, until the sell
  const later = <T>(v: T) => (refine === 'never' ? never<T | null>() : refine === 'fails' ? Promise.resolve(null) : Promise.resolve(v));
  const executor = {
    // booked from the quote: 1,000,000 coins for 1.000 SOL; really 1,100,000 coins for 1.004 SOL (fees, rent)
    buy: async (r: { onSigned?: (s: string) => void }) => { r.onSigned?.('BUY'); held = 1_100_000n; return { ok: true as const, signature: 'BUY', tokens: 1_000_000n, lamports: SOL, simulated: false, refine: later({ lamports: 1_004_000_000n, tokens: 1_100_000n }) }; },
    // booked from the quote: 1.5 SOL; really 1.497 SOL
    sell: async (r: { tokens: bigint }) => { held = 0n; return { ok: true as const, signature: 'SELL', tokens: r.tokens, lamports: 1_500_000_000n, simulated: false, refine: later({ lamports: 1_497_000_000n }) }; },
    quoteSell: async () => SOL, solBalance: async () => 10n * SOL, tokenBalance: async () => held, isLive: () => true,
    settleBuy: async (sig: string) => { settled.push(sig); return { state: 'landed' as const, tokens: 1_100_000n, lamports: 1_004_000_000n }; },
    settleSell: async (sig: string) => { settled.push(sig); return { state: 'landed' as const, tokens: 1_100_000n, lamports: 1_497_000_000n }; },
  };
  const start = () => new Engine({ store, executor, walletFor: () => wallet, priceMs: 2_000, maxSolPerBuy: 10, feeReserveSol: 0.01 });
  const trade = (side: 'buy' | 'sell'): LeaderTrade => ({ signature: `s${Math.random()}`, leader: LEADER, mint: MINT, side, solLamports: 2n * SOL, tokenAmount: 5n, tokensBefore: side === 'sell' ? 5n : 0n, tokensAfter: side === 'sell' ? 0n : 5n, venue: 'pumpfun', slot: side === 'sell' ? 2 : 1, blockTime: null });
  return { store, uid, start, trade, settled };
}

describe('exact figures that came after a restart, or never', () => {
  it('a buy booked from its quote, then a restart: the safety pass reads its own transaction (coins and SOL corrected)', async () => {
    const s = server('never');
    const before = s.start();
    await before.onLeaderTrade(s.trade('buy'));
    await before.idle();
    expect(s.store.fillsAwaitingExact(0)).toHaveLength(1);
    const after = s.start(); // the update: a new process on the same database
    await after.restore();
    const p = s.store.activePositions(s.uid)[0]!;
    expect(p).toMatchObject({ costLamports: 1_004_000_000n, tokensBought: 1_100_000n, tokensHeld: 1_100_000n });
    expect(s.store.fillsAwaitingExact(0)).toHaveLength(0);
  });

  it('the last sale of an exit, then a restart before its exact SOL: the closed position shows what the wallet received', async () => {
    const s = server('never');
    const e = s.start();
    await e.onLeaderTrade(s.trade('buy'));
    await e.idle();
    await e.onLeaderTrade(s.trade('sell'));
    await e.idle();
    const id = s.store.fillsAwaitingExact(0).find((f) => f.side === 'sell')!.positionId;
    expect(s.store.position(id)).toMatchObject({ status: 'closed', proceedsLamports: 1_500_000_000n });
    await s.start().restore();
    expect(s.store.position(id)!.proceedsLamports).toBe(1_497_000_000n);
    expect(s.store.fillsAwaitingExact(0)).toHaveLength(0);
  });

  it('a read that fails all its tries is left to the safety pass, not to the quote', async () => {
    const s = server('fails');
    const e = s.start();
    await e.onLeaderTrade(s.trade('buy'));
    await e.idle();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.store.fillsAwaitingExact(0)).toHaveLength(1);
    await e.restore();
    expect(s.settled).toEqual(['BUY']);
    expect(s.store.activePositions(s.uid)[0]).toMatchObject({ costLamports: 1_004_000_000n, tokensHeld: 1_100_000n });
  });

  it('a read that works clears the mark: the safety pass reads nothing, and nothing is applied twice', async () => {
    const s = server('works');
    const e = s.start();
    await e.onLeaderTrade(s.trade('buy'));
    await e.idle();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.store.fillsAwaitingExact(0)).toHaveLength(0);
    await e.restore();
    expect(s.settled).toEqual([]);
    expect(s.store.activePositions(s.uid)[0]).toMatchObject({ costLamports: 1_004_000_000n, tokensHeld: 1_100_000n });
  });

  it('while this process is still reading a trade, the safety pass leaves it alone', async () => {
    const s = server('never');
    const e = s.start();
    await e.onLeaderTrade(s.trade('buy'));
    await e.idle();
    await e.restore(); // same process: its own read is still under way
    expect(s.settled).toEqual([]);
  });
});

// Timing fuzzer cases 15, 16 and 17 (27 Nov 2026): the buy is booked with the quote's coin count (the reads were slow)
// and the exact count arrives a moment later. A sell in between matched the books to the wallet, and the exact
// count's difference was then taken off a second time (the position stuck open holding nothing, or coins left behind);
// or the position was sold out on the quote's count and the extra coins the buy really received were never sold.
describe("a buy booked with the quote's coin count, the exact count a moment later", () => {
  function quoted(received: bigint, sell: Record<string, unknown>) {
    const store = new Store(':memory:');
    const uid = store.createUser('u', 'x');
    const wallet = Keypair.generate();
    store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
    store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 1, minLeaderBuySol: 0, sell }));
    let clock = 1_000_000;
    let held = 0n;
    let exactCount: (v: { lamports: bigint; tokens: bigint }) => void = () => undefined;
    const sells: bigint[] = [];
    const executor = {
      buy: async (r: { onSigned?: (s: string) => void }) => {
        r.onSigned?.('BUY');
        held += received;
        return { ok: true as const, signature: 'BUY', tokens: 1_000_000n, lamports: SOL, simulated: false, refine: new Promise<{ lamports: bigint; tokens: bigint } | null>((res) => { exactCount = res; }) };
      },
      sell: async (r: { tokens: bigint }) => {
        const sold = r.tokens < held ? r.tokens : held; // a sell never takes more than the wallet holds
        held -= sold;
        sells.push(sold);
        return { ok: true as const, signature: `S${sells.length}`, tokens: sold, lamports: sold * 1_000n, simulated: false };
      },
      quoteSell: async (_m: string, t: bigint) => t * 1_000n, solBalance: async () => 10n * SOL, tokenBalance: async () => held, isLive: () => true,
    };
    const engine = new Engine({ store, executor, walletFor: () => wallet, now: () => clock, priceMs: 2_000, maxSolPerBuy: 10, feeReserveSol: 0.01, zeroRecheckMs: 1 });
    const trade = (side: 'buy' | 'sell'): LeaderTrade => ({ signature: `s${Math.random()}`, leader: LEADER, mint: MINT, side, solLamports: 2n * SOL, tokenAmount: 5n, tokensBefore: side === 'sell' ? 5n : 0n, tokensAfter: side === 'sell' ? 0n : 5n, venue: 'pumpfun', slot: side === 'sell' ? 2 : 1, blockTime: null });
    return {
      store, uid, engine, trade, sells, wallet: () => held,
      advance: async (ms: number) => { clock += ms; await engine.tick(); await engine.idle(); },
      exact: async () => { exactCount({ lamports: SOL + 2_000_000n, tokens: received }); await new Promise((r) => setTimeout(r, 5)); await engine.idle(); },
      position: () => store.position(1)!,
    };
  }
  const leftLadder = { mirror: { enabled: false, mode: 'exit' }, timedOf: 'left', timed: [{ afterSec: 2, percent: 50 }, { afterSec: 60, percent: 100 }], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } };

  it('fewer coins than the quote, a sell in between: the books end as the wallet (received less sold), not lower', async () => {
    const s = quoted(900_000n, leftLadder);
    await s.engine.onLeaderTrade(s.trade('buy'));
    await s.engine.idle();
    await s.advance(2_000); // half of what the wallet holds (450,000) sold; the books are matched to the wallet
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 450_000n });
    await s.exact(); // 900,000 received - 450,000 sold = 450,000 (it was 350,000: the 100,000 taken off twice)
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 450_000n, tokensBought: 900_000n });
    await s.advance(60_000);
    expect(s.position().status).toBe('closed');
    expect(s.wallet()).toBe(0n); // nothing left behind
  });

  it('far fewer: the position is not left open holding nothing (it was stuck for good, its coins never sold)', async () => {
    const s = quoted(400_000n, leftLadder);
    await s.engine.onLeaderTrade(s.trade('buy'));
    await s.engine.idle();
    await s.advance(2_000); // half of the wallet (200,000) sold; books matched to the wallet (200,000)
    await s.exact(); // 400,000 received - 200,000 sold = 200,000 (it was 200,000 - 600,000: nothing, the position stuck open)
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 200_000n });
    await s.advance(60_000);
    expect(s.position().status).toBe('closed');
    expect(s.wallet()).toBe(0n);
  });

  it('the exact count takes the books to nothing while a sell of the rest is out, and that sell fails: the position is closed, not left open for good (fuzzer case 18)', async () => {
    // A "% of the original bag" ladder whose first step is the whole bag. The buy is booked with the quote's count
    // (1,000,000); the wallet received 970,000. The first step sells the 970,000 there are and the books keep 30,000;
    // the +2 s step asks for them and fails (the wallet is empty). The exact count arrives while one of its tries is
    // out: the books go to 0, and the position stayed OPEN holding nothing with nothing under way. No rule, button or
    // safety pass handles such a position: it stayed open for good and the coin could never be copied again.
    const store = new Store(':memory:');
    const uid = store.createUser('u', 'x');
    const wallet = Keypair.generate();
    store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
    store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 1, minLeaderBuySol: 0, oncePerCoin: false, sell: { mirror: { enabled: false, mode: 'exit' }, timedOf: 'bag', timed: [{ afterSec: 0, percent: 100 }, { afterSec: 2, percent: 40 }, { afterSec: 6, percent: 100 }], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } } }));
    let clock = 1_000_000;
    let held = 0n;
    let exactCount: (v: { lamports: bigint; tokens: bigint }) => void = () => undefined;
    let hold: Promise<void> | null = null;
    const sold: bigint[] = [];
    const executor = {
      buy: async (r: { onSigned?: (s: string) => void }) => {
        r.onSigned?.('BUY');
        held += 970_000n;
        return { ok: true as const, signature: 'BUY', tokens: 1_000_000n, lamports: SOL, simulated: false, refine: new Promise<{ lamports: bigint; tokens: bigint } | null>((res) => { exactCount = res; }) };
      },
      // As the real executor: never more than the wallet holds, and nothing to sell is a failure.
      sell: async (r: { tokens: bigint }) => {
        if (hold) await hold;
        const n = r.tokens < held ? r.tokens : held;
        if (n <= 0n) return { ok: false as const, error: 'the wallet holds none of this coin' };
        held -= n;
        sold.push(n);
        return { ok: true as const, signature: `S${sold.length}`, tokens: n, lamports: n * 1_000n, simulated: false };
      },
      quoteSell: async (_m: string, t: bigint) => t * 1_000n, solBalance: async () => 10n * SOL, tokenBalance: async () => held, isLive: () => true,
    };
    const engine = new Engine({ store, executor, walletFor: () => wallet, now: () => clock, priceMs: 1e9, maxSolPerBuy: 10, feeReserveSol: 0.01, zeroRecheckMs: 1, fastRetryMs: [0, 1, 1], slowRetryMs: 1 });
    const trade = (slot: number): LeaderTrade => ({ signature: `s${Math.random()}`, leader: LEADER, mint: MINT, side: 'buy', solLamports: 2n * SOL, tokenAmount: 5n, tokensBefore: 0n, tokensAfter: 5n, venue: 'pumpfun', slot, blockTime: null });
    await engine.onLeaderTrade(trade(1));
    await engine.idle();
    await engine.tick(); await engine.idle(); // +0 s: the first step sells the 970,000 the wallet holds
    expect(sold).toEqual([970_000n]);
    expect(store.position(1)).toMatchObject({ status: 'open', tokensHeld: 30_000n });
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    clock += 2_000; await engine.tick(); await new Promise((r) => setTimeout(r, 5)); // +2 s: its try is out
    exactCount({ lamports: SOL, tokens: 970_000n }); await new Promise((r) => setTimeout(r, 5));
    expect(store.position(1)).toMatchObject({ status: 'open', tokensHeld: 0n }); // the try is still out: not yet
    hold = null; release();
    await engine.idle();
    expect(store.position(1)).toMatchObject({ status: 'closed', tokensHeld: 0n });
    clock += 10_000; await engine.tick(); await engine.idle();
    expect(store.activePositions(uid)).toHaveLength(0);
    // and the coin can be copied again
    await engine.onLeaderTrade(trade(9));
    await engine.idle();
    expect(store.activePositions(uid)).toHaveLength(1);
  });

  it('more coins than the quote, sold out on the quote\'s count: the rest is sold when the exact count arrives', async () => {
    const s = quoted(1_100_000n, { mirror: { enabled: true, mode: 'exit' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } });
    await s.engine.onLeaderTrade(s.trade('buy'));
    await s.engine.idle();
    await s.engine.onLeaderTrade(s.trade('sell')); // their exit: we sell the 1,000,000 the books know
    await s.engine.idle();
    expect(s.position().status).toBe('closed');
    expect(s.wallet()).toBe(100_000n);
    await s.exact();
    expect(s.sells).toEqual([1_000_000n, 100_000n]);
    expect(s.wallet()).toBe(0n);
    expect(s.position()).toMatchObject({ status: 'closed', tokensBought: 1_100_000n, tokensHeld: 0n });
    expect(s.store.events(s.uid, 20).some((e) => /received .* more than its quote said/.test(e.message))).toBe(true);
  });
});
