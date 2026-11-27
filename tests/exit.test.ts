// The timed exit of the original bag (the "Scharo" exit): 40 % of the bag at +2 s, 30 % at +4 s, everything left
// at +6 s, counted from our own confirmed buy, whatever the price.
import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Engine } from '../src/engine/engine.js';
import type { Executor, FillResult, TradeRequest } from '../src/engine/executor.js';
import { PRESETS, validateSettings } from '../src/engine/settings.js';
import { Store } from '../src/store.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const SCHARO = PRESETS.find((p) => p.name === 'Scharo')!.settings;
const LEADER = String(SCHARO.leader);
const MINT = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';
const SOL = 1_000_000_000n;
const BAG = 1_000_000n; // 1 SOL buys 1,000,000 tokens

type Sell = TradeRequest & { tokens: bigint };

class Market implements Executor {
  live = false;
  held = 0n;
  sells: { tokens: bigint; at: number }[] = [];
  attempts = 0;
  /** Decides each sell attempt: 'ok', 'fail', or a promise the test resolves later (an unconfirmed sell). */
  plan: (n: number, req: Sell) => 'ok' | 'fail' | Promise<'ok' | 'fail'> = () => 'ok';
  constructor(private readonly clock: () => number) {}
  async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    const tokens = (req.lamports * BAG) / SOL;
    this.held += tokens;
    return { ok: true, signature: 'B', tokens, lamports: req.lamports, simulated: !this.live, confirmedAt: this.clock() };
  }
  async sell(req: Sell): Promise<FillResult> {
    const n = ++this.attempts;
    const outcome = await this.plan(n, req);
    if (outcome === 'fail') return { ok: false, error: 'boom' };
    if (this.live && req.tokens > this.held) return { ok: false, error: 'insufficient tokens' };
    const tokens = req.tokens;
    this.held -= this.live ? tokens : 0n;
    this.sells.push({ tokens, at: this.clock() });
    return { ok: true, signature: `S${n}`, tokens, lamports: (tokens * SOL) / BAG, simulated: !this.live };
  }
  async quoteSell(_m: string, tokens: bigint) { return (tokens * SOL) / BAG; }
  async solBalance() { return 100n * SOL; }
  async tokenBalance() { return this.held; }
  isLive(r: { live: boolean }) { return r.live && this.live; }
}

function buyTrade(over: Partial<LeaderTrade> = {}): LeaderTrade {
  return { signature: `sig${Math.random()}`, leader: LEADER, mint: MINT, side: 'buy', solLamports: 2n * SOL, tokenAmount: 2_000_000n, tokensBefore: 0n, tokensAfter: 2_000_000n, venue: 'pumpfun', slot: 1, blockTime: null, ...over };
}
const sellTrade = (after: bigint) => buyTrade({ side: 'sell', slot: 2, tokensBefore: 2_000_000n, tokensAfter: after, tokenAmount: 2_000_000n - after });

let store: Store;
let ex: Market;
let clock: number;
let engine: Engine;
let uid: number;
const wallet = Keypair.generate();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  store = new Store(':memory:');
  clock = 1_000_000;
  ex = new Market(() => clock);
  uid = store.createUser('kol', 'x');
  store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
  engine = new Engine({ store, executor: ex, walletFor: () => wallet, now: () => clock, priceMs: 1e9, maxSolPerBuy: 10, feeReserveSol: 0.01, fastRetryMs: [0, 1, 1, 1, 1, 1], slowRetryMs: 1, zeroRecheckMs: 1 });
});

const scharo = (patch: Record<string, unknown> = {}) => store.createCopy(uid, validateSettings({ ...SCHARO, buySol: 1, ...patch }));
const open = () => store.activePositions(uid);
const feed = () => store.events(uid).map((e) => `${e.kind}: ${e.message}`);
async function at(seconds: number) { clock = 1_000_000 + seconds * 1000; await engine.tick(); await engine.idle(); }

