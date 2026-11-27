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
  /** The owner's Live switch (off: no new real buys; sells of positions already bought for real still go out). */
  switchOn = true;
  requests: Sell[] = [];
  held = 0n;
  sells: { tokens: bigint; at: number }[] = [];
  attempts = 0;
  /** Decides each sell attempt: 'ok', 'fail', or a promise the test resolves later (an unconfirmed sell). */
  plan: (n: number, req: Sell) => 'ok' | 'fail' | 'unknown-landed' | 'unknown-lost' | Promise<'ok' | 'fail'> = () => 'ok';
  /** Sells that landed while their sender was told "outcome unknown", by signature (what settleSell reads). */
  landedUnknown = new Map<string, { tokens: bigint; lamports: bigint }>();
  async settleSell(signature: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' | 'not_found' }> {
    const hit = this.landedUnknown.get(signature);
    return hit ? { state: 'landed', ...hit } : { state: 'failed' };
  }
  /** At most this many tokens sell on attempt n (a curve that cannot pay for more); null = all asked for. */
  sellCap: (n: number, req: Sell) => bigint | null = () => null;
  /** Attempt n lands on chain the moment it is sent; the engine hears of it only when `plan` resolves. */
  landsAtOnce: (n: number, req: Sell) => boolean = () => false;
  /** Called on every wallet read (n counts them): lets a test act while the engine waits for the wallet. */
  balanceHook: ((n: number) => Promise<void> | void) | null = null;
  balanceReads = 0;
  constructor(private readonly clock: () => number) {}
  async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    const tokens = (req.lamports * BAG) / SOL;
    const real = this.live && this.switchOn;
    if (real) this.held += tokens;
    return { ok: true, signature: 'B', tokens, lamports: req.lamports, simulated: !real, confirmedAt: this.clock() };
  }
  async sell(req: Sell): Promise<FillResult> {
    this.requests.push(req);
    const n = ++this.attempts;
    req.onSigned?.(`S${n}`);
    if (this.landsAtOnce(n, req)) {
      if (this.live && req.tokens > this.held) return { ok: false, error: 'insufficient tokens' };
      this.held -= this.live ? req.tokens : 0n;
      this.sells.push({ tokens: req.tokens, at: this.clock() });
      await this.plan(n, req); // the confirmation reaches the engine only now
      return { ok: true, signature: `S${n}`, tokens: req.tokens, lamports: (req.tokens * SOL) / BAG, simulated: !this.live };
    }
    const outcome = await this.plan(n, req);
    if (outcome === 'fail') return { ok: false, error: 'boom' };
    if (outcome === 'unknown-lost') return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true };
    if (outcome === 'unknown-landed') {
      // It landed; nobody could tell the engine.
      this.held -= this.live ? req.tokens : 0n;
      this.sells.push({ tokens: req.tokens, at: this.clock() });
      this.landedUnknown.set(`S${n}`, { tokens: req.tokens, lamports: (req.tokens * SOL) / BAG });
      return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true };
    }
    if (this.live && req.tokens > this.held) return { ok: false, error: 'insufficient tokens' };
    const cap = this.sellCap(n, req);
    const tokens = cap !== null && cap < req.tokens ? cap : req.tokens;
    this.held -= this.live ? tokens : 0n;
    this.sells.push({ tokens, at: this.clock() });
    return { ok: true, signature: `S${n}`, tokens, lamports: (tokens * SOL) / BAG, simulated: !this.live };
  }
  async quoteSell(_m: string, tokens: bigint) { return (tokens * SOL) / BAG; }
  async solBalance() { return 100n * SOL; }
  async tokenBalance() { this.balanceReads++; await this.balanceHook?.(this.balanceReads); return this.held; }
  isLive(r: { live: boolean; exit?: boolean }) { return r.live && this.live && (this.switchOn || !!r.exit); }
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
    ex.buy = async (req) => { req.onSigned?.('SIGU'); ex.held += 500_000n; return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true }; };
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

