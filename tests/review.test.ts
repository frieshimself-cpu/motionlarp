// Regression tests for the findings of the code review of 26 Nov 2026 (each one reproduced a real bug first).
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Engine } from '../src/engine/engine.js';
import type { Executor, FillResult, TradeRequest } from '../src/engine/executor.js';
import { validateSettings } from '../src/engine/settings.js';
import { Store } from '../src/store.js';
import { Watcher } from '../src/watch/watcher.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const L1 = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
const L2 = Keypair.generate().publicKey.toBase58();
const MINT = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';
const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Ex implements Executor {
  price = 1_000_000n; live = false; held = 0n; quoteDelay = 0; sellDelay = 0;
  sells: bigint[] = [];
  balanceFails = 0;
  leaderHolds: bigint | 'error' = 1n;
  async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    const tokens = (req.lamports * this.price) / SOL; this.held += tokens;
    return { ok: true, signature: 'B', tokens, lamports: req.lamports, simulated: !(req.live && this.live) };
  }
  async sell(req: TradeRequest & { tokens: bigint }): Promise<FillResult> {
    if (this.sellDelay) await sleep(this.sellDelay);
    const t = req.tokens > this.held ? this.held : req.tokens; this.held -= t; this.sells.push(t);
    return { ok: true, signature: 'S', tokens: t, lamports: (t * SOL) / this.price, simulated: !(req.live && this.live) };
  }
  async quoteSell(_m: string, tokens: bigint) { if (this.quoteDelay) await sleep(this.quoteDelay); return (tokens * SOL) / this.price; }
  async solBalance() { return 10n * SOL; }
  async tokenBalance(owner: string) {
    if (owner === L1 || owner === L2) { if (this.leaderHolds === 'error') throw new Error('rpc down'); return this.leaderHolds; }
    if (this.balanceFails > 0) { this.balanceFails--; throw new Error('429 Too Many Requests'); }
    return this.held;
  }
  isLive(r: { live: boolean }) { return r.live && this.live; }
}

function trade(o: Partial<LeaderTrade> = {}): LeaderTrade {
  return { signature: `sig${Math.random()}`, leader: L1, mint: MINT, side: 'buy', solLamports: 2n * SOL, tokenAmount: 2_000_000n, tokensBefore: 0n, tokensAfter: 2_000_000n, venue: 'pumpfun', slot: 10, blockTime: null, ...o };
}

function setup(ex: Ex, priceMs = 0) {
  const store = new Store(':memory:');
  const uid = store.createUser('a', 'x');
  const w = Keypair.generate();
  store.setWallet(uid, w.publicKey.toBase58(), 'enc');
  let clock = 1_000_000;
  const mk = () => new Engine({ store, executor: ex, walletFor: () => w, now: () => clock, priceMs, maxSolPerBuy: 1, feeReserveSol: 0.01 });
  return { store, uid, engine: mk(), mk, adv: (ms: number) => { clock += ms; }, clockRef: () => clock };
}

