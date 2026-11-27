// Restarts, shutdowns and crashes while sells are under way (the timing fuzzer's findings of 27 Nov 2026).
// An update restarts the server (src/server.ts shutdown: stop the engine, wait for what is under way, exit); a crash
// (kill -9, out of memory) exits at once. Each test plays the old process, then a new Engine on the same database.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Engine, type EngineDeps } from '../src/engine/engine.js';
import type { Executor, FillResult, TradeRequest } from '../src/engine/executor.js';
import { validateSettings } from '../src/engine/settings.js';
import { Store } from '../src/store.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const SOL = 1_000_000_000n;
const LEADER = 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih';
const MINT = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';
const OTHER = 'Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

type Sell = TradeRequest & { tokens: bigint };
/** 'lost-answer': it lands and the process never hears (it died meanwhile); 'gone': it never lands and nobody hears. */
type Outcome = 'ok' | 'fail' | 'unknown-landed' | 'unknown-lost' | 'lost-answer' | 'gone';

/** A wallet on a fake chain: 1 SOL buys 1,000,000 coins; a sell never takes more than the wallet holds. */
class Chain implements Executor {
  held = 0n;
  /** What a buy really puts in the wallet, and the count it is handed back with (the quote's, when the reads were slow). */
  receives = 1_000_000n;
  booked: bigint | null = null;
  /** Resolves the last buy's exact figures (when it was handed back with the quote's count). */
  exact: (v: { lamports: bigint; tokens: bigint }) => void = () => undefined;
  /** Every sell that went out: what it asked for and its signature. */
  sent: { tokens: bigint; sig: string }[] = [];
  /** Sells that changed the wallet, by signature (what settleSell reads). */
  landed = new Map<string, { tokens: bigint; lamports: bigint }>();
  /** Sells known to have failed on chain. */
  failed = new Set<string>();
  plan: (n: number, req: Sell) => Outcome | Promise<Outcome> = () => 'ok';
  quoteHold: Promise<void> | null = null;
  balanceHold: Promise<void> | null = null;
  solHold: Promise<void> | null = null;
  buys = 0;
  async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    this.buys++;
    if (this.test) return { ok: true, signature: 'PAPER_B', tokens: this.receives, lamports: req.lamports, simulated: true };
    req.onSigned?.(`B${this.buys}`);
    this.held += this.receives;
    const quoted = this.booked !== null && this.booked !== this.receives;
    const refine = quoted ? new Promise<{ lamports: bigint; tokens: bigint } | null>((res) => { this.exact = res; }) : undefined;
    return { ok: true, signature: 'BUY', tokens: quoted ? this.booked! : this.receives, lamports: req.lamports, simulated: false, ...(refine ? { refine } : {}) };
  }
  async sell(req: Sell): Promise<FillResult> {
    const sig = `S${this.sent.length + 1}`;
    this.sent.push({ tokens: req.tokens, sig });
    req.onSigned?.(sig);
    const outcome = await this.plan(this.sent.length, req);
    if (outcome === 'fail') { this.failed.add(sig); return { ok: false, error: 'boom' }; }
    if (!this.isLive(req)) return { ok: true, signature: `PAPER_${sig}`, tokens: req.tokens, lamports: req.tokens * 1_000n, simulated: true };
    if (outcome === 'unknown-lost') return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true };
    if (outcome === 'gone') return new Promise<never>(() => undefined);
    const tokens = req.tokens < this.held ? req.tokens : this.held;
    if (tokens <= 0n) { this.failed.add(sig); return { ok: false, error: 'the wallet holds none of this coin' }; }
    this.held -= tokens;
    this.landed.set(sig, { tokens, lamports: tokens * 1_000n });
    if (outcome === 'lost-answer') return new Promise<never>(() => undefined);
    if (outcome === 'unknown-landed') return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true };
    return { ok: true, signature: sig, tokens, lamports: tokens * 1_000n, simulated: false };
  }
  /** The RPC cannot be read (settleSell throws): an outcome stays unknown. */
  rpcDown = false;
  settled: string[] = [];
  async settleSell(sig: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' | 'not_found' }> {
    if (this.rpcDown) throw new Error('fetch failed');
    this.settled.push(sig);
    const l = this.landed.get(sig);
    if (l) return { state: 'landed', ...l };
    return this.failed.has(sig) ? { state: 'failed' } : { state: 'not_found' };
  }
  async quoteSell(_m: string, tokens: bigint) { if (this.quoteHold) await this.quoteHold; return tokens * 1_000n; }
  async solBalance() { if (this.solHold) await this.solHold; return 100n * SOL; }
  async tokenBalance() { if (this.balanceHold) await this.balanceHold; return this.held; }
  /** Test mode (the owner's Live switch off): trades are simulated. */
  test = false;
  isLive(r: { live: boolean }) { return r.live && !this.test; }
}