describe('found by the review of the engine (27 Nov 2026)', () => {
  it('a timed step that comes due while their full exit is being sold stands down (nothing is sold twice)', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let release: () => void = () => undefined;
    ex.plan = (n) => (n === 1 ? new Promise((r) => { release = () => r('ok'); }) : 'ok'); // the exit stays in flight
    const exit = engine.onLeaderTrade(sellTrade(0n));
    await sleep(10);
    clock = 1_000_000 + 2000; await engine.tick(); await sleep(20); // step 1 comes due meanwhile
    expect(ex.attempts).toBe(1);
    release();
    await exit; await engine.idle();
    expect(ex.sells.map((x) => x.tokens)).toEqual([BAG]);
    expect(open()).toHaveLength(0);
  });

  it('their full exit overlapping a timed step: every SOL received is booked (the exit does not overwrite the step)', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    const gates: (() => void)[] = [];
    ex.plan = () => new Promise((r) => gates.push(() => r('ok')));
    clock = 1_000_000 + 2000;
    await engine.tick(); await sleep(5); // step 1 (40 %) in flight
    const exit = engine.onLeaderTrade(sellTrade(0n));
    await sleep(10); // the exit (60 %) in flight too
    expect(gates).toHaveLength(2);
    gates[0]!(); await sleep(10); // step 1 lands and is booked first
    gates[1]!(); await exit; await engine.idle();
    const pos = store.closedPositions(uid)[0]!;
    expect(pos.proceedsLamports).toBe(SOL); // 0.4 + 0.6 SOL
    expect(pos.tokensHeld).toBe(0n);
  });

  it('Live switched off: positions already bought with real SOL still sell, by their rules and with Sell now', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.switchOn = false; // the owner flips Live off
    await at(2);
    expect(ex.sells.map((x) => x.tokens)).toEqual([400_000n]);
    expect(ex.requests.every((r) => r.exit === true)).toBe(true);
    const r = await engine.sellNow(uid, open()[0]!.id);
    expect(r.ok).toBe(true);
    expect(ex.held).toBe(0n);
    // and no new real buy happens while it is off
    await engine.onLeaderTrade(buyTrade({ mint: 'Mint2222222222222222222222222222222222222222' })); await engine.idle();
    expect(store.activePositions(uid).filter((p) => p.mode === 'live')).toHaveLength(0);
  });

  it('a retry is checked (simulated) before it is sent, so a sell that cannot work costs nothing', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = (n) => (n === 1 ? 'fail' : 'ok');
    await at(2);
    expect(ex.requests.map((r) => !!r.checkFirst)).toEqual([false, true]);
  });

  it('a deleted copy\'s open position still sells with that copy\'s own fees and slippage', async () => {
    const id = scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    expect(store.deleteCopy(uid, id)).toBe(true);
    await at(2);
    expect(ex.requests[0]).toMatchObject({ slippagePct: 100, priorityFeeSol: 0.001, tipSol: 0.001 });
  });
});

describe('a buy cut short (crash, lost connection) is settled from its own transaction, not guessed', () => {
  // Velo writes every trade down with its signature the moment it is sent; the site only had "does the wallet hold
  // the coin", which counts coins the user already had and books the buy size as the cost.
  it('the signature is kept as soon as the buy is signed; restore reads that transaction for the exact bag and cost', async () => {
    ex.live = true;
    scharo();
    ex.held = 123n; // coins of this mint the user already had
    let signed = '';
    ex.buy = async (req) => { req.onSigned?.('BUYSIG1'); signed = 'BUYSIG1'; return { ok: false, error: 'sent, outcome unknown', uncertain: true }; };
    const settled: string[] = [];
    (ex as unknown as { settleBuy: unknown }).settleBuy = async (sig: string) => { settled.push(sig); return { state: 'landed', tokens: 900_000n, lamports: 1_010_000_000n }; };
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    expect(signed).toBe('BUYSIG1');
    expect(store.openingPositions()[0]!.buySig).toBe('BUYSIG1');
    await engine.restore();
    expect(settled).toEqual(['BUYSIG1']);
    expect(open()[0]).toMatchObject({ status: 'open', tokensBought: 900_000n, tokensHeld: 900_000n, costLamports: 1_010_000_000n });
  });

  it('a buy whose transaction failed, or never showed up before its blockhash ran out, is marked failed (the user\'s own coins are not taken for it)', async () => {
    ex.live = true;
    scharo();
    ex.held = 5_000n;
    ex.buy = async (req) => { req.onSigned?.('BUYSIG2'); return { ok: false, error: 'sent, outcome unknown', uncertain: true }; };
    let answer = 'not_found';
    (ex as unknown as { settleBuy: unknown }).settleBuy = async () => ({ state: answer });
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await engine.restore();
    expect(store.openingPositions()).toHaveLength(1); // too young to say
    clock += 120_000;
    await engine.restore();
    expect(store.openingPositions()).toHaveLength(0);
    expect(open()).toHaveLength(0);
    answer = 'failed';
  });
});