describe('the timed exit of the original bag', () => {
  it('40 % of the bag at +2 s, 30 % at +4 s, the rest at +6 s; then the position is closed', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    expect(open()[0]).toMatchObject({ tokensBought: BAG, tokensHeld: BAG });
    await at(1.9);
    expect(ex.sells).toHaveLength(0);
    await at(2); await at(4); await at(6);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 300_000n, 300_000n]);
    expect(ex.sells.map((s) => (s.at - 1_000_000) / 1000)).toEqual([2, 4, 6]);
    expect(open()).toHaveLength(0);
    expect(store.closedPositions(uid)[0]).toMatchObject({ tokensHeld: 0n, proceedsLamports: SOL });
  });

  it('the timer starts at OUR confirmed buy, not at the leader\'s', async () => {
    scharo();
    const slowBuy = ex.buy.bind(ex);
    ex.buy = async (r) => { clock += 1500; return slowBuy(r); }; // our buy confirms 1.5 s after theirs
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await at(3.4); // 1.9 s after our buy
    expect(ex.sells).toHaveLength(0);
    await at(3.5);
    expect(ex.sells).toHaveLength(1);
  });

  it('price does not matter: the same sells whether the coin is up or down', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.quoteSell = async () => 1n; // worthless
    await at(2); await at(4); await at(6);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 300_000n, 300_000n]);
  });

  it('a step that is still unconfirmed does not hold up the next one', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let land!: (v: 'ok') => void;
    ex.plan = (n) => (n === 1 ? new Promise((r) => { land = r; }) : 'ok');
    clock = 1_002_000; await engine.tick(); await sleep(5);       // step 1 sent, not confirmed
    clock = 1_004_000; await engine.tick(); await sleep(5);       // step 2 goes out anyway
    expect(ex.sells.map((s) => s.tokens)).toEqual([300_000n]);
    land('ok'); await engine.idle();
    expect(ex.sells.map((s) => s.tokens).sort()).toEqual([300_000n, 400_000n]);
    await at(6);
    expect(ex.sells[2]!.tokens).toBe(300_000n);
    expect(open()).toHaveLength(0);
  });

  it('a failed sell is retried at once; later steps keep their own times', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = (n) => (n <= 2 ? 'fail' : 'ok'); // step 1 fails twice, then goes through
    await at(2);
    expect(ex.attempts).toBe(3);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n]);
    expect((ex.sells[0]!.at - 1_000_000) / 1000).toBe(2); // retried within the same moment, not on a later tick
    expect(feed().filter((f) => /retrying/.test(f))).toHaveLength(1);
    await at(4); await at(6);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 300_000n, 300_000n]);
  });

  it('the last step sells whatever is left, even when the earlier steps never went through', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = (_n, req) => (req.tokens === BAG ? 'ok' : 'fail'); // only the full-bag sell works
    await at(2); await at(4); await at(6);
    expect(ex.sells.map((s) => s.tokens)).toEqual([BAG]);
    expect(open()).toHaveLength(0);
  });

  it('the last step never gives up: a long outage only delays it, and the feed says it is still trying', async () => {
    // Seen live (27 Nov 2026): the RPC dropped for 90 s in the middle of an exit. The coins are still in the wallet,
    // so "gave up, use Sell now" is not an answer for someone who is not watching.
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await at(2); await at(4);
    let outage = 40; // far more failures than the quick retries allow
    ex.plan = () => (outage-- > 0 ? 'fail' : 'ok');
    await at(6);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 300_000n, 300_000n]);
    expect(open()).toHaveLength(0);
    expect(feed().filter((f) => /still trying/.test(f))).toHaveLength(1);
    expect(feed().some((f) => /Gave up/.test(f))).toBe(false);
  });

  it('an earlier step does give up after its quick retries: the last step sells what is left', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = (_n, req) => (req.tokens === 400_000n ? 'fail' : 'ok'); // the 40 % sell never works
    await at(2);
    expect(feed().filter((f) => /Gave up on the timed sell of 40% of the bag/.test(f))).toHaveLength(1);
    await at(4); await at(6);
    expect(ex.sells.map((s) => s.tokens)).toEqual([300_000n, 700_000n]);
    expect(open()).toHaveLength(0);
  });

  it('stopping the server ends the retries; after a restart the last step is still owed and goes out', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await at(2); await at(4);
    ex.plan = () => 'fail';
    clock = 1_000_000 + 6000;
    await engine.tick();
    await sleep(30);
    engine.stop();
    await engine.idle();
    expect(open()).toHaveLength(1); // still holding the last 30 %
    // The new process: same database, sells work again.
    ex.plan = () => 'ok';
    const restarted = new Engine({ store, executor: ex, walletFor: () => wallet, now: () => clock, priceMs: 1e9, maxSolPerBuy: 10, feeReserveSol: 0.01, fastRetryMs: [0, 1], slowRetryMs: 1 });
    await restarted.tick(); await restarted.idle();
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 300_000n, 300_000n]);
    expect(open()).toHaveLength(0);
  });

  it('the server knows when a short exit is in progress, so an update does not restart under it', async () => {
    scharo();
    expect(engine.exitsDueWithin(15_000)).toBe(false);
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    expect(engine.exitsDueWithin(15_000)).toBe(true); // steps at +2 s, +4 s and +6 s are owed
    await at(2); await at(4);
    expect(engine.exitsDueWithin(15_000)).toBe(true);
    await at(6);
    expect(engine.exitsDueWithin(15_000)).toBe(false);
    // A step that is far away does not hold a restart back.
    scharo({ name: 'slow', leader: 'GsJuHUtw6ni41HNgiycuAn4xeFw5GupsZUBPHgzW6PJR', sell: { ...(SCHARO.sell as object), timed: [{ afterSec: 600, percent: 100 }] } });
    await engine.onLeaderTrade(buyTrade({ leader: 'GsJuHUtw6ni41HNgiycuAn4xeFw5GupsZUBPHgzW6PJR', mint: 'So11111111111111111111111111111111111111112' })); await engine.idle();
    expect(open()).toHaveLength(1);
    expect(engine.exitsDueWithin(15_000)).toBe(false);
  });

  it('live: the last step sells the wallet\'s real balance; if an earlier sell lands first it retries with what is left', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await at(2);
    let landStep2!: (v: 'ok') => void;
    ex.plan = (n) => (n === 2 ? new Promise((r) => { landStep2 = r; }) : 'ok');
    clock = 1_004_000; await engine.tick(); await sleep(5);        // step 2 (30 %) in flight: balance still 600k
    let first = true;
    const realSell = ex.sell.bind(ex);
    ex.sell = async (req) => {                                       // the last step is built on 600k…
      if (first && req.tokens === 600_000n) { first = false; landStep2('ok'); await sleep(5); } // …then step 2 lands first
      return realSell(req);
    };
    clock = 1_006_000; await engine.tick(); await engine.idle();
    expect(ex.held).toBe(0n);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 300_000n, 300_000n]);
    expect(open()).toHaveLength(0);
  });

  it('test mode never sells more than the bag, even with steps overlapping', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    const gates: ((v: 'ok') => void)[] = [];
    ex.plan = () => new Promise((r) => { gates.push(r); });
    clock = 1_006_000; await engine.tick(); await sleep(10);        // all three due at once (e.g. after a restart)
    for (const g of gates) g('ok');
    await sleep(10); for (const g of gates) g('ok');
    await engine.idle(); await at(6.2); await sleep(10); for (const g of gates) g('ok'); await engine.idle();
    const total = ex.sells.reduce((a, s) => a + s.tokens, 0n);
    expect(total).toBe(BAG);
    expect(store.closedPositions(uid)[0]!.proceedsLamports).toBe(SOL);
  });

  it('every sell is logged with its time after the buy, the tokens sold and the SOL received', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await at(2);
    expect(feed()[0]).toMatch(/sell: Sold 40% of the bag of EYS1…pump \(Scharo\) for 0\.4 SOL — \+2\.0s after buy · 0\.4 tokens \(test\)/);
    await at(4); await at(6);
    expect(feed()[0]).toMatch(/Sold the rest of EYS1…pump \(Scharo\) for 0\.3 SOL — \+6\.0s after buy · 0\.3 tokens \(test\)\. Position closed\./);
  });
});