function server(sell: Record<string, unknown>, opts: Partial<EngineDeps> = {}) {
  const store = new Store(':memory:');
  const uid = store.createUser('u', 'x');
  const wallet = Keypair.generate();
  store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
  store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 1, minLeaderBuySol: 0, oncePerCoin: false, sell }));
  const chain = new Chain();
  let clock = 1_000_000;
  const start = () => new Engine({ store, executor: chain, walletFor: () => wallet, now: () => clock, priceMs: 1_000, maxSolPerBuy: 10, feeReserveSol: 0.01, zeroRecheckMs: 1, fastRetryMs: [0, 1, 1], slowRetryMs: 1, settleRetryMs: 1, ...opts });
  const s = {
    store, uid, chain, engine: start(),
    /** The update: the old process is stopped as src/server.ts does it; a new one starts on the same database. */
    restart: async () => { s.engine.stop(); await s.engine.idle(); s.engine = start(); },
    /** A crash: the old process is gone on the spot (whatever it was waiting for never comes back to it). */
    crash: () => { s.engine.stop(); s.engine = start(); },
    at: (ms: number) => { clock = 1_000_000 + ms; },
    tick: async () => { await s.engine.tick(); await s.engine.idle(); },
    buy: async (mint = MINT) => { await s.engine.onLeaderTrade(trade('buy', mint)); await s.engine.idle(); },
    their: (side: 'buy' | 'sell', after = 0n, mint = MINT) => s.engine.onLeaderTrade(trade(side, mint, after)),
    position: () => store.position(1)!,
    open: () => store.activePositions(uid),
    feed: () => store.events(uid, 100).map((e) => e.message),
  };
  return s;
}

let slot = 1;
function trade(side: 'buy' | 'sell', mint = MINT, after = 0n): LeaderTrade {
  return { signature: `L${slot}`, leader: LEADER, mint, side, solLamports: 2n * SOL, tokenAmount: 2_000_000n, tokensBefore: side === 'sell' ? 2_000_000n : 0n, tokensAfter: side === 'sell' ? after : 2_000_000n, venue: 'pumpfun', slot: slot++, blockTime: null };
}

const none = { mirror: { enabled: false, mode: 'exit' }, timedOf: 'left', timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } };

describe('a stopped engine starts no sell (fuzzer cases 20 and 21)', () => {
  it('a price check that comes back after the stop does not start the dead-coin sell; after the restart the rule is checked again', async () => {
    const s = server({ ...none, deadCoin: { enabled: true, idleSec: 5 } });
    await s.buy();
    const hold = gate();
    s.chain.quoteHold = hold.p;
    s.at(6_000);
    const tick = s.engine.tick(); // its price check is under way: the coin has not moved for 6 s
    await sleep(5);
    s.engine.stop();
    s.chain.quoteHold = null;
    hold.open(); await tick; await s.engine.idle(); await sleep(5);
    expect(s.chain.sent).toHaveLength(0); // it used to go out, and nobody booked it
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 1_000_000n });
    await s.restart();
    s.at(7_000); await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n, proceedsLamports: SOL });
  });

  it('the exact count arriving during the shutdown opens the position again but sends nothing: the rest is owed and sold after the restart', async () => {
    const s = server({ ...none, timed: [{ afterSec: 1, percent: 100 }] });
    s.chain.receives = 1_100_000n; s.chain.booked = 1_000_000n; // handed back with the quote's count
    await s.buy();
    s.at(1_000); await s.tick(); // the timed sell sells the 1,000,000 the books know: closed
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
    s.engine.stop(); // the update: the server waits for the last exact figures
    s.chain.exact({ lamports: SOL, tokens: 1_100_000n }); await sleep(5); await s.engine.idle();
    expect(s.chain.sent).toHaveLength(1); // the 100,000 more are not sold by the stopped engine
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 100_000n });
    expect(s.position().exitOwed).not.toBeNull();
    await s.restart();
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 100_000n]);
    expect(s.chain.held).toBe(0n);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  it('a sell queued behind another when the engine stops is not sent; their exit stays owed for the next start', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'exit' }, timed: [{ afterSec: 2, percent: 50 }] });
    await s.buy();
    const step = gate();
    s.chain.plan = (n) => (n === 1 ? step.p.then(() => 'ok' as const) : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5); // the +2 s sell is out
    void s.their('sell'); await sleep(5); // their exit waits behind it in the queue
    s.engine.stop();
    step.open(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([500_000n]);
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 500_000n });
    await s.restart();
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([500_000n, 500_000n]);
    expect(s.position().status).toBe('closed');
  });

  it('Sell now pressed while the server is shutting down is written down and sold after the restart', async () => {
    const s = server(none);
    await s.buy();
    s.engine.stop();
    const r = await s.engine.sellNow(s.uid, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/restarting/);
    await s.engine.idle();
    expect(s.chain.sent).toHaveLength(0);
    await s.restart();
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.position().status).toBe('closed');
  });

  it('Sell now pressed just before the stop, waiting behind another sell, gets its answer and a feed line, and is sold after the restart', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 50 }] });
    await s.buy();
    const step = gate();
    s.chain.plan = (n) => (n === 1 ? step.p.then(() => 'fail' as const) : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5); // the +2 s sell is out
    const pressed = s.engine.sellNow(s.uid, 1); await sleep(5); // Sell now waits behind it
    s.engine.stop();
    step.open();
    const r = await pressed; await s.engine.idle();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/restarting/);
    expect(s.feed().filter((m) => /you pressed Sell now\) did not go out: the server is restarting/.test(m))).toHaveLength(1);
    expect(s.chain.sent).toHaveLength(1);
    await s.restart();
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.held).toBe(0n);
    expect(s.position().status).toBe('closed');
  });

  it('their sell heard after the stop is written down (their exit is sold after the restart); their buy is not copied', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'exit' } });
    await s.buy();
    s.engine.stop();
    await s.their('sell'); await s.engine.idle();
    await s.their('buy', 0n, OTHER); await s.engine.idle();
    expect(s.chain.sent).toHaveLength(0);
    expect(s.open()).toHaveLength(1);
    await s.restart();
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.open()).toHaveLength(0);
  });

  it('the last timed step reading the wallet when the engine stops does not send; after the restart the clock fires it', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 100 }] });
    await s.buy();
    const read = gate();
    s.chain.balanceHold = read.p;
    s.at(2_000); void s.engine.tick(); await sleep(5); // the last step reads the wallet
    s.engine.stop();
    s.chain.balanceHold = null;
    read.open(); await s.engine.idle(); await sleep(5);
    expect(s.chain.sent).toHaveLength(0);
    await s.restart();
    s.at(30_000); await s.tick(); // overdue: it goes out at the first tick
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.position().status).toBe('closed');
  });

  it('a buy still waiting for the wallet\'s balance when the engine stops is not sent', async () => {
    const s = server(none);
    const read = gate();
    s.chain.solHold = read.p;
    void s.engine.onLeaderTrade(trade('buy')); await sleep(5);
    s.engine.stop();
    s.chain.solHold = null;
    read.open(); await s.engine.idle();
    expect(s.chain.buys).toBe(0);
    expect(s.open()).toHaveLength(0);
  });
});