describe('the sell that empties the bag closes the coin\'s token account (its rent comes back)', () => {
  it('the last step and a full exit ask for it; partial steps and retries do not', async () => {
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = (n) => (n === 3 ? 'fail' : 'ok'); // the last step fails once, then is retried
    await at(2); await at(4); await at(6);
    expect(ex.requests.map((r) => [!!r.closeIfEmpty, !!r.checkFirst])).toEqual([[false, false], [false, false], [true, false], [true, true]]);
  });
});

describe('a sell of everything that the market could pay only part of (a mayhem curve short of SOL)', () => {
  it('the last timed step books what was sold and keeps going until the rest is sold too', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await at(2); await at(4);
    ex.sellCap = (n) => (n === 3 ? 200_000n : null); // the last step: only 200k of the 300k left could be paid for
    await at(6);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 300_000n, 200_000n, 100_000n]);
    expect(open()).toHaveLength(0);
    expect(store.closedPositions(uid)[0]).toMatchObject({ tokensHeld: 0n, proceedsLamports: SOL });
    expect(feed().filter((l) => /could pay for only part/.test(l))).toHaveLength(1);
  });

  it('their full exit sold only in part: the rest is sold on a later try, not left behind', async () => {
    ex.live = true;
    scharo({ sell: { ...SCHARO.sell, timed: [{ afterSec: 600, percent: 100 }] } });
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.sellCap = (n) => (n === 1 ? 600_000n : null);
    await engine.onLeaderTrade({ ...sellTrade(0n), signature: 'full' }); await engine.idle();
    expect(ex.sells.map((s) => s.tokens)).toEqual([600_000n]);
    expect(open()[0]).toMatchObject({ status: 'open', tokensHeld: 400_000n });
    expect(feed().some((l) => /could pay for only part/.test(l))).toBe(true);
    clock += 60_000; await engine.tick(); await engine.idle();
    expect(ex.sells.map((s) => s.tokens)).toEqual([600_000n, 400_000n]);
    expect(open()).toHaveLength(0);
  });
});

describe('a crash in the middle of a buy (found by reading Velo\'s history)', () => {
  it('with Live trading off the buy is written down as a test buy: after a restart it never turns into real sells of coins the wallet already held', async () => {
    ex.live = false;
    scharo();
    ex.buy = () => new Promise(() => undefined); // the server dies while the test buy is in flight
    void engine.onLeaderTrade(buyTrade());
    await sleep(5);
    expect(store.openingPositions()[0]).toMatchObject({ mode: 'paper' });
    ex.live = true; // the owner switches Live on before the restart
    ex.held = 5_000_000n; // the user's own coins of that mint
    const after = new Engine({ store, executor: ex, walletFor: () => wallet, now: () => clock, priceMs: 1e9, maxSolPerBuy: 10, feeReserveSol: 0.01, fastRetryMs: [0, 1, 1, 1, 1, 1], slowRetryMs: 1, zeroRecheckMs: 1 });
    await after.restore();
    for (const sec of [2, 4, 6]) { clock = 1_000_000 + sec * 1000; await after.tick(); await after.idle(); }
    expect(store.openingPositions()).toHaveLength(0);
    expect(open()).toHaveLength(0);
    expect(ex.sells).toHaveLength(0);
  });

  it('a live buy that was never signed (no signature written down) was never sent: it fails, the wallet\'s own coins are not taken for it', async () => {
    ex.live = true;
    scharo();
    ex.buy = () => new Promise(() => undefined); // dies before signing
    void engine.onLeaderTrade(buyTrade());
    await sleep(5);
    expect(store.openingPositions()[0]).toMatchObject({ mode: 'live', buySig: null });
    ex.held = 5_000_000n;
    const after = new Engine({ store, executor: ex, walletFor: () => wallet, now: () => clock, priceMs: 1e9, maxSolPerBuy: 10, feeReserveSol: 0.01, fastRetryMs: [0, 1, 1, 1, 1, 1], slowRetryMs: 1, zeroRecheckMs: 1 });
    await after.restore();
    expect(store.openingPositions()).toHaveLength(0);
    expect(open()).toHaveLength(0);
  });
});