describe('review findings', () => {
  it('#4 a timed partial sell that finishes during a later tick never fires twice', async () => {
    const ex = new Ex(); ex.quoteDelay = 300; ex.sellDelay = 500;
    const { store, uid, engine, adv } = setup(ex, 100);
    store.createCopy(uid, validateSettings({ leader: L1, buySol: 0.1, minLeaderBuySol: 1, sell: { mirror: { enabled: false }, timed: [{ afterSec: 10, percent: 25 }] } }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    adv(10_000);
    await engine.tick();
    adv(200);
    await sleep(350);
    await engine.tick(); await engine.idle();
    expect(ex.sells).toEqual([25_000n]);
  });

  it("#3 live: a sell takes only the position's own tokens, never other coins of that mint the user holds in the wallet", async () => {
    const ex = new Ex(); ex.live = true;
    const { store, uid, engine, adv } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, mode: 'live', buySol: 0.1, minLeaderBuySol: 1, sell: { mirror: { enabled: false }, timed: [{ afterSec: 5, percent: 100 }] } }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    ex.held += 70_000n; // the user also holds some of this coin, bought by hand
    adv(6000); await engine.tick(); await engine.idle();
    expect(ex.sells).toEqual([100_000n]);
    expect(ex.held).toBe(70_000n);
  });

  it('#3 one position per coin per user: a second copy does not buy a coin the user already holds', async () => {
    const ex = new Ex(); ex.live = true;
    const { store, uid, engine } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, mode: 'live', buySol: 0.1, minLeaderBuySol: 1 }));
    store.createCopy(uid, validateSettings({ leader: L2, mode: 'live', buySol: 0.1, minLeaderBuySol: 1 }));
    await engine.onLeaderTrade(trade()); await engine.onLeaderTrade(trade({ leader: L2 })); await engine.idle();
    expect(store.activePositions(uid)).toHaveLength(1);
  });

  it('#5 an old leader sell is still mirrored (only old buys are ignored)', async () => {
    const ex = new Ex();
    const { store, uid, engine, clockRef } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, buySol: 0.1, minLeaderBuySol: 1 }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    await engine.onLeaderTrade(trade({ side: 'sell', slot: 11, tokensBefore: 2_000_000n, tokenAmount: 2_000_000n, tokensAfter: 0n, blockTime: Math.floor(clockRef() / 1000) - 90 }));
    await engine.idle();
    expect(store.activePositions(uid)).toHaveLength(0);
  });

  // (The later sell is a partial one: a buy heard together with the wallet's FULL exit is not copied at all.)
  it('#6 the watcher hands trades over in order even when the later fetch finishes first', async () => {
    const order: string[] = [];
    const delay: Record<string, number> = { BUY: 200, SELL: 5 };
    let call = 0;
    const w = new Watcher({
      leaders: () => [L1], pollMs: 1e9, fetchRetryMs: 1,
      getSignatures: async () => { call++; return call === 1 ? [] : [{ signature: 'SELL', slot: 2, err: null, blockTime: 1 }, { signature: 'BUY', slot: 1, err: null, blockTime: 1 }]; },
      getTransaction: async (s) => { await sleep(delay[s]!); return { slot: 1, blockTime: 1, meta: { err: null, fee: 5000, preBalances: [10e9, 0], postBalances: s === 'BUY' ? [9e9, 0] : [11e9, 0], preTokenBalances: s === 'BUY' ? [] : [{ accountIndex: 1, mint: MINT, owner: L1, uiTokenAmount: { amount: '100', decimals: 6 } }], postTokenBalances: s === 'BUY' ? [{ accountIndex: 1, mint: MINT, owner: L1, uiTokenAmount: { amount: '100', decimals: 6 } }] : [{ accountIndex: 1, mint: MINT, owner: L1, uiTokenAmount: { amount: '40', decimals: 6 } }] }, transaction: { signatures: [s], message: { accountKeys: [L1, 'acc', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'] } } } as never; },
      onTrade: async (t) => { order.push(`${t.signature}:${t.side}`); },
    });
    await w.sync(); await w.sync();
    expect(order).toEqual(['BUY:buy', 'SELL:sell']);
  });

  it('#6 a buy that arrives after the same wallet\'s later sell of that coin is not copied', async () => {
    const ex = new Ex();
    const { store, uid, engine } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, buySol: 0.1, minLeaderBuySol: 1 }));
    await engine.onLeaderTrade(trade({ side: 'sell', slot: 20, tokensBefore: 2_000_000n, tokenAmount: 2_000_000n, tokensAfter: 0n }));
    await engine.onLeaderTrade(trade({ slot: 19 }));
    await engine.idle();
    expect(store.activePositions(uid)).toHaveLength(0);
  });

  it('#10 a retry for a position that closed is dropped', async () => {
    const ex = new Ex();
    const { store, uid, engine, adv } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, buySol: 0.1, minLeaderBuySol: 1, sell: { mirror: { enabled: false }, timed: [{ afterSec: 5, percent: 50 }] } }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    const orig = ex.sell.bind(ex); let fail = 1;
    ex.sell = async (r) => (fail-- > 0 ? { ok: false, error: 'boom' } : orig(r));
    adv(6000); await engine.tick(); await engine.idle();
    await engine.sellNow(uid, store.activePositions(uid)[0]!.id);
    for (let i = 0; i < 3; i++) { adv(120_000); await engine.tick(); await engine.idle(); }
    expect((engine as unknown as { retries: Map<string, unknown> }).retries.size).toBe(0);
  });

  it('#1 live: a failed balance read before a sell retries instead of closing the position', async () => {
    const ex = new Ex(); ex.live = true;
    const { store, uid, engine, adv } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, mode: 'live', buySol: 0.1, minLeaderBuySol: 1, sell: { mirror: { enabled: false }, timed: [{ afterSec: 1, percent: 50 }] } }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    ex.balanceFails = 1;
    adv(1000); await engine.tick(); await engine.idle();
    expect(store.activePositions(uid)[0]).toMatchObject({ status: 'open', tokensHeld: 100_000n });
    adv(2000); await engine.tick(); await engine.idle();
    expect(store.activePositions(uid)[0]!.tokensHeld).toBe(50_000n);
  });

  it('#1 live: a failed balance read after a sell keeps our own figure', async () => {
    const ex = new Ex(); ex.live = true;
    const { store, uid, engine, adv } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, mode: 'live', buySol: 0.1, minLeaderBuySol: 1, sell: { mirror: { enabled: false }, timed: [{ afterSec: 1, percent: 50 }] } }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    const orig = ex.sell.bind(ex);
    ex.sell = async (r) => { const f = await orig(r); ex.balanceFails = 1; return f; };
    adv(1000); await engine.tick(); await engine.idle();
    expect(store.activePositions(uid)[0]).toMatchObject({ status: 'open', tokensHeld: 50_000n });
  });

  it('#8 a copy set to Live on a test server opens a paper position; a live position on a test server does not sell on paper', async () => {
    const ex = new Ex(); ex.live = false;
    const { store, uid, engine, adv } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, mode: 'live', buySol: 0.1, minLeaderBuySol: 1, sell: { mirror: { enabled: false }, timed: [{ afterSec: 1, percent: 100 }] } }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    expect(store.activePositions(uid)[0]!.mode).toBe('paper');
    // a real position, then the server goes back to test mode
    const id = store.activePositions(uid)[0]!.id;
    store.updatePosition(id, { mode: 'live' });
    adv(1000); await engine.tick(); await engine.idle();
    // Never sold on paper. (Since 27 Nov a live position IS sold for real while the owner's Live switch is off;
    // this fake executor cannot send at all, so the sell waits and says why.)
    expect(ex.sells).toEqual([]);
    expect(store.events(uid)[0]!.message).toMatch(/cannot be sold right now/);
  });

  it('#7 restore: interrupted test buys fail; an interrupted live buy that landed opens', async () => {
    const ex = new Ex(); ex.live = true;
    const { store, uid, mk } = setup(ex);
    const copy = store.createCopy(uid, validateSettings({ leader: L1, mode: 'live', buySol: 0.1, minLeaderBuySol: 1 }));
    const s = store.copy(copy)!.settings;
    const paper = store.insertPosition({ userId: uid, copyId: copy, mint: 'Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA', mode: 'paper', leaderSig: 'a', sell: s.sell, copyName: 'x', leader: L1, now: 1 });
    const live = store.insertPosition({ userId: uid, copyId: copy, mint: MINT, mode: 'live', leaderSig: 'b', sell: s.sell, copyName: 'x', leader: L1, now: 1 });
    ex.held = 77_000n;
    await mk().restore();
    expect(store.position(paper)!.status).toBe('failed');
    expect(store.position(live)).toMatchObject({ status: 'open', tokensHeld: 77_000n, costLamports: SOL / 10n });
  });

  it('#5 reconcile: a followed wallet that holds none of our coin any more → sell all; unknown balance → nothing', async () => {
    const ex = new Ex();
    const { store, uid, engine, adv } = setup(ex);
    store.createCopy(uid, validateSettings({ leader: L1, buySol: 0.1, minLeaderBuySol: 1, sell: { mirror: { enabled: true } } }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    adv(60_000);
    ex.leaderHolds = 'error';
    await engine.reconcile(); await engine.idle();
    ex.leaderHolds = 5n;
    await engine.reconcile(); await engine.idle();
    expect(store.activePositions(uid)).toHaveLength(1);
    ex.leaderHolds = 0n;
    await engine.reconcile(); await engine.idle();
    expect(store.activePositions(uid)).toHaveLength(0);
  });

  it('#9 a busy wallet: polls page back to the last signature seen', async () => {
    const seenSigs: string[] = [];
    const all = Array.from({ length: 120 }, (_, i) => ({ signature: `s${120 - i}`, slot: 120 - i, err: null, blockTime: 1 }));
    let first = true;
    const w = new Watcher({
      leaders: () => [L1], pollMs: 1e9, fetchRetryMs: 1, onTrade: async () => {},
      getSignatures: async (_l, until, before) => {
        if (first) { first = false; return [{ signature: 's0', slot: 0, err: null, blockTime: 1 }]; }
        const start = before ? all.findIndex((x) => x.signature === before) + 1 : 0;
        const page = all.slice(start, start + 50);
        const stop = page.findIndex((x) => x.signature === until);
        return stop >= 0 ? page.slice(0, stop) : page;
      },
      getTransaction: async (s) => { seenSigs.push(s); return null; },
    });
    await w.sync(); await w.sync();
    expect(new Set(seenSigs).size).toBe(120);
  });
});

describe('the clock never waits on a price check', () => {
  it('a timed sell fires while a slow price check is still running', async () => {
    const ex = new Ex(); ex.quoteDelay = 400;
    const { store, uid, engine, adv } = setup(ex, 0);
    store.createCopy(uid, validateSettings({ leader: L1, buySol: 0.1, minLeaderBuySol: 1, sell: { mirror: { enabled: false }, timed: [{ afterSec: 1, percent: 100 }] } }));
    await engine.onLeaderTrade(trade()); await engine.idle();
    adv(1000);
    const t = engine.tick();
    await sleep(60);
    expect(ex.sells).toEqual([100_000n]); // sold before the 400 ms quote came back
    await t; await engine.idle();
  });
});