describe('a sell is written down before it is sent; the next process settles one this one never heard of (fuzzer case 11)', () => {
  const bag = { ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 30 }, { afterSec: 6, percent: 100 }] };

  it('a crash while a timed step\'s sell is out and it landed: the next process books it from its own transaction, once', async () => {
    const s = server(bag);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'lost-answer' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5);
    expect(s.chain.held).toBe(600_000n); // it landed; the process never heard
    expect(s.store.sellsOut()).toHaveLength(1); // written down before it was sent
    s.crash();
    s.at(2_500); await s.tick(); // the step is due, its sell is still out: it does not go again
    expect(s.chain.sent).toHaveLength(1);
    await s.engine.restore(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 600_000n, proceedsLamports: 400_000_000n, firedTimed: [0] });
    expect(s.store.sellsOut()).toHaveLength(0);
    expect(s.store.fills(1).filter((f) => f.side === 'sell').map((f) => f.signature)).toEqual(['S1']);
    s.at(4_000); await s.tick(); s.at(6_000); await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 300_000n, 300_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n, proceedsLamports: SOL });
  });

  it('one that failed on chain is dropped at once and its step goes out again', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'gone' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5);
    s.crash();
    s.chain.failed.add('S1'); // the chain says it failed
    s.at(3_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
    await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 400_000n]);
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n, firedTimed: [0] });
  });

  it('one not found is kept while it can still land (its coin is not bought again meanwhile), then dropped', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 100 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'gone' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5); // the +2 s sell: stuck
    s.at(4_000); await s.engine.tick(); await sleep(5); // the last step sells all the wallet holds: closed, the stuck sell still out
    expect(s.position().status).toBe('closed');
    s.crash();
    s.at(5_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1); // not found yet: it may still land
    await s.buy(); // they buy the coin again: not copied while that sell can land (it would sell the new coins)
    expect(s.open()).toHaveLength(0);
    expect(s.feed().some((m) => /a sell of this coin is still on its way/.test(m))).toBe(true);
    s.at(2_000 + 181_000); await s.engine.restore(); await s.engine.idle(); // three minutes after it was sent
    expect(s.store.sellsOut()).toHaveLength(0);
    await s.buy();
    expect(s.open()).toHaveLength(1);
  });

  it('a restart while a sell\'s outcome is unknown: nothing else goes out, the row stays, the next process settles it first', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 25 }, { afterSec: 4, percent: 50 }, { afterSec: 60, percent: 100 }] });
    await s.buy();
    s.chain.rpcDown = true; // its outcome cannot be read
    s.chain.plan = (n) => (n === 1 ? 'unknown-landed' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(10);
    s.at(4_000); void s.engine.tick(); await sleep(5); // the +4 s step waits behind it
    await s.restart();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n]); // the stopping engine used to send the +4 s step
    expect(s.store.sellsOut()).toHaveLength(1);
    expect(s.feed().some((m) => /failed/.test(m))).toBe(false); // not a failure: it may well have landed
    s.chain.rpcDown = false;
    s.at(5_000); await s.tick(); // its step cannot go again while it is unsettled
    expect(s.chain.sent).toHaveLength(1);
    await s.engine.restore(); await s.engine.idle(); // it landed: booked from its own transaction
    expect(s.position()).toMatchObject({ tokensHeld: 750_000n, proceedsLamports: 250_000_000n, firedTimed: [0] });
    await s.tick(); // the +4 s step: half of what is left
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n, 375_000n]);
  });

  it('killed after the sell was answered, while the wallet was read: the next process books it', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'exit' } });
    await s.buy();
    s.chain.plan = () => { s.chain.balanceHold = new Promise(() => undefined); return 'ok'; }; // the read after it never ends
    void s.their('sell'); await sleep(5);
    expect(s.chain.held).toBe(0n);
    s.crash();
    s.chain.balanceHold = null;
    await s.engine.restore(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n, proceedsLamports: SOL });
    expect(s.chain.sent).toHaveLength(1);
  });

  it('Sell now while a sell from before the restart is not settled: it sells what is free, the rest is booked when that one is', async () => {
    const s = server(bag);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'lost-answer' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5);
    s.crash();
    const r = await s.engine.sellNow(s.uid, 1); await s.engine.idle();
    expect(r.ok).toBe(true);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 600_000n]);
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 400_000n }); // the 400,000 of the sell from before
    await s.engine.restore(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n, proceedsLamports: SOL });
  });

  it('an error while a sale that landed is booked: nothing is half booked, it is not sold again, the safety pass books it', async () => {
    const s = server(bag);
    await s.buy();
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'sell') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    s.at(2_000); await s.tick(); // the +2 s sell lands; its booking fails
    expect(s.chain.sent).toHaveLength(1);
    expect(s.position()).toMatchObject({ tokensHeld: 1_000_000n, proceedsLamports: 0n, firedTimed: [] }); // all or nothing
    s.at(2_500); await s.tick();
    expect(s.chain.sent).toHaveLength(1); // not sold a second time: it landed
    await s.engine.restore(); await s.engine.idle();
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n, proceedsLamports: 400_000_000n, firedTimed: [0] });
    expect(s.store.sellsOut()).toHaveLength(0);
  });

  it('this process\'s own sells are not settled by the safety pass while it waits for them', async () => {
    const s = server(bag);
    await s.buy();
    const step = gate();
    s.chain.plan = (n) => (n === 1 ? step.p.then(() => 'ok' as const) : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5);
    await s.engine.restore();
    expect(s.chain.settled).toEqual([]);
    step.open(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n, proceedsLamports: 400_000_000n });
  });

  it('nothing stays written down after sells that were booked or failed, and test sells are never written down', async () => {
    const s = server(bag);
    await s.buy();
    s.chain.plan = (n) => (n === 2 ? 'fail' : 'ok');
    s.at(2_000); await s.tick(); s.at(4_000); await s.tick(); s.at(6_000); await s.tick();
    expect(s.position().status).toBe('closed');
    expect(s.store.sellsOut()).toHaveLength(0);
    const t = server(bag);
    t.chain.test = true;
    await t.buy();
    t.chain.plan = () => 'gone';
    t.at(2_000); void t.engine.tick(); await sleep(5);
    expect(t.chain.sent).toHaveLength(1);
    expect(t.store.sellsOut()).toHaveLength(0);
  });
});