describe('sells that overlap: one has landed on chain, the engine has not heard yet (found by the timing fuzzer)', () => {
  it('their full exit right after our +2 s sell landed sells everything left (it sold 20 % and left 40 % in the wallet for good)', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let confirm!: (v: 'ok') => void;
    ex.landsAtOnce = (n) => n === 1;
    ex.plan = (n) => (n === 1 ? new Promise((r) => { confirm = r; }) : 'ok');
    clock = 1_002_000; await engine.tick(); await sleep(5); // the +2 s sell has landed; its confirmation is slow
    expect(ex.held).toBe(600_000n);
    await engine.onLeaderTrade({ ...sellTrade(0n), signature: 'out' }); await sleep(5);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 600_000n]); // everything that was left
    confirm('ok'); await engine.idle();
    expect(ex.held).toBe(0n);
    expect(open()).toHaveLength(0);
    expect(store.closedPositions(uid)[0]).toMatchObject({ tokensHeld: 0n, proceedsLamports: SOL });
  });

  it('Sell now right after our +2 s sell landed sells everything left too', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let confirm!: (v: 'ok') => void;
    ex.landsAtOnce = (n) => n === 1;
    ex.plan = (n) => (n === 1 ? new Promise((r) => { confirm = r; }) : 'ok');
    clock = 1_002_000; await engine.tick(); await sleep(5);
    const r = await engine.sellNow(uid, open()[0]!.id);
    expect(r.ok).toBe(true);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 600_000n]);
    confirm('ok'); await engine.idle();
    expect(ex.held).toBe(0n);
    expect(store.closedPositions(uid)[0]).toMatchObject({ tokensHeld: 0n, proceedsLamports: SOL });
  });

  it('a stop loss and a timed step at once: the position is not closed with coins still in the wallet, the later step sells them', async () => {
    ex.live = true;
    store.createCopy(uid, validateSettings({ ...SCHARO, buySol: 1, sell: { mirror: { enabled: false, mode: 'same' }, timedOf: 'bag', timed: [{ afterSec: 2, percent: 50 }, { afterSec: 60, percent: 100 }], stopLoss: [{ lossPct: 20, percent: 50 }], deadCoin: { enabled: false, idleSec: 120 } } }));
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let confirm!: (v: 'ok') => void;
    ex.landsAtOnce = (n) => n === 1;
    ex.plan = (n) => (n === 1 ? new Promise((r) => { confirm = r; }) : 'ok');
    clock = 1_002_000; await engine.tick(); await sleep(5); // the +2 s step (500k) landed, not confirmed
    ex.quoteSell = async (_m, tokens) => (tokens * SOL * 7n) / (BAG * 10n); // down 30 %
    (engine as unknown as { lastQuoteAt: Map<number, number> }).lastQuoteAt.set(open()[0]!.id, -1e12); // price checked now
    clock = 1_003_000; await engine.tick(); await sleep(5); // the stop loss sells half of what is free
    expect(ex.sells.map((s) => s.tokens)).toEqual([500_000n, 250_000n]);
    confirm('ok'); await sleep(5); await engine.idle();
    expect(open()[0]).toMatchObject({ status: 'open', tokensHeld: 250_000n });
    clock = 1_060_000; await engine.tick(); await engine.idle();
    expect(ex.held).toBe(0n);
    expect(open()).toHaveLength(0);
  });

  it('a sell booked while another one waits for the wallet keeps its SOL (the other no longer overwrites it)', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let confirm!: (v: 'ok') => void;
    ex.landsAtOnce = (n) => n === 1;
    ex.plan = (n) => (n === 1 ? new Promise((r) => { confirm = r; }) : 'ok');
    clock = 1_002_000; await engine.tick(); await sleep(5);
    // Their exit: its sell confirms at once; while the engine reads the wallet after it, our +2 s sell is booked.
    const start = ex.balanceReads;
    ex.balanceHook = async (n) => { if (n === start + 2) { confirm('ok'); await sleep(10); } };
    await engine.onLeaderTrade({ ...sellTrade(0n), signature: 'out' }); await sleep(30); await engine.idle();
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 600_000n]);
    expect(store.closedPositions(uid)[0]).toMatchObject({ tokensHeld: 0n, proceedsLamports: SOL });
  });

  it('a sell still on its way after the position closed: the coin is not bought again until it has landed or failed', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let settle!: (v: 'ok' | 'fail') => void;
    ex.plan = (n) => (n === 1 ? new Promise((r) => { settle = r; }) : 'ok'); // the +2 s sell is stuck
    for (const sec of [2, 4, 6]) { clock = 1_000_000 + sec * 1000; await engine.tick(); await sleep(5); } // the last step sells all the wallet holds
    expect(open()).toHaveLength(0);
    await engine.onLeaderTrade(buyTrade({ slot: 10 })); await sleep(5);
    expect(open()).toHaveLength(0);
    expect(feed().some((l) => /a sell of this coin is still on its way/.test(l))).toBe(true);
    settle('ok'); await engine.idle(); // it fails (nothing left) or lands: either way it is over
    await engine.onLeaderTrade(buyTrade({ slot: 11 })); await engine.idle();
    expect(open()).toHaveLength(1);
  });

  it('their sell while our buy\'s outcome is unknown is not dropped: it runs once the buy is settled', async () => {
    ex.live = true;
    store.createCopy(uid, validateSettings({ ...SCHARO, buySol: 1, sell: { mirror: { enabled: true, mode: 'all' }, timedOf: 'left', timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } } }));
    ex.buy = async (req) => { req.onSigned?.('BUYSIG'); ex.held += BAG; return { ok: false, error: 'sent, outcome unknown', uncertain: true }; };
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    await engine.onLeaderTrade({ ...sellTrade(1_000_000n), signature: 'half' }); await engine.idle(); // they sell half
    expect(ex.sells).toHaveLength(0);
    await engine.restore(); await engine.idle(); // the buy is settled: it landed
    expect(ex.sells.map((s) => s.tokens)).toEqual([BAG]);
    expect(open()).toHaveLength(0);
  });
});