describe('sell only when they sell everything', () => {
  it('their partial sell is ignored; their full exit sells everything at once', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await engine.onLeaderTrade(sellTrade(1_500_000n)); await engine.idle();
    expect(ex.sells).toHaveLength(0);
    await engine.onLeaderTrade({ ...sellTrade(0n), signature: 'full' }); await engine.idle();
    expect(ex.sells.map((s) => s.tokens)).toEqual([BAG]);
    expect(open()).toHaveLength(0);
    await at(2); await at(4); await at(6); // the timer has nothing left to do
    expect(ex.sells).toHaveLength(1);
  });
});

describe('one position per coin', () => {
  it('the coin is not bought again while its exit is running, by this or another copy of the same user', async () => {
    scharo();
    store.createCopy(uid, validateSettings({ leader: 'GsJuHUtw6ni41HNgiycuAn4xeFw5GupsZUBPHgzW6PJR', buySol: 1, minLeaderBuySol: 0 }));
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await engine.onLeaderTrade(buyTrade({ leader: 'GsJuHUtw6ni41HNgiycuAn4xeFw5GupsZUBPHgzW6PJR' })); await engine.idle();
    expect(open()).toHaveLength(1);
    expect(feed().filter((f) => /already holding this coin/.test(f))).toHaveLength(2);
  });
  it('once the exit has finished the coin can be bought again', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await at(2); await at(4); await at(6);
    expect(open()).toHaveLength(0);
    await engine.onLeaderTrade(buyTrade({ slot: 50 })); await engine.idle();
    expect(open()).toHaveLength(1);
  });
});