describe('databases written by earlier versions', () => {
  it('a database without the table of sells out opens and gets it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-store-'));
    const path = join(dir, 'old.db');
    const first = new Store(path);
    first.db.exec('DROP TABLE sells_out');
    first.close();
    const again = new Store(path);
    expect(again.sellsOut()).toEqual([]);
    again.insertSellOut({ signature: 'S', positionId: 1, userId: 1, mint: MINT, order: { reason: 'timed', percent: 40, stage: 0, basis: 'bag' }, tokens: 5n, sentAt: 7 });
    expect(again.sellsOut()).toEqual([{ signature: 'S', positionId: 1, userId: 1, mint: MINT, order: { reason: 'timed', percent: 40, stage: 0, basis: 'bag' }, tokens: 5n, sentAt: 7 }]);
    again.close();
  });
});

describe('their partial sell ("same share") is owed until it is done, across a restart (fuzzer case 19)', () => {
  const same = { ...none, mirror: { enabled: true, mode: 'same' } };
  const theySell = (s: ReturnType<typeof server>, left: bigint) => s.engine.onLeaderTrade({ ...trade('sell', MINT, left), tokenAmount: 2_000_000n - left });

  it('their 75 % sell that failed and waits for its retry is sold after a restart (it lived in memory only)', async () => {
    const s = server(same);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'fail' : 'ok'); // the RPC is rate limiting: it waits for its retry
    await theySell(s, 500_000n); await s.engine.idle(); // they sold 75 % of theirs
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([750_000n]);
    expect(s.position()).toMatchObject({ tokensHeld: 1_000_000n });
    expect(s.position().owedSells).toEqual([{ reason: 'mirror', percent: 75, tag: expect.any(String) }]);
    await s.restart();
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([750_000n, 750_000n]);
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 250_000n, owedSells: [] });
    await s.engine.restore(); await s.engine.idle(); // once: the next pass sells nothing more
    expect(s.chain.sent).toHaveLength(2);
  });

  it('one that went out before a crash and landed is booked, not sold again', async () => {
    const s = server(same);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'lost-answer' : 'ok');
    void theySell(s, 500_000n); await sleep(5);
    s.crash();
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent).toHaveLength(1);
    expect(s.position()).toMatchObject({ tokensHeld: 250_000n, proceedsLamports: 750_000_000n, owedSells: [] });
  });

  it('one that went out before a crash and did not land is sold once after it', async () => {
    const s = server(same);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'gone' : 'ok');
    void theySell(s, 500_000n); await sleep(5);
    s.crash();
    s.chain.failed.add('S1');
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([750_000n, 750_000n]);
    expect(s.position()).toMatchObject({ tokensHeld: 250_000n, owedSells: [] });
  });

  it('a sell that is done leaves nothing owed; one that gives up after its tries is not owed any more either', async () => {
    const s = server(same);
    await s.buy();
    await theySell(s, 1_000_000n); await s.engine.idle(); // they sold half: we sell half
    expect(s.position()).toMatchObject({ tokensHeld: 500_000n, owedSells: [] });
    s.chain.plan = () => 'fail';
    await theySell(s, 500_000n); await s.engine.idle(); // half of theirs again: it fails, and keeps failing
    for (let i = 0; i < 12; i++) { s.at(60_000 * (i + 1)); await s.tick(); }
    expect(s.feed().some((m) => /Gave up on/.test(m))).toBe(true);
    expect(s.position().owedSells).toEqual([]);
  });
});

describe('databases written by earlier versions (owed sells)', () => {
  it('a full exit owed in the old form still reads, and a database without the owed sells column opens and gets it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-store-'));
    const path = join(dir, 'old.db');
    const first = new Store(path);
    const uid = first.createUser('u', 'x');
    const id = first.insertPosition({ userId: uid, copyId: 1, mint: MINT, mode: 'live', leaderSig: 'L', sell: validateSettings({ leader: LEADER }).sell, copyName: 'c', leader: LEADER, now: 1 });
    first.db.exec('ALTER TABLE positions DROP COLUMN owed_sells');
    first.db.prepare('UPDATE positions SET exit_owed = ? WHERE id = ?').run('{"reason":"mirror","tag":"L1"}', id);
    first.close();
    const again = new Store(path);
    expect(again.position(id)).toMatchObject({ exitOwed: { reason: 'mirror', tag: 'L1' }, owedSells: [] });
    again.updatePosition(id, { owedSells: [{ reason: 'mirror', percent: 75, tag: 'L2' }] });
    expect(again.position(id)!.owedSells).toEqual([{ reason: 'mirror', percent: 75, tag: 'L2' }]);
    again.close();
  });
});