describe('a sell whose outcome nobody could tell us (found by the timing fuzzer)', () => {
  it('it is settled from its own transaction: landed, it is booked and never sold a second time', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = (n) => (n === 1 ? 'unknown-landed' : 'ok');
    await at(2); await at(4); await at(6);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n, 300_000n, 300_000n]); // not 400k twice
    expect(open()).toHaveLength(0);
    const closed = store.closedPositions(uid)[0]!;
    expect(closed).toMatchObject({ tokensHeld: 0n, proceedsLamports: SOL }); // the first sale's SOL is booked
  });

  it('it did not land: it is retried like any failed sell', async () => {
    ex.live = true;
    scharo();
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    ex.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok');
    await at(2);
    expect(ex.sells.map((s) => s.tokens)).toEqual([400_000n]); // the retry sold it
    await at(4); await at(6);
    expect(ex.held).toBe(0n);
    expect(store.closedPositions(uid)[0]).toMatchObject({ tokensHeld: 0n, proceedsLamports: SOL });
  });
});

describe('test mode: the last step of a timed exit waits for a step that is still trying (found by the timing fuzzer)', () => {
  it('when the +2 s step gives up after the last step ran, the last step sells what it left', async () => {
    store.createCopy(uid, validateSettings({ ...SCHARO, buySol: 1, sell: { mirror: { enabled: false, mode: 'same' }, timedOf: 'bag', timed: [{ afterSec: 2, percent: 50 }, { afterSec: 4, percent: 100 }], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } } }));
    await engine.onLeaderTrade(buyTrade()); await engine.idle();
    let fails = 0;
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    // The +2 s step's tries all fail; its first try is slow, so it is "out" when the last step comes due.
    ex.plan = (_n, req) => {
      if (req.closeIfEmpty || fails >= 100) return 'ok'; // the last step (it asks to close the account) goes through
      fails++;
      return fails === 1 ? slow.then(() => 'fail' as const) : 'fail';
    };
    clock = 1_002_000; await engine.tick(); await sleep(5);
    clock = 1_004_000; await engine.tick(); await sleep(5); // the last step sells the half that is not out
    release();
    await engine.idle(); // the +2 s step gives up; the last step then sells the rest
    expect(ex.sells.reduce((a, s) => a + s.tokens, 0n)).toBe(BAG);
    expect(open()).toHaveLength(0);
  });
});