describe('found by the review of 27 Nov 2026 (reading the wallet, overlapping sells, unknown outcomes)', () => {
  it('live: one stale "zero" from the wallet right after our buy does not close the position', async () => {
    // An RPC node one block behind answers 0 for a bag that is there: the position was closed with the whole bag
    // still in the wallet and nothing ever sold it.
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    const real = ex.tokenBalance.bind(ex);
    let stale = 1;
    ex.tokenBalance = async () => (stale-- > 0 ? 0n : real());
    await engine.onLeaderTrade(sellTrade(0n)); await engine.idle(); // their full exit: our sell reads the wallet first
    expect(ex.sells.map((x) => x.tokens)).toEqual([BAG]);
    expect(ex.held).toBe(0n);
    expect(open()).toHaveLength(0);
    expect(feed().some((f) => /sold elsewhere/.test(f))).toBe(false);
  });

  it('live: the last timed step also reads again before it believes the wallet is empty', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await at(2); await at(4);
    const real = ex.tokenBalance.bind(ex);
    let stale = 2;
    ex.tokenBalance = async () => (stale-- > 0 ? 0n : real());
    await at(6);
    expect(ex.held).toBe(0n);
    expect(ex.sells.map((x) => x.tokens)).toEqual([400_000n, 300_000n, 300_000n]);
  });

  it('live: a wallet that really is empty (three reads in a row) still closes the position', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.held = 0n; // sold by hand elsewhere
    await engine.onLeaderTrade(sellTrade(0n)); await engine.idle();
    expect(open()).toHaveLength(0);
    expect(feed().some((f) => /sold elsewhere/.test(f))).toBe(true);
    expect(ex.sells).toHaveLength(0);
  });

  it('live: their full exit while one of our timed sells is in flight sells the rest at once, not the tokens already on their way', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let release: () => void = () => undefined;
    ex.plan = (n) => (n === 1 ? new Promise((r) => { release = () => r('ok'); }) : 'ok'); // the +2 s sell stays in flight
    clock = 1_000_000 + 2000;
    await engine.tick();
    await sleep(5);
    const exit = engine.onLeaderTrade(sellTrade(0n));
    await sleep(20);
    expect(ex.sells.map((x) => x.tokens)).toEqual([600_000n]); // everything except the 40 % in flight, right away
    release();
    await exit; await engine.idle();
    expect(ex.sells.map((x) => x.tokens).sort()).toEqual([400_000n, 600_000n]);
    expect(ex.held).toBe(0n);
    expect(open()).toHaveLength(0);
  });

  it('Sell now tries again at once when the first attempt fails (one of our own sells landed in between)', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = (n) => (n === 1 ? 'fail' : 'ok');
    const r = await engine.sellNow(uid, open()[0]!.id);
    expect(r.ok).toBe(true);
    expect(ex.attempts).toBe(2);
    expect(open()).toHaveLength(0);
    expect(feed().some((f) => /failed/.test(f))).toBe(false);
  });

  it('Sell now that keeps failing says so once', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = () => 'fail';
    const r = await engine.sellNow(uid, open()[0]!.id);
    expect(r.ok).toBe(false);
    expect(ex.attempts).toBe(3);
    expect(feed().filter((f) => /Sell of .* failed/.test(f))).toHaveLength(1);
  });

  it('live: a buy whose fate could not be read is not thrown away: it waits and is settled from the wallet', async () => {
    ex.live = true;
    scharo();
    ex.buy = async () => { ex.held += 500_000n; return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true }; };
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    expect(store.openingPositions()).toHaveLength(1);
    expect(feed().some((f) => /not known yet/.test(f))).toBe(true);
    // the coin is not bought a second time meanwhile
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    expect(store.openingPositions()).toHaveLength(1);
    await engine.restore();
    expect(open()[0]).toMatchObject({ status: 'open', tokensHeld: 500_000n });
  });

  it('the coin is looked up while the wallet balance is read, not after', async () => {
    ex.live = true;
    scharo();
    const order: string[] = [];
    (ex as unknown as { warm: (m: string) => Promise<void> }).warm = async () => { order.push('warm'); };
    const bal = ex.solBalance.bind(ex);
    ex.solBalance = async () => { order.push('balance'); await sleep(5); order.push('balance done'); return bal(); };
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    expect(order.indexOf('warm')).toBeLessThan(order.indexOf('balance done'));
    expect(open()).toHaveLength(1);
  });
});
