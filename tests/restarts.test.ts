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
  /** What one coin is worth (lamports): what the price check values the bag at. */
  price = 1_000n;
  /** The chain's block height now, and the height up to which each sell's blockhash is valid (told with its signature). */
  height = 0;
  lastValid = 100;
  /** The market can pay for at most this many coins per sell (the executor says so: marketShort). */
  marketCap: bigint | null = null;
  /** A sell takes at most this many coins for another reason (the wallet held fewer when the executor read it). */
  underfill: bigint | null = null;
  /** Sells are answered with the quote's SOL (2.5 % under), their exact SOL following when sellExact() is called. */
  quoteLow = false;
  private exactSells: (() => void)[] = [];
  sellExact() { for (const f of this.exactSells.splice(0)) f(); }
  async blockHeight() { return this.height; }
  /** Every sell the engine asked for, sent or not. */
  calls = 0;
  async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    this.buys++;
    if (this.test) return { ok: true, signature: 'PAPER_B', tokens: this.receives, lamports: req.lamports, simulated: true };
    // As the real executor: a trade that cannot be written down is not sent.
    // (told with its blockhash's last valid height and the platform fee it carries, as the real one is)
    const fee = (req.lamports * BigInt(req.feeBps ?? 0)) / 10_000n;
    try { req.onSigned?.(`B${this.buys}`, { lastValidBlockHeight: this.lastValid, feeLamports: fee }); } catch (err) { return { ok: false, error: `could not write it down before sending it (${(err as Error).message}): nothing was sent` }; }
    this.held += this.receives;
    const quoted = this.booked !== null && this.booked !== this.receives;
    const refine = quoted ? new Promise<{ lamports: bigint; tokens: bigint } | null>((res) => { this.exact = res; }) : undefined;
    return { ok: true, signature: 'BUY', tokens: quoted ? this.booked! : this.receives, lamports: req.lamports, simulated: false, ...(refine ? { refine } : {}) };
  }
  async sell(req: Sell): Promise<FillResult> {
    this.calls++;
    const sig = `S${this.sent.length + 1}`;
    // The platform fee rides in the transaction (1 SOL per 1,000,000 coins): told with the signature, as the real one is.
    const fee = (req.tokens * 1_000n * BigInt(req.feeBps ?? 0)) / 10_000n;
    const marketShort = this.marketCap !== null && this.marketCap < (req.tokens < this.held ? req.tokens : this.held);
    // As the real executor: a sell that cannot be written down is not sent.
    try { req.onSigned?.(sig, { lastValidBlockHeight: this.lastValid, feeLamports: fee, marketShort }); } catch (err) { return { ok: false, error: `could not write it down before sending it (${(err as Error).message}): nothing was sent, the coins are still in the wallet` }; }
    this.sent.push({ tokens: req.tokens, sig });
    const outcome = await this.plan(this.sent.length, req);
    if (outcome === 'fail') { this.failed.add(sig); return { ok: false, error: 'boom' }; }
    if (!this.isLive(req)) return { ok: true, signature: `PAPER_${sig}`, tokens: req.tokens, lamports: req.tokens * 1_000n, simulated: true };
    if (outcome === 'unknown-lost') return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true };
    if (outcome === 'gone') return new Promise<never>(() => undefined);
    let tokens = req.tokens < this.held ? req.tokens : this.held;
    if (this.marketCap !== null && tokens > this.marketCap) tokens = this.marketCap;
    if (this.underfill !== null && tokens > this.underfill) tokens = this.underfill;
    if (tokens <= 0n) { this.failed.add(sig); return { ok: false, error: 'the wallet holds none of this coin' }; }
    this.held -= tokens;
    this.landed.set(sig, { tokens, lamports: tokens * 1_000n });
    if (outcome === 'lost-answer') return new Promise<never>(() => undefined);
    if (outcome === 'unknown-landed') return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true };
    const exact = tokens * 1_000n;
    if (this.quoteLow) {
      const refine = new Promise<{ lamports: bigint } | null>((res) => { this.exactSells.push(() => res({ lamports: exact })); });
      return { ok: true, signature: sig, tokens, lamports: exact - exact / 40n, simulated: false, feeLamports: fee, marketShort, refine };
    }
    return { ok: true, signature: sig, tokens, lamports: exact, simulated: false, feeLamports: fee, marketShort };
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
  async quoteSell(_m: string, tokens: bigint) { if (this.quoteHold) await this.quoteHold; return tokens * this.price; }
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
    s.chain.height = 132; // the chain well past the last block it could land in (an executor that does not tell slots)
    s.at(2_000 + 70_000); await s.engine.restore(); await s.engine.idle();
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
    expect(s.feed().some((m) => /failed/.test(m))).toBe(false); // it did not fail: it sold
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

// ── the reviewers of those fixes (27 Nov 2026): what they found still open ─────────────────────────────────────────
describe('the coins beyond a quote, sold after the position was closed on the quote\'s count', () => {
  it('the rest of a Sell now found by the exact count is tried again until it sells (its first try failed; the feed said "every 30 s")', async () => {
    const s = server(none);
    s.chain.booked = 1_000_000n; s.chain.receives = 1_100_000n; // the buy is handed back with the quote's count
    await s.buy();
    expect(await s.engine.sellNow(s.uid, 1)).toMatchObject({ ok: true });
    await s.engine.idle();
    expect(s.position().status).toBe('closed');
    s.chain.plan = () => 'fail'; // the RPC fails the rest's first try
    s.chain.exact({ lamports: SOL, tokens: 1_100_000n }); await sleep(5); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 100_000n });
    expect(s.feed().some((m) => /tried again every 30 s until it sells/.test(m))).toBe(true);
    s.chain.plan = () => 'ok';
    s.at(30_000); await s.engine.restore(); await s.engine.idle(); // the settling pass
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 100_000n, 100_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  it('after a crash while that sell was out and it did not land, the next process sells them', async () => {
    const s = server({ ...none, timed: [{ afterSec: 1, percent: 100 }] });
    s.chain.booked = 1_000_000n; s.chain.receives = 1_100_000n;
    await s.buy();
    s.at(1_000); await s.tick(); // the timed exit sells the quote's count and closes
    expect(s.position().status).toBe('closed');
    s.chain.plan = () => 'gone';
    s.chain.exact({ lamports: SOL, tokens: 1_100_000n }); await sleep(5); // opened again: the rest goes out, then the process dies
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 100_000n]);
    s.crash();
    s.chain.failed.add('S2'); // it did not land
    s.chain.plan = () => 'ok';
    s.at(40_000); await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 100_000n, 100_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });
});

describe('a sell from before a crash that is not settled yet', () => {
  const exit = { ...none, mirror: { enabled: true, mode: 'exit' } };

  it('Sell now while all of it is in that sell: the answer and the feed say so (it used to answer "Sold" with nothing sold)', async () => {
    const s = server(exit);
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5); // their exit: our sell is signed and written down, and the process dies
    s.crash();
    s.chain.plan = () => 'ok';
    const r = await s.engine.sellNow(s.uid, 1); await s.engine.idle();
    expect(r).toMatchObject({ ok: true, note: expect.stringMatching(/sent just before the server restarted/) });
    expect(s.feed().some((m) => /you pressed Sell now/.test(m) && /sent just before the server restarted/.test(m))).toBe(true);
    expect(s.chain.sent).toHaveLength(1);
  });

  /** The executor tells the slot each read was answered at: the chain's tip (height and slot, from one node), and the
   *  slot of the node that answered a status (`statusSlot`: by default as far along as the tip). */
  function slotted(s: ReturnType<typeof server>, statusSlot: (n: number) => number = () => 1_000 + s.chain.height) {
    const chain = s.chain as unknown as { chainTip: () => Promise<{ height: number; slot: number }>; settleSell: (sig: string) => Promise<Record<string, unknown>> };
    chain.chainTip = async () => ({ height: s.chain.height, slot: 1_000 + s.chain.height });
    const settle = chain.settleSell.bind(s.chain);
    let n = 0;
    chain.settleSell = async (sig: string) => { const r = await settle(sig); return r.state === 'not_found' ? { ...r, slot: statusSlot(++n) } : r; };
  }

  it('is dropped as soon as its blockhash has run out (it can never land), not three minutes after it was sent', async () => {
    const s = server(exit);
    slotted(s);
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5);
    s.crash();
    s.chain.plan = () => 'ok';
    s.chain.height = 60; // its blockhash is valid up to 100
    s.at(10_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1); // it may still land
    s.chain.height = 101; // the last block it can still land in (the chain takes a blockhash one block longer than the height it is said to be valid up to)
    s.at(44_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    s.chain.height = 111; // past it, within the few blocks of margin
    s.at(48_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    s.chain.height = 112; // run out, and the margin with it (about 4 s)
    s.at(49_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 1_000_000n]); // their exit is sold now
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  it('is not dropped when its status came from a node behind the one that gave the height: a sale that landed in its last blocks is booked, not sold again', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }] });
    slotted(s, (n) => (n === 1 ? 1_000 + 95 : 1_000 + s.chain.height)); // the first status read: a node seven slots behind the tip
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'lost-answer' : 'ok'); // the +2 s sell lands in its last blocks; the process dies first
    s.at(2_000); void s.engine.tick(); await sleep(5);
    s.crash();
    s.chain.height = 120;
    const landed = s.chain.landed.get('S1')!;
    s.chain.landed.delete('S1'); // the lagging node has not seen it land
    s.at(62_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1); // kept: that "not found" proves nothing
    s.chain.landed.set('S1', landed);
    s.at(67_000); await s.engine.settleLeftovers(); await s.engine.idle(); await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n]); // the step did not sell again
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n, proceedsLamports: 400_000_000n, firedTimed: [0] });
    expect(s.store.fills(1).filter((f) => f.side === 'sell').map((f) => f.signature)).toEqual(['S1']);
  });

  it('with an executor that does not tell the slots, it is dropped only well past its last valid height (two reads may come from two nodes)', async () => {
    const s = server(exit);
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5);
    s.crash();
    s.chain.plan = () => 'ok';
    s.chain.height = 110; // past it, but one node may be some blocks behind the other
    s.at(45_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    s.chain.height = 131; // one block short of well past: a node 30 blocks behind may not have seen it land yet
    s.at(56_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    s.chain.height = 132; // well past it (about 12 s)
    s.at(57_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 1_000_000n]);
  });

  it('a "not found" that does not say how far along its node was is believed only well past its last block, though the tip tells its slot', async () => {
    const s = server(exit);
    (s.chain as unknown as { chainTip: () => Promise<{ height: number; slot: number }> }).chainTip = async () => ({ height: s.chain.height, slot: 1_000 + s.chain.height });
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5);
    s.crash();
    s.chain.plan = () => 'ok';
    s.chain.height = 112; // past its last block and the margin: a "not found" from a node that far along would drop it
    s.at(50_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    s.chain.height = 131;
    s.at(57_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    s.chain.height = 132;
    s.at(58_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
  });

  it('on a slow chain it is kept past three minutes while the tip says it can still land, and booked when it does (it was dropped at 180 s and its step sold again)', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 900, percent: 100 }] });
    slotted(s);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'gone' : 'ok'); // the +2 s step is sent; the process dies before its outcome is known
    s.at(2_000); void s.engine.tick(); await sleep(5);
    s.crash();
    s.chain.height = 80; // a slow chain: over three minutes on, its blockhash (valid up to 100) can still land
    s.at(200_000); await s.engine.restore(); await s.engine.idle(); await s.tick();
    expect(s.store.sellsOut()).toHaveLength(1);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n]);
    s.chain.landed.set('S1', { tokens: 400_000n, lamports: 400_000_000n }); s.chain.held -= 400_000n; // it lands
    s.chain.height = 90;
    s.at(205_000); await s.engine.settleLeftovers(); await s.engine.idle(); await s.tick();
    expect(s.store.fills(1).filter((f) => f.side === 'sell').map((f) => f.signature)).toEqual(['S1']);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n]); // not sold again
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n, firedTimed: [0] });
  });

  it('is dropped ten minutes after it was sent even when the tip still says it could land (a tip that never moves)', async () => {
    const s = server(exit);
    slotted(s);
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5);
    s.crash();
    s.chain.plan = () => 'ok';
    s.chain.height = 80;
    s.at(599_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    s.at(601_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 1_000_000n]); // their exit is sold now
  });

  it('an error after its booking was written does not book it a second time on the next pass', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'lost-answer' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5);
    s.crash();
    const addEvent = s.store.addEvent.bind(s.store);
    let broken = true;
    s.store.addEvent = (e) => { if (broken && e.kind === 'sell') { broken = false; throw new Error('disk I/O error'); } return addEvent(e); };
    await s.engine.restore().catch(() => undefined); await s.engine.idle();
    s.at(32_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.fills(1).filter((f) => f.side === 'sell')).toHaveLength(1);
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n, proceedsLamports: 400_000_000n });
  });

  it('a sell booked from its own transaction records its platform fee, as one booked at once does', async () => {
    const s = server(exit, { feeBpsFor: () => 100 });
    await s.buy();
    s.chain.plan = () => 'lost-answer';
    void s.their('sell'); await sleep(5);
    s.crash();
    await s.engine.restore(); await s.engine.idle();
    expect(s.store.fills(1).find((f) => f.side === 'sell')).toMatchObject({ signature: 'S1', feeLamports: 10_000_000n });
    const t = server(exit, { feeBpsFor: () => 100 });
    await t.buy();
    t.chain.plan = () => 'unknown-landed'; // the RPC did not answer; its own transaction did
    await t.their('sell'); await t.engine.idle();
    expect(t.store.fills(1).find((f) => f.side === 'sell')).toMatchObject({ signature: 'S1', feeLamports: 10_000_000n });
  });

  it('a stop loss level that comes due while the position waits for it is sold once it is settled, though the price came back', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }], stopLoss: [{ lossPct: 30, percent: 100 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'gone' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5);
    s.crash();
    s.chain.price = 500n; s.at(3_000); await s.tick(); // the coin halves meanwhile
    expect(s.chain.sent).toHaveLength(1);
    s.chain.price = 1_000n; s.at(5_000); await s.tick(); // and comes back
    s.chain.failed.add('S1');
    s.at(6_000); await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 1_000_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', firedStop: [0] });
  });
});

describe('a trade whose outcome is unknown, on a slow chain or past its last block', () => {
  const bag = { ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 900, percent: 100 }] };
  const exitOnly = { ...none, mirror: { enabled: true, mode: 'exit' } };
  /** The executor tells the chain tip's slot, and a "not found" carries a slot as far along as the tip. */
  function slottedTip(s: ReturnType<typeof server>) {
    const chain = s.chain as unknown as { chainTip: () => Promise<{ height: number; slot: number }>; settleSell: (sig: string) => Promise<Record<string, unknown>> };
    chain.chainTip = async () => ({ height: s.chain.height, slot: 1_000 + s.chain.height });
    const settle = chain.settleSell.bind(s.chain);
    chain.settleSell = async (sig: string) => { const r = await settle(sig); return r.state === 'not_found' ? { ...r, slot: 1_000 + s.chain.height } : r; };
  }

  it('a sell is not called "never landed" while its blockhash can still land, and is booked when it lands (it was given up at 120 s and its step sold again)', async () => {
    const s = server(bag);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok'); // nobody could tell whether the +2 s step landed
    s.chain.height = 10;
    s.at(2_000); void s.engine.tick(); await sleep(10);
    s.at(200_000); await sleep(30); // over three minutes on, on a slow chain: its blockhash (valid up to 100) can still land
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n]); // not given up, not sold again
    s.chain.landed.set('S1', { tokens: 400_000n, lamports: 400_000_000n }); s.chain.held -= 400_000n; // it lands
    s.chain.height = 60;
    await sleep(30);
    expect(s.store.fills(1).filter((f) => f.side === 'sell').map((f) => f.signature)).toEqual(['S1']);
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n, proceedsLamports: 400_000_000n });
    expect(s.chain.sent).toHaveLength(1);
    s.engine.stop();
  });

  it('a sell that never lands is called so once the chain is past its last block, without waiting two minutes', async () => {
    const s = server(bag);
    slottedTip(s);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok');
    s.chain.height = 50;
    s.at(2_000); void s.engine.tick(); await sleep(10);
    expect(s.chain.sent).toHaveLength(1); // it may still land
    s.chain.height = 112; // past its last block and the margin, on the word of a node as far along: it never can
    await sleep(30);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 400_000n]); // told at once (the clock did not move): the step sold again
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n });
    s.engine.stop();
  });

  it('with an executor that cannot read the chain tip, a sell is still given up two minutes after it was sent', async () => {
    const s = server(bag);
    (s.chain as unknown as { blockHeight?: unknown }).blockHeight = undefined;
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(10);
    s.at(100_000); await sleep(20);
    expect(s.chain.sent).toHaveLength(1);
    s.at(123_000); await sleep(30);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 400_000n]);
    s.engine.stop();
  });

  it('a sell is not given up when a read of the chain tip fails on a slow chain: the highest tip read before stands in (the two-minute timer came back)', async () => {
    const s = server(bag);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok');
    s.chain.height = 10;
    s.at(2_000); void s.engine.tick(); await sleep(10); // the tip is read (10): its blockhash, valid up to 100, can land
    const read = s.chain.blockHeight.bind(s.chain);
    s.chain.blockHeight = async () => { throw new Error('429 Too Many Requests'); };
    s.at(200_000); await sleep(30); // over three minutes on, every tip read fails
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n]); // not given up, not sold again
    s.chain.blockHeight = read;
    s.chain.landed.set('S1', { tokens: 400_000n, lamports: 400_000_000n }); s.chain.held -= 400_000n; // it lands
    await sleep(30);
    expect(s.store.fills(1).filter((f) => f.side === 'sell').map((f) => f.signature)).toEqual(['S1']);
    expect(s.chain.sent).toHaveLength(1);
    s.engine.stop();
  });

  it('a sell whose tip reads have all failed is given up only ten minutes after it was sent, not on a timer meant for an executor that cannot read the tip', async () => {
    const s = server(bag);
    s.chain.blockHeight = async () => { throw new Error('429 Too Many Requests'); };
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(10);
    s.at(300_000); await sleep(30);
    expect(s.chain.sent).toHaveLength(1);
    s.at(603_000); await sleep(30);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 400_000n]);
    s.engine.stop();
  });

  it('a sell whose outcome is unknown says so in the feed while it is read (the position waited minutes with nothing said)', async () => {
    const s = server(bag);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok');
    s.chain.height = 10;
    s.at(2_000); void s.engine.tick(); await sleep(10);
    expect(s.feed().some((m) => /outcome is not known yet/.test(m) && /tried again/.test(m))).toBe(true);
    expect(s.feed().some((m) => /failed/.test(m))).toBe(false); // not a failure: it may well have landed
    s.engine.stop();
  });

  it('a sell left by a crash is not dropped when a read of the chain tip fails after three minutes (the 180 s timer came back)', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 900, percent: 100 }] });
    slottedTip(s);
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'gone' : 'ok');
    s.at(2_000); void s.engine.tick(); await sleep(5);
    s.crash();
    s.chain.height = 80;
    s.at(200_000); await s.engine.restore(); await s.engine.idle(); // the tip is read: 80, its blockhash (valid up to 100) can land
    const chain = s.chain as unknown as { chainTip: () => Promise<unknown> };
    chain.chainTip = async () => { throw new Error('fetch failed'); };
    s.at(205_000); await s.engine.settleLeftovers(); await s.engine.idle(); await s.tick();
    expect(s.store.sellsOut()).toHaveLength(1);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n]);
  });

  it('a buy of unknown outcome is not marked failed when a read of the chain tip fails (its coins would stay unsold)', async () => {
    const s = server(none);
    const chain = s.chain as unknown as { chainTip: () => Promise<unknown> };
    chain.chainTip = async () => ({ height: s.chain.height, slot: 1_000 + s.chain.height });
    unknownBuy(s);
    s.chain.height = 50;
    await s.buy();
    s.at(100_000); await s.engine.restore(); await s.engine.idle(); // the tip is read: 50
    chain.chainTip = async () => { throw new Error('fetch failed'); };
    s.at(200_000); await s.engine.restore(); await s.engine.idle();
    expect(s.position().status).toBe('opening');
  });

  it('a sell left by a crash is believed not found from exactly the slot its last block can have at the latest, not one slot earlier', async () => {
    const s = server(exitOnly);
    const chain = s.chain as unknown as { chainTip: () => Promise<{ height: number; slot: number }>; settleSell: (sig: string) => Promise<Record<string, unknown>> };
    chain.chainTip = async () => ({ height: 112, slot: 1_112 }); // the block of height 101 (its last) has a slot no later than 1,112 - 11 = 1,101
    let statusSlot = 1_100;
    const settle = chain.settleSell.bind(s.chain);
    chain.settleSell = async (sig: string) => { const r = await settle(sig); return r.state === 'not_found' ? { ...r, slot: statusSlot } : r; };
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5);
    s.crash();
    s.chain.plan = () => 'ok';
    s.at(50_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1); // a node at slot 1,100 may not have reached block 101
    statusSlot = 1_101;
    s.at(55_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
  });

  it('the highest chain tip read stands in for a read that fails, or for a node that answers lower: a sell left by a crash is settled as soon as its status node has caught up', async () => {
    const s = server(exitOnly);
    const chain = s.chain as unknown as { chainTip: () => Promise<{ height: number; slot: number }>; settleSell: (sig: string) => Promise<Record<string, unknown>> };
    let tip: (() => Promise<{ height: number; slot: number }>) = async () => ({ height: 140, slot: 1_140 });
    chain.chainTip = () => tip();
    let statusSlot = 1_050; // the status node is far behind
    const settle = chain.settleSell.bind(s.chain);
    chain.settleSell = async (sig: string) => { const r = await settle(sig); return r.state === 'not_found' ? { ...r, slot: statusSlot } : r; };
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5);
    s.crash();
    s.chain.plan = () => 'ok';
    s.at(60_000); await s.engine.restore(); await s.engine.idle(); // the tip is read: 140
    expect(s.store.sellsOut()).toHaveLength(1);
    statusSlot = 1_140; // the status node has caught up; the tip read now fails
    tip = async () => { throw new Error('fetch failed'); };
    s.at(65_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
  });

  it('a buy this process saw land, whose booking failed, is never marked failed on a "not found" (a lagging node; its coins would stay unsold)', async () => {
    const s = server(none);
    const chain = s.chain as unknown as { chainTip: () => Promise<unknown>; settleBuy: (sig: string) => Promise<unknown> };
    chain.chainTip = async () => ({ height: s.chain.height, slot: 1_000 + s.chain.height });
    let caughtUp = false;
    chain.settleBuy = async () => (caughtUp ? { state: 'landed', tokens: 1_000_000n, lamports: SOL } : { state: 'not_found', slot: 1_000 + s.chain.height });
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'buy') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    await s.buy(); // it landed (B1, valid up to 100); its booking failed
    expect(s.position()).toMatchObject({ status: 'opening', buySig: 'B1' });
    s.chain.height = 140; // well past its last block, and the node says "not found" from the tip's slot
    s.at(5_000); await s.engine.settleLeftovers(); await s.engine.idle();
    expect(s.position().status).toBe('opening');
    caughtUp = true;
    s.at(10_000); await s.engine.settleLeftovers(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 1_000_000n });
  });

  it('Sell now pressed while a sell of the position\'s queue has an unknown outcome answers at once, and sells right after it (it showed "Selling…" until the chain moved, up to ten minutes)', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 40 }, { afterSec: 900, percent: 100 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok'); // the +2 s step: nobody can tell whether it landed
    s.chain.height = 80; // its blockhash (valid up to 100) can still land: its outcome is read until the chain says
    s.at(2_000); void s.engine.tick(); await sleep(10);
    const press = s.engine.sellNow(s.uid, 1);
    const answer = await Promise.race([press, sleep(50).then(() => 'still waiting' as const)]);
    expect(answer).toMatchObject({ ok: true, note: expect.stringMatching(/outcome is being read/) });
    expect(s.feed().some((m) => /you pressed Sell now/.test(m) && /goes out right after it/.test(m))).toBe(true);
    s.chain.height = 132; // well past its last block: it never landed
    await sleep(40);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 1_000_000n]); // the press sold everything right after it
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
    s.engine.stop();
  });

  it('the chain tip is read before the status, for a sell of unknown outcome and for a sell left by a crash (the rule needs a tip read before the status: one read after could be past the margin while the status node missed the sale)', async () => {
    const s = server(bag);
    const order: string[] = [];
    const chain = s.chain as unknown as { chainTip: () => Promise<unknown>; settleSell: (sig: string) => Promise<Record<string, unknown>> };
    chain.chainTip = async () => { order.push('tip'); return { height: s.chain.height, slot: 1_000 + s.chain.height }; };
    const settle = chain.settleSell.bind(s.chain);
    chain.settleSell = async (sig: string) => { order.push('status'); const r = await settle(sig); return r.state === 'not_found' ? { ...r, slot: 1_000 + s.chain.height } : r; };
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : n === 2 ? 'gone' : 'ok');
    s.chain.height = 50;
    s.at(2_000); void s.engine.tick(); await sleep(10); // the +2 s step: its outcome is read
    expect(order.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < order.length; i += 2) expect(order.slice(i, i + 2)).toEqual(i + 1 < order.length ? ['tip', 'status'] : ['tip']);
    s.chain.height = 112; // it never landed: the step sells again (S2), and the process dies while that one is out
    await sleep(20);
    s.crash();
    order.length = 0;
    s.at(60_000); await s.engine.restore(); await s.engine.idle();
    expect(order[0]).toBe('tip');
    expect(order).toContain('status');
    expect(order.indexOf('tip')).toBeLessThan(order.indexOf('status'));
    s.engine.stop();
  });

  it('the settling pass reads the chain tip once, not once for every buy it settles', async () => {
    const s = server(none);
    const chain = s.chain as unknown as { chainTip: () => Promise<unknown> };
    let reads = 0;
    chain.chainTip = async () => { reads++; return { height: s.chain.height, slot: 1_000 + s.chain.height }; };
    unknownBuy(s);
    s.chain.height = 50;
    await s.buy();
    await s.buy(OTHER);
    expect(s.store.activePositions().filter((p) => p.status === 'opening')).toHaveLength(2);
    reads = 0;
    s.at(20_000); await s.engine.restore(); await s.engine.idle();
    expect(reads).toBe(1);
  });

  /** A buy whose outcome nobody could tell: signed (its blockhash valid up to height 100) and left "opening". */
  function unknownBuy(s: ReturnType<typeof server>) {
    const chain = s.chain as unknown as { buy: (req: { onSigned?: (sig: string, info: unknown) => void }) => Promise<unknown>; settleBuy: (sig: string) => Promise<unknown> };
    chain.buy = async (req) => { req.onSigned?.('B1', { lastValidBlockHeight: 100, feeLamports: 0n }); return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true }; };
    const state = { landed: false };
    chain.settleBuy = async () => (state.landed ? { state: 'landed', tokens: 1_000_000n, lamports: SOL } : { state: 'not_found', slot: 1_000 + s.chain.height });
    return state;
  }

  it('a buy is not marked failed while its blockhash can still land, and is booked when it lands (it was marked failed after 90 s and its coins were never sold)', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 100 }] });
    const buy = unknownBuy(s);
    s.chain.height = 10;
    await s.buy();
    expect(s.position()).toMatchObject({ status: 'opening', buySig: 'B1' });
    s.at(200_000); await s.engine.restore(); await s.engine.idle(); // a slow chain: its blockhash can still land
    expect(s.position().status).toBe('opening');
    buy.landed = true; s.chain.held += 1_000_000n; s.chain.height = 60; // it lands
    s.at(205_000); await s.engine.restore(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 1_000_000n });
    s.at(207_000); await s.tick(); // its exit counts from its late confirmation: the +2 s step sells
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
  });

  it('a buy that never lands is marked failed once the chain is past its last block, without waiting 90 s', async () => {
    const s = server(none);
    (s.chain as unknown as { chainTip: () => Promise<{ height: number; slot: number }> }).chainTip = async () => ({ height: s.chain.height, slot: 1_000 + s.chain.height });
    unknownBuy(s);
    s.chain.height = 50;
    await s.buy();
    s.at(20_000); await s.engine.restore(); await s.engine.idle();
    expect(s.position().status).toBe('opening'); // it may still land
    s.chain.height = 112;
    s.at(30_000); await s.engine.restore(); await s.engine.idle();
    expect(s.position().status).toBe('failed');
  });
});

describe('a booking that fails after the sale landed', () => {
  it('their partial sell ("same share") is sold once, not again by its retry once the safety pass books it', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'same' } });
    await s.buy();
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'sell') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    await s.engine.onLeaderTrade({ ...trade('sell', MINT, 1_000_000n), tokenAmount: 1_000_000n }); await s.engine.idle(); // they sold half of theirs
    s.at(1_000); await s.tick(); s.at(2_000); await s.tick();
    await s.engine.restore(); await s.engine.idle();
    s.at(3_000); await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([500_000n]);
    expect(s.position()).toMatchObject({ tokensHeld: 500_000n, proceedsLamports: 500_000_000n, owedSells: [] });
    expect(s.feed().some((m) => /failed/.test(m))).toBe(false); // it did not fail: it sold
  });

  it('a timed step of the bag: its exact SOL is not applied to a booking that was undone (the books and the fill agree)', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }] });
    await s.buy();
    s.chain.quoteLow = true;
    const addEvent = s.store.addEvent.bind(s.store);
    let broken = true;
    s.store.addEvent = (e) => { if (broken && e.kind === 'sell') { broken = false; throw new Error('disk I/O error'); } return addEvent(e); };
    s.at(2_000); await s.tick();
    s.chain.sellExact(); await sleep(5);
    await s.engine.restore(); await s.engine.idle();
    const sells = s.store.fills(1).filter((f) => f.side === 'sell');
    expect(sells).toHaveLength(1);
    expect(s.position().proceedsLamports).toBe(sells[0]!.lamports);
    expect(s.position()).toMatchObject({ tokensHeld: 600_000n, proceedsLamports: 400_000_000n });
  });
});

describe('the safety pass', () => {
  it('two passes at once settle a buy of unknown outcome once (one "recovered" line, one buy)', async () => {
    const s = server(none);
    const id = s.store.insertPosition({ userId: s.uid, copyId: 1, mint: MINT, mode: 'live', leaderSig: 'L', sell: validateSettings({ leader: LEADER, sell: none }).sell, copyName: 'c', leader: LEADER, now: 1_000_000 });
    s.store.updatePosition(id, { buySig: 'B9' });
    s.chain.held = 1_000_000n;
    const hold = gate();
    s.chain.balanceHold = hold.p;
    const a = s.engine.restore();
    const b = s.engine.restore(); // the 30 s pass while the start's pass still waits on a slow RPC
    await sleep(5);
    s.chain.balanceHold = null; hold.open();
    await a; await b; await s.engine.idle();
    expect(s.feed().filter((m) => /recovered/.test(m))).toHaveLength(1);
  });
});

describe('a stop loss level whose sell was waiting when the engine stopped', () => {
  it('is sold after the restart, though the price is no longer past it', async () => {
    const s = server({ ...none, stopLoss: [{ lossPct: 20, percent: 25 }, { lossPct: 30, percent: 90 }] });
    await s.buy();
    const step = gate();
    s.chain.plan = (n) => (n === 1 ? step.p.then(() => 'ok' as const) : 'ok');
    s.chain.price = 500n; // the coin halves: both levels are due; the −20 % sell goes out, the −30 % waits behind it
    s.at(2_000); void s.engine.tick(); await sleep(5);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n]);
    const r = s.restart(); step.open(); await r; // an update restarts the server meanwhile
    expect(s.chain.sent).toHaveLength(1); // the stopping engine sends nothing
    s.chain.price = 750n; // −25 %: the −30 % level is no longer passed
    s.at(5_000); await s.engine.restore(); await s.engine.idle(); await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n, 675_000n]);
    expect(s.position().firedStop).toEqual([0, 1]);
  });
});

describe('their partial sell heard while our buy\'s outcome is unknown', () => {
  it('survives a restart before the buy is settled, and is sold once', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'same' } });
    const id = s.store.insertPosition({ userId: s.uid, copyId: 1, mint: MINT, mode: 'live', leaderSig: 'L', sell: validateSettings({ leader: LEADER, sell: { ...none, mirror: { enabled: true, mode: 'same' } } }).sell, copyName: 'c', leader: LEADER, now: 1_000_000 });
    s.store.updatePosition(id, { buySig: 'B9' });
    s.chain.held = 1_000_000n;
    await s.engine.onLeaderTrade({ ...trade('sell', MINT, 1_000_000n), tokenAmount: 1_000_000n }); await s.engine.idle();
    expect(s.chain.sent).toHaveLength(0); // kept: the buy is not settled
    await s.restart();
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([500_000n]);
    await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent).toHaveLength(1);
  });
});

describe('the feed line of a full exit that sold only part', () => {
  const exit = { ...none, mirror: { enabled: true, mode: 'exit' } };

  it('says the market could pay for only part when the market capped it (and the rest is sold later)', async () => {
    const s = server(exit);
    await s.buy();
    s.chain.marketCap = 400_000n;
    await s.their('sell'); await s.engine.idle();
    expect(s.feed().some((m) => /could pay for only part/.test(m))).toBe(true);
    s.chain.marketCap = null;
    s.at(20_000); await s.tick();
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  it('does not say so when the sell took fewer for another reason; the rest is sold right after', async () => {
    const s = server(exit);
    await s.buy();
    s.chain.underfill = 400_000n;
    s.chain.plan = (n) => { if (n > 1) s.chain.underfill = null; return 'ok'; }; // only the first sell takes fewer
    await s.their('sell'); await s.engine.idle(); await s.tick();
    expect(s.feed().some((m) => /could pay for only part/.test(m))).toBe(false);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 600_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });
});

describe('databases written by earlier versions (sells out)', () => {
  it('a table of sells out without the blockhash, fee and market columns opens and gets them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-store-'));
    const path = join(dir, 'old.db');
    const first = new Store(path);
    first.db.exec('DROP TABLE sells_out');
    first.db.exec('CREATE TABLE sells_out (signature TEXT PRIMARY KEY, position_id INTEGER NOT NULL, user_id INTEGER NOT NULL, mint TEXT NOT NULL, sell_order TEXT NOT NULL, tokens INTEGER NOT NULL, sent_at INTEGER NOT NULL)');
    first.db.prepare('INSERT INTO sells_out VALUES (?, ?, ?, ?, ?, ?, ?)').run('OLD', 1, 1, MINT, '{"reason":"mirror","percent":100}', 5, 7);
    first.close();
    const again = new Store(path);
    expect(again.sellsOut()).toEqual([{ signature: 'OLD', positionId: 1, userId: 1, mint: MINT, order: { reason: 'mirror', percent: 100 }, tokens: 5n, sentAt: 7 }]);
    again.insertSellOut({ signature: 'NEW', positionId: 1, userId: 1, mint: MINT, order: { reason: 'manual', percent: 100 }, tokens: 9n, sentAt: 8, lastValid: 300, feeLamports: 12n, marketShort: true });
    expect(again.sellsOut()[1]).toMatchObject({ signature: 'NEW', lastValid: 300, feeLamports: 12n, marketShort: true });
    again.close();
  });
});

describe('a stop loss level held while a position waits for a sell from before a restart (fuzzer, ghost seed 1916)', () => {
  it('survives a second restart, though the price came back and was stored in between', async () => {
    const s = server({ ...none, stopLoss: [{ lossPct: 20, percent: 25 }, { lossPct: 30, percent: 90 }] });
    await s.buy();
    s.chain.rpcDown = true; // outcomes cannot be read
    s.chain.plan = (n) => (n === 1 ? 'unknown-lost' : 'ok');
    s.chain.price = 500n; // −50 %: the −20 % sell goes out (its outcome stays unknown), the −30 % waits behind it
    s.at(2_000); void s.engine.tick(); await sleep(10);
    await s.restart(); // an update: the first stays written down
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n]);
    s.at(3_000); await s.tick(); // the new process waits for that sell: both levels are held
    s.chain.price = 750n; s.at(5_000); await s.tick(); // the price comes back to −25 %, and is stored
    await s.restart(); // another update before that sell is settled: what was held in memory is gone
    s.chain.rpcDown = false; s.chain.failed.add('S1'); // it did not land
    s.at(6_000); await s.engine.restore(); await s.engine.idle(); await s.tick(); await s.engine.restore(); await s.engine.idle();
    // −20 %: sold (it is still passed); −30 %: it came due before, sold too, after it
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n, 250_000n, 675_000n]);
    expect(s.position()).toMatchObject({ firedStop: [0, 1], owedSells: [] });
  });
});

/** A full disk: every write of the store fails as SQLite's do ("database or disk is full"); reads go on working. */
function diskFull(store: Store): { on: () => void; off: () => void } {
  const st = store as unknown as { run: (...a: unknown[]) => unknown };
  const run = st.run.bind(store);
  let full = false;
  st.run = (...a: unknown[]) => {
    if (full) throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    return run(...a);
  };
  return { on: () => { full = true; }, off: () => { full = false; } };
}

describe('a database that cannot be written (a full disk)', () => {
  it('a timed exit that comes due sends nothing, is tried again on its own pauses (not on every tick), and sells once when the disk is back', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 100 }] });
    await s.buy();
    const disk = diskFull(s.store);
    disk.on();
    for (let t = 2_000; t <= 4_000; t += 200) { s.at(t); await s.tick(); }
    expect(s.chain.sent).toHaveLength(0); // it could not be written down: not sent
    expect(s.chain.calls).toBeLessThanOrEqual(3); // at +2 s, then on its retries (250 ms, 1 s later)
    disk.off();
    for (let t = 4_200; t <= 10_000; t += 200) { s.at(t); await s.tick(); }
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n, proceedsLamports: SOL });
    expect(s.store.fills(1).filter((f) => f.side === 'sell')).toHaveLength(1);
  });

  it('a timed step of the bag keeps to its own pauses while its failure line cannot be written (it was tried again on every tick)', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }] }, { fastRetryMs: [0, 40, 40, 40] });
    await s.buy();
    const disk = diskFull(s.store);
    disk.on();
    // the clock ticks every 10 ms (the server's every 200 ms, quicker), without waiting for the step
    for (let i = 0; i < 10; i++) { s.at(2_000 + i * 200); void s.engine.tick(); await sleep(10); }
    expect(s.chain.sent).toHaveLength(0);
    expect(s.chain.calls).toBeLessThanOrEqual(5); // one run of the step: its first try and its four retries
    await s.engine.idle();
    disk.off();
    s.at(4_000); await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n]); // sold once, when the disk is back
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 600_000n, proceedsLamports: 400_000_000n, firedTimed: [0] });
    expect(s.store.fills(1).filter((f) => f.side === 'sell').map((f) => f.signature)).toEqual(['S1']);
  });

  it('Sell now sends nothing and says why; pressed again once the disk is back, it sells', async () => {
    const s = server(none);
    await s.buy();
    const disk = diskFull(s.store);
    disk.on();
    const r = await s.engine.sellNow(s.uid, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot save to its database/);
    expect(r.error).toMatch(/nothing was sent, the coins are still in the wallet/);
    expect(s.chain.sent).toHaveLength(0);
    disk.off();
    expect(await s.engine.sellNow(s.uid, 1)).toEqual({ ok: true });
    await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', proceedsLamports: SOL });
  });

  it('a buy that landed but could not be booked stays "opening" and is booked from its own transaction (it was marked failed: its coins were never sold)', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 100 }] });
    (s.chain as unknown as { settleBuy: (sig: string) => Promise<unknown> }).settleBuy = async (sig: string) => (sig === 'B1' ? { state: 'landed', tokens: 1_000_000n, lamports: SOL } : { state: 'not_found' });
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'buy') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    await s.buy();
    expect(s.chain.held).toBe(1_000_000n); // it landed
    expect(s.position()).toMatchObject({ status: 'opening', buySig: 'B1' }); // not half booked, not failed
    await s.engine.restore(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 1_000_000n, costLamports: SOL });
    expect(s.store.fills(1).filter((f) => f.side === 'buy')).toHaveLength(1);
    s.at(10_000); await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.position().status).toBe('closed');
  });

  it('a buy that landed but could not be booked is booked by the 5 s pass, its timed sells counting from the buy (they waited for the 30 s pass, then counted from it)', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 100 }] });
    (s.chain as unknown as { settleBuy: () => Promise<unknown> }).settleBuy = async () => ({ state: 'landed', tokens: 1_000_000n, lamports: SOL });
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'buy') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    await s.buy(); // at +0 s
    expect(s.position().status).toBe('opening');
    expect(s.engine.awaitingLeftovers()).toBe(true); // the server's 5 s pass runs
    s.at(5_000); await s.engine.settleLeftovers(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'open', openedAt: 1_000_000 }); // the buy's own time
    expect(s.engine.awaitingLeftovers()).toBe(false);
    await s.tick(); // +5 s: the +2 s step is overdue, it goes now
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.feed().some((m) => /written down a few seconds late/.test(m))).toBe(true);
  });

  it('a buy whose feed line cannot be written stays open and is sold by its rules (it was marked failed after it was booked)', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 100 }] });
    const addEvent = s.store.addEvent.bind(s.store);
    let broken = true;
    s.store.addEvent = (e) => { if (broken && e.kind === 'buy') { broken = false; throw new Error('disk I/O error'); } return addEvent(e); };
    await s.buy();
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 1_000_000n });
    s.at(2_000); await s.tick();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', proceedsLamports: SOL });
  });
});

describe('Sell now\'s answer', () => {
  const CLOSED = 'Nothing was left to sell: the position was closed just before.';

  it('pressed while their exit is out: it waits behind it, and answers that nothing was left (it answered "position is not open", an error)', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'exit' } });
    await s.buy();
    const out = gate();
    s.chain.plan = (n) => (n === 1 ? out.p.then(() => 'ok' as const) : 'ok');
    void s.their('sell'); await sleep(5); // their exit's sell of everything is out
    const press = s.engine.sellNow(s.uid, 1);
    await sleep(5); out.open();
    expect(await press).toEqual({ ok: true, note: CLOSED });
    await s.engine.idle();
    expect(s.chain.sent).toHaveLength(1);
    expect(s.position()).toMatchObject({ status: 'closed', proceedsLamports: SOL });
  });

  it('pressed on a position closed a moment before (the page not refreshed yet): the same answer, not "no open position"', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'exit' } });
    await s.buy();
    await s.their('sell'); await s.engine.idle();
    expect(s.position().status).toBe('closed');
    expect(await s.engine.sellNow(s.uid, 1)).toEqual({ ok: true, note: CLOSED });
    expect(await s.engine.sellNow(s.uid + 1, 1)).toEqual({ ok: false, error: 'no open position with that id' }); // not theirs
  });

  it('its own sale landed but could not be booked at once: "Sold", tried once, booked within seconds (it was tried again and answered as not sold)', async () => {
    const s = server(none);
    await s.buy();
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'sell') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    expect(await s.engine.sellNow(s.uid, 1)).toEqual({ ok: true, note: 'Sold: it shows in the feed and History once the server has written it down (normally within seconds).' });
    expect(s.chain.calls).toBe(1);
    await s.engine.settleLeftovers(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'closed', proceedsLamports: SOL });
    expect(s.feed().some((m) => /failed|did not go through/.test(m))).toBe(false);
  });

  it('every coin in a sale of ours that landed and is being written down: says it was sold (not "if it did not go through")', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 100 }] });
    await s.buy();
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'sell') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    s.at(2_000); await s.tick(); // the step sells everything; its booking fails
    expect(await s.engine.sellNow(s.uid, 1)).toEqual({ ok: true, note: 'All of it was just sold by another sell of ours: it shows once the server has written it down (normally within seconds).' });
    await s.engine.settleLeftovers(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'closed', proceedsLamports: SOL });
    expect(s.chain.sent).toHaveLength(1);
  });
});

describe('exact figures that cannot be written whole', () => {
  it('a sell\'s exact SOL: neither its fill nor the proceeds take it, and the safety pass applies both (they agree)', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }] });
    (s.chain as unknown as { settleBuy: () => Promise<unknown> }).settleBuy = async () => ({ state: 'not_found' });
    await s.buy();
    s.chain.quoteLow = true;
    s.at(2_000); await s.tick(); // 40 % sold, booked at the quote (2.5 % under)
    const updatePosition = s.store.updatePosition.bind(s.store);
    let broken = true;
    s.store.updatePosition = (id, patch) => { if (broken && patch.proceedsLamports !== undefined) { broken = false; throw new Error('disk I/O error'); } return updatePosition(id, patch); };
    s.chain.sellExact(); await sleep(5);
    const fill = () => s.store.fills(1).find((f) => f.side === 'sell')!;
    expect(fill().lamports).toBe(s.position().proceedsLamports); // the fill took it alone, for good
    await s.engine.restore(); await s.engine.idle();
    expect(fill().lamports).toBe(400_000_000n);
    expect(s.position().proceedsLamports).toBe(400_000_000n);
  });

  it('a buy\'s exact coins and SOL: none of them is written when one write fails, and the safety pass applies them all', async () => {
    const s = server({ ...none, timed: [{ afterSec: 600, percent: 100 }] });
    (s.chain as unknown as { settleBuy: () => Promise<unknown> }).settleBuy = async () => ({ state: 'landed', tokens: 1_100_000n, lamports: 1_005_000_000n });
    s.chain.receives = 1_100_000n; s.chain.booked = 1_000_000n; // handed back with the quote's count
    await s.buy();
    const updatePosition = s.store.updatePosition.bind(s.store);
    let broken = true;
    s.store.updatePosition = (id, patch) => { if (broken && patch.tokensBought !== undefined) { broken = false; throw new Error('disk I/O error'); } return updatePosition(id, patch); };
    s.chain.exact({ lamports: 1_005_000_000n, tokens: 1_100_000n }); await sleep(5);
    expect(s.position()).toMatchObject({ tokensBought: 1_000_000n, costLamports: SOL }); // none of it
    expect(s.store.fills(1).find((f) => f.side === 'buy')).toMatchObject({ tokens: 1_000_000n, lamports: SOL });
    await s.engine.restore(); await s.engine.idle();
    expect(s.position()).toMatchObject({ tokensBought: 1_100_000n, tokensHeld: 1_100_000n, costLamports: 1_005_000_000n });
    expect(s.store.fills(1).find((f) => f.side === 'buy')).toMatchObject({ tokens: 1_100_000n, lamports: 1_005_000_000n });
  });

  it('the coins beyond a quote found after the position was closed: a feed line that cannot be written does not leave them unsold', async () => {
    const s = server({ ...none, timed: [{ afterSec: 1, percent: 100 }] });
    s.chain.receives = 1_100_000n; s.chain.booked = 1_000_000n;
    await s.buy();
    s.at(1_000); await s.tick(); // the 1,000,000 the books know are sold: closed
    const addEvent = s.store.addEvent.bind(s.store);
    let broken = true;
    s.store.addEvent = (e) => { if (broken && /more than its quote/.test(e.message)) { broken = false; throw new Error('disk I/O error'); } return addEvent(e); };
    s.chain.exact({ lamports: SOL, tokens: 1_100_000n }); await sleep(5); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 100_000n]);
    expect(s.chain.held).toBe(0n);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });
});

describe('a buy settled from its own transaction', () => {
  it('records the platform fee it carried, as one booked at once does (it was booked with none: the fees shown were short)', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 100 }] }, { feeBpsFor: () => 100 });
    const buy = s.chain.buy.bind(s.chain);
    s.chain.buy = async (req) => { await buy(req); return { ok: false, error: 'sent, outcome unknown: confirmation unknown (RPC unreachable)', uncertain: true }; };
    (s.chain as unknown as { settleBuy: () => Promise<unknown> }).settleBuy = async () => ({ state: 'landed', tokens: 1_000_000n, lamports: 1_010_000_000n });
    await s.buy();
    expect(s.position()).toMatchObject({ status: 'opening', buySig: 'B1' });
    s.crash(); // and a new process settles it
    await s.engine.restore(); await s.engine.idle();
    expect(s.store.fills(1).find((f) => f.side === 'buy')).toMatchObject({ signature: 'B1', lamports: 1_010_000_000n, feeLamports: 10_000_000n });
    expect(s.store.userFees(s.uid).live).toBe(10_000_000n);
    s.at(10_000); await s.tick();
    expect(s.position().status).toBe('closed');
    expect(s.store.closedTotals(s.uid, 'live').feesLamports).toBe(10_000_000n + 10_000_000n); // the buy's and the sell's
  });

  it('a buy written down by an earlier version (no fee beside its signature) is settled with none, as before', async () => {
    const s = server(none);
    const id = s.store.insertPosition({ userId: s.uid, copyId: 1, mint: MINT, mode: 'live', leaderSig: 'L', sell: validateSettings({ leader: LEADER, sell: none }).sell, copyName: 'c', leader: LEADER, now: 1_000_000 });
    s.store.updatePosition(id, { buySig: 'B9' });
    (s.chain as unknown as { settleBuy: () => Promise<unknown> }).settleBuy = async () => ({ state: 'landed', tokens: 1_000_000n, lamports: SOL });
    await s.engine.restore(); await s.engine.idle();
    expect(s.store.fills(id).find((f) => f.side === 'buy')).toMatchObject({ signature: 'B9', feeLamports: 0n });
  });
});

describe('a stop loss level that came due is sold, whatever happens before it can be', () => {
  for (const how of ['crash', 'restart'] as const) {
    it(`a partial level whose sell failed and waits for its retry: sold after a ${how}, though the price came back meanwhile (its retry lived in memory only)`, async () => {
      const s = server({ ...none, stopLoss: [{ lossPct: 20, percent: 25 }] });
      await s.buy();
      s.chain.plan = (n) => (n <= 2 ? 'fail' : 'ok');
      s.chain.price = 500n; s.at(2_000); await s.tick(); // −50 %: the level fires, its sell fails (retried in 250 ms)
      s.at(2_300); await s.tick(); // its retry fails too (the next in 1 s)
      expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n, 250_000n]);
      s.chain.price = 1_000n; s.at(3_100); await s.tick(); // the price comes back, and is stored
      if (how === 'crash') s.crash(); else await s.restart();
      s.at(4_000); await s.engine.restore(); await s.engine.idle(); await s.tick();
      expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n, 250_000n, 250_000n]);
      expect(s.position()).toMatchObject({ firedStop: [0], owedSells: [], tokensHeld: 750_000n });
    });
  }

  for (const percent of [25, 100]) {
    it(`a ${percent} % level whose sell was out at a crash and did not land: sold after it, though the price came back`, async () => {
      const s = server({ ...none, stopLoss: [{ lossPct: 20, percent }] });
      await s.buy();
      s.chain.plan = (n) => (n === 1 ? 'gone' : 'ok');
      s.chain.price = 500n; s.at(2_000); void s.engine.tick(); await sleep(5); // the level fires; its sell is out
      s.chain.price = 1_000n; s.at(3_000); void s.engine.tick(); await sleep(5); // the price comes back, and is stored while it is out
      s.crash();
      s.chain.failed.add('S1'); // that sell did not land
      s.at(4_000); await s.engine.restore(); await s.engine.idle(); await s.tick();
      const want = percent === 100 ? 1_000_000n : 250_000n;
      expect(s.chain.sent.map((x) => x.tokens)).toEqual([want, want]);
      expect(s.position()).toMatchObject({ tokensHeld: 1_000_000n - want, owedSells: [] });
      expect(s.store.fills(1).filter((f) => f.side === 'sell')).toHaveLength(1);
    });
  }

  it('one whose sell landed is not sold again (it is booked as that level)', async () => {
    const s = server({ ...none, stopLoss: [{ lossPct: 20, percent: 25 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'lost-answer' : 'ok');
    s.chain.price = 500n; s.at(2_000); void s.engine.tick(); await sleep(5);
    s.crash();
    s.chain.price = 1_000n; s.at(3_000); await s.tick();
    s.at(4_000); await s.engine.restore(); await s.engine.idle(); await s.tick(); await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n]);
    expect(s.position()).toMatchObject({ tokensHeld: 750_000n, firedStop: [0], owedSells: [] });
  });
});

describe('the stop loss level that sells everything is named in the feed', () => {
  it('when it is sold as an exit owed after a restart (it was named as the first level)', async () => {
    const s = server({ ...none, stopLoss: [{ lossPct: 20, percent: 25 }, { lossPct: 30, percent: 100 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 2 ? 'fail' : 'ok');
    s.chain.price = 500n; s.at(2_000); await s.tick(); // −50 %: the −20 % level sells 25 %; the −30 % level's sell of everything fails
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n, 750_000n]);
    await s.restart();
    s.at(3_000); await s.engine.restore(); await s.engine.idle();
    expect(s.position()).toMatchObject({ status: 'closed', firedStop: [0, 1] });
    const sold = s.feed().filter((m) => /^Sold all/.test(m));
    expect(sold).toHaveLength(1);
    expect(sold[0]).toMatch(/stop loss at −30%/);
  });

  it('when it is the rest of a sell of everything that sold only part (it was named as the first level)', async () => {
    const s = server({ ...none, stopLoss: [{ lossPct: 20, percent: 10 }, { lossPct: 30, percent: 100 }] });
    await s.buy();
    s.chain.underfill = 400_000n;
    s.chain.plan = (n) => { if (n > 2) s.chain.underfill = null; return 'ok'; }; // the sell of everything takes fewer (not the market's doing)
    s.chain.price = 500n; s.at(2_000); await s.tick(); await s.tick();
    const lines = s.feed().filter((m) => /^Sold/.test(m) && /stop loss/.test(m)); // (newest first)
    expect(lines).toHaveLength(3); // 10 %, the sell of everything that took fewer, and its rest
    expect(lines[0]).toMatch(/^Sold all .* stop loss at −30%/);
    expect(lines[1]).toMatch(/^Sold all .* stop loss at −30%/);
    expect(s.position()).toMatchObject({ status: 'closed' });
  });

  it('says only "stop loss" when the level is not known (an exit owed written by an earlier version)', async () => {
    const s = server({ ...none, stopLoss: [{ lossPct: 20, percent: 25 }, { lossPct: 30, percent: 100 }] });
    await s.buy();
    s.store.updatePosition(1, { exitOwed: { reason: 'stop_loss' } });
    await s.engine.restore(); await s.engine.idle();
    const sold = s.feed().filter((m) => /^Sold all/.test(m));
    expect(sold[0]).toMatch(/— stop loss · /);
  });
});

describe('the rest of a Sell now that keeps failing', () => {
  it('says so once: its first try and the safety pass\'s tries are one sell (the coins beyond a quote)', async () => {
    const s = server(none);
    s.chain.receives = 1_100_000n; s.chain.booked = 1_000_000n;
    await s.buy();
    expect(await s.engine.sellNow(s.uid, 1)).toEqual({ ok: true }); // the 1,000,000 the books know: closed
    await s.engine.idle();
    s.chain.plan = () => 'fail'; // from now on every sell fails
    s.chain.exact({ lamports: SOL, tokens: 1_100_000n }); await sleep(5); await s.engine.idle(); // opened again; its rest fails
    for (let i = 0; i < 3; i++) { await s.engine.restore(); await s.engine.idle(); } // the safety pass tries it again
    expect(s.chain.calls).toBeGreaterThanOrEqual(4);
    expect(s.feed().filter((m) => /tried again every 30 s/.test(m))).toHaveLength(1);
  });

  it('says so once when what is left after a sell that took fewer keeps failing', async () => {
    const s = server(none);
    await s.buy();
    s.chain.underfill = 400_000n;
    s.chain.plan = (n) => (n === 1 ? 'ok' : 'fail'); // the press sells 400,000 (fewer, not the market's doing); its rest fails
    expect((await s.engine.sellNow(s.uid, 1)).ok).toBe(true);
    await s.engine.idle();
    for (let i = 0; i < 3; i++) { await s.engine.restore(); await s.engine.idle(); }
    expect(s.feed().filter((m) => /tried again every 30 s/.test(m))).toHaveLength(1);
  });
});

describe('a sale settled from its own transaction is booked as one answered at once', () => {
  const bag = { ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }] };
  const exit = { ...none, mirror: { enabled: true, mode: 'exit' } };
  const short = (s: ReturnType<typeof server>) => s.feed().some((m) => /could pay for only part/.test(m));

  it('a step of the bag, and the last step, left by a crash keep their platform fee', async () => {
    for (const [timed, tokens, fee] of [[bag.timed, 400_000n, 4_000_000n], [[{ afterSec: 2, percent: 100 }], 1_000_000n, 10_000_000n]] as const) {
      const s = server({ ...none, timedOf: 'bag', timed }, { feeBpsFor: () => 100 });
      await s.buy();
      s.chain.plan = (n) => (n === 1 ? 'lost-answer' : 'ok');
      s.at(2_000); void s.engine.tick(); await sleep(5);
      s.crash();
      await s.engine.restore(); await s.engine.idle();
      expect(s.store.fills(1).find((f) => f.side === 'sell')).toMatchObject({ signature: 'S1', tokens, feeLamports: fee });
    }
  });

  it('a sell of everything whose outcome was unknown, that took fewer for another reason: not called the market\'s doing; the rest is sold right after', async () => {
    const s = server(exit);
    await s.buy();
    s.chain.underfill = 400_000n;
    s.chain.plan = (n) => { if (n > 1) s.chain.underfill = null; return n === 1 ? 'unknown-landed' : 'ok'; };
    await s.their('sell'); await s.engine.idle(); await s.tick();
    expect(short(s)).toBe(false);
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([1_000_000n, 600_000n]);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  for (const cause of ['market', 'other'] as const) {
    it(`a sell of everything left by a crash that took fewer (${cause === 'market' ? 'the market could pay for only part: said so' : 'another reason: not called the market\'s doing'})`, async () => {
      const s = server(exit);
      await s.buy();
      if (cause === 'market') s.chain.marketCap = 400_000n; else s.chain.underfill = 400_000n;
      s.chain.plan = (n) => (n === 1 ? 'lost-answer' : 'ok');
      void s.their('sell'); await sleep(5);
      s.crash();
      s.chain.marketCap = null; s.chain.underfill = null;
      await s.engine.restore(); await s.engine.idle();
      expect(short(s)).toBe(cause === 'market');
      s.at(30_000); await s.tick(); await s.engine.restore(); await s.engine.idle();
      expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
    });
  }

  for (const when of ['at once', 'left by a crash'] as const) {
    for (const cause of ['market', 'other'] as const) {
      it(`the last step of the bag ${when} that took fewer: ${cause === 'market' ? 'the market\'s doing, said so' : 'another reason, not called the market\'s doing'}; the rest is sold after`, async () => {
        const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 100 }] });
        await s.buy();
        if (cause === 'market') s.chain.marketCap = 400_000n; else s.chain.underfill = 400_000n;
        s.chain.plan = (n) => { if (n > 1) { s.chain.marketCap = null; s.chain.underfill = null; } return n === 1 && when === 'left by a crash' ? 'lost-answer' : 'ok'; };
        s.at(2_000);
        if (when === 'at once') await s.tick();
        else { void s.engine.tick(); await sleep(5); s.crash(); await s.engine.restore(); await s.engine.idle(); }
        expect(short(s)).toBe(cause === 'market');
        s.at(20_000); await s.tick();
        expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
        expect(s.chain.held).toBe(0n);
      });
    }
  }

  it('two left by a crash: one whose booking fails does not keep the other from being booked in the same pass', async () => {
    const s = server(bag);
    await s.buy(MINT); await s.buy(OTHER);
    s.chain.plan = () => 'lost-answer';
    s.at(2_000); void s.engine.tick(); await sleep(5); // both +2 s steps land; the process dies before it hears
    expect(s.store.sellsOut()).toHaveLength(2);
    s.crash();
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'sell') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    await s.engine.settleLeftovers();
    expect(s.store.sellsOut()).toHaveLength(1);
    await s.engine.settleLeftovers();
    expect(s.store.sellsOut()).toHaveLength(0);
    expect([1, 2].map((id) => s.store.position(id)!.proceedsLamports)).toEqual([400_000_000n, 400_000_000n]);
  });
});

describe('one write that fails does not stop the others', () => {
  it('their buy is copied by every copy of theirs, though one copy\'s write fails (the loop used to stop at it)', async () => {
    const s = server(none);
    const uid2 = s.store.createUser('v', 'x');
    s.store.setWallet(uid2, Keypair.generate().publicKey.toBase58(), 'enc');
    s.store.createCopy(uid2, validateSettings({ leader: LEADER, buySol: 1, minLeaderBuySol: 0, oncePerCoin: false, sell: none }));
    const insertPosition = s.store.insertPosition.bind(s.store);
    let broken = true;
    s.store.insertPosition = (p) => { if (broken) { broken = false; throw new Error('disk I/O error'); } return insertPosition(p); };
    await s.engine.onLeaderTrade(trade('buy')); await s.engine.idle();
    expect(s.store.activePositions().map((p) => p.userId)).toEqual([uid2]);
  });

  it('their sell is sold for every position holding the coin, though writing one of them down fails', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'exit' } });
    const uid2 = s.store.createUser('v', 'x');
    s.store.setWallet(uid2, Keypair.generate().publicKey.toBase58(), 'enc');
    s.store.createCopy(uid2, validateSettings({ leader: LEADER, buySol: 1, minLeaderBuySol: 0, oncePerCoin: false, sell: { ...none, mirror: { enabled: true, mode: 'exit' } } }));
    await s.buy();
    expect(s.store.activePositions()).toHaveLength(2);
    const updatePosition = s.store.updatePosition.bind(s.store);
    let broken = true;
    s.store.updatePosition = (id, patch) => { if (broken && patch.exitOwed) { broken = false; throw new Error('disk I/O error'); } return updatePosition(id, patch); };
    await s.their('sell'); await s.engine.idle();
    expect(s.chain.sent).toHaveLength(2);
    expect(s.store.activePositions()).toHaveLength(0);
  });

  it('their partial sell is sold though writing it down as owed fails (it is owed in memory then)', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'same' } });
    await s.buy();
    const updatePosition = s.store.updatePosition.bind(s.store);
    let broken = true;
    s.store.updatePosition = (id, patch) => { if (broken && patch.owedSells) { broken = false; throw new Error('disk I/O error'); } return updatePosition(id, patch); };
    await s.engine.onLeaderTrade({ ...trade('sell', MINT, 1_000_000n), tokenAmount: 1_000_000n }); await s.engine.idle(); // they sold half
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([500_000n]);
    expect(s.position()).toMatchObject({ tokensHeld: 500_000n, proceedsLamports: 500_000_000n });
    s.at(2_000); await s.tick(); await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent).toHaveLength(1); // once
  });

  it('a tick goes on, and does not fail, though writing down an order held for a position fails', async () => {
    const s = server({ ...none, stopLoss: [{ lossPct: 20, percent: 25 }, { lossPct: 40, percent: 100 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'gone' : 'ok');
    s.chain.price = 700n; s.at(2_000); void s.engine.tick(); await sleep(5); // −30 %: the −20 % level's sell is stuck
    s.crash(); // the new process waits for that sell
    const updatePosition = s.store.updatePosition.bind(s.store);
    s.store.updatePosition = (id, patch) => { if (patch.exitOwed) throw new Error('disk I/O error'); return updatePosition(id, patch); };
    s.chain.price = 500n; s.at(5_000);
    await expect(s.engine.tick()).resolves.toBeUndefined(); // the −40 % level comes due while it waits: held, its write fails
    await s.engine.idle();
    s.store.updatePosition = updatePosition;
    s.chain.failed.add('S1'); // that sell did not land
    s.at(6_000); await s.engine.restore(); await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([250_000n, 250_000n, 750_000n]); // held, then sold once it was settled
  });

  it('a sell that failed, whose row cannot be deleted, does not hold its position: Sell now sells everything, and the row goes on a later pass', async () => {
    const s = server({ ...none, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 600, percent: 100 }] });
    await s.buy();
    s.chain.plan = (n) => (n === 1 ? 'fail' : 'ok');
    const deleteSellOut = s.store.deleteSellOut.bind(s.store);
    let broken = true;
    s.store.deleteSellOut = (sig) => { if (broken) { broken = false; throw new Error('disk I/O error'); } return deleteSellOut(sig); };
    s.at(2_000); await s.tick(); // the +2 s sell fails; its row cannot be deleted; the step's retry sells
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 400_000n]);
    s.chain.rpcDown = true; // nothing can be read from the chain now
    await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0); // the failed sell's row went (it used to be taken for one on its way)
    expect(await s.engine.sellNow(s.uid, 1)).toEqual({ ok: true });
    await s.engine.idle();
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([400_000n, 400_000n, 600_000n]); // all that was left, not what that row kept back
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  it('the settling pass goes on to the next buy though one buy\'s write fails', async () => {
    const s = server(none);
    const a = s.store.insertPosition({ userId: s.uid, copyId: 1, mint: MINT, mode: 'paper', leaderSig: 'L1', sell: validateSettings({ leader: LEADER, sell: none }).sell, copyName: 'c', leader: LEADER, now: 1_000_000 });
    const b = s.store.insertPosition({ userId: s.uid, copyId: 1, mint: OTHER, mode: 'paper', leaderSig: 'L2', sell: validateSettings({ leader: LEADER, sell: none }).sell, copyName: 'c', leader: LEADER, now: 1_000_000 });
    const updatePosition = s.store.updatePosition.bind(s.store);
    let broken = true;
    s.store.updatePosition = (id, patch) => { if (broken && id === a) { broken = false; throw new Error('disk I/O error'); } return updatePosition(id, patch); };
    await expect(s.engine.restore()).resolves.toBeUndefined();
    expect(s.store.position(b)!.status).toBe('failed'); // never sent: failed (it used to stop the pass at the first)
    await s.engine.restore();
    expect(s.store.position(a)!.status).toBe('failed');
  });
});

describe('what the third round of reviewers found', () => {
  it('a sell left by a crash is dropped once the node that reads its status has certainly reached its last block, though that node is always some slots behind the tip (it waited for the 180 s fallback)', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'exit' } });
    const chain = s.chain as unknown as { chainTip: () => Promise<{ height: number; slot: number }>; settleSell: (sig: string) => Promise<Record<string, unknown>> };
    chain.chainTip = async () => ({ height: s.chain.height, slot: 1_000 + s.chain.height });
    const settle = chain.settleSell.bind(s.chain);
    chain.settleSell = async (sig: string) => { const r = await settle(sig); return r.state === 'not_found' ? { ...r, slot: 1_000 + s.chain.height - 5 } : r; };
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5);
    s.crash();
    s.chain.plan = () => 'ok';
    s.chain.height = 105; // past its last block (101), but the status node, 5 slots behind, may not have reached it
    s.at(45_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    s.chain.height = 112; // past it and its margin; the status node, at the slot of block 107, has reached block 101
    s.at(50_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  it('a "not found" from a node whose own slot shows it has not reached the sell\'s last block is not believed, however far past the chain is (a buy that landed was marked failed by a node far behind)', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'exit' } });
    const chain = s.chain as unknown as { chainTip: () => Promise<{ height: number; slot: number }>; settleSell: (sig: string) => Promise<Record<string, unknown>> };
    chain.chainTip = async () => ({ height: s.chain.height, slot: 1_000 + s.chain.height });
    const settle = chain.settleSell.bind(s.chain);
    let behind = 100; // the status node: 100 slots behind the tip
    chain.settleSell = async (sig: string) => { const r = await settle(sig); return r.state === 'not_found' ? { ...r, slot: 1_000 + s.chain.height - behind } : r; };
    await s.buy();
    s.chain.plan = () => 'gone';
    void s.their('sell'); await sleep(5);
    s.crash();
    s.chain.plan = () => 'ok';
    s.chain.height = 160; // 59 blocks past its last block: well past, but the node is at the slot of block 60
    s.at(80_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(1);
    behind = 0; // it has caught up
    s.at(85_000); await s.engine.restore(); await s.engine.idle();
    expect(s.store.sellsOut()).toHaveLength(0);
  });

  it('a coin that kept trading while its price could not be written (a full disk longer than the dead-coin time) is not sold as dead once the disk is back', async () => {
    const s = server({ ...none, deadCoin: { enabled: true, idleSec: 5 } });
    await s.buy();
    s.at(1_000); await s.tick();
    const disk = diskFull(s.store);
    disk.on();
    for (let t = 2_000; t <= 12_000; t += 1_000) { s.chain.price = BigInt(1_000 + t / 100); s.at(t); await s.tick(); } // it trades: the price moves every second
    disk.off();
    s.chain.price = 1_130n; s.at(13_000); await s.tick();
    expect(s.chain.sent).toHaveLength(0); // it used to be sold as a dead coin at once
    expect(s.position().lastChangeAt).toBeGreaterThanOrEqual(1_000_000 + 12_000);
  });

  it('a test sell whose booking cannot be committed is tried again on growing pauses, not every 250 ms for good', async () => {
    const s = server({ ...none, timed: [{ afterSec: 2, percent: 100 }] });
    s.chain.test = true;
    await s.buy();
    const db = s.store.db as unknown as { exec: (sql: string) => void };
    const exec = db.exec.bind(s.store.db);
    let failing = true;
    db.exec = (sql: string) => { if (sql === 'COMMIT' && failing) throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 }); return exec(sql); };
    for (let t = 2_000; t <= 12_000; t += 200) { s.at(t); await s.tick(); }
    expect(s.chain.calls).toBeLessThanOrEqual(6); // at +2 s, then 250 ms, 1 s, 2 s, 4 s later
    failing = false;
    for (let t = 12_200; t <= 30_000; t += 200) { s.at(t); await s.tick(); }
    expect(s.position()).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  it('Sell now pressed while the server stops and the sell cannot be written down says so, instead of promising it goes out after the restart', async () => {
    const s = server(none);
    await s.buy();
    s.engine.stop();
    const disk = diskFull(s.store);
    disk.on();
    const r = await s.engine.sellNow(s.uid, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be written down/);
    expect(r.error).not.toMatch(/goes out as soon as it is back/);
  });

  it('Sell now that finds the wallet holding none of the coin says nothing was sold (the page said "Sold")', async () => {
    const s = server(none);
    await s.buy();
    s.chain.held = 0n; // sold elsewhere
    expect(await s.engine.sellNow(s.uid, 1)).toEqual({ ok: true, note: 'Nothing was sold: the wallet holds none of this coin any more (sold elsewhere?), so the position is closed.' });
    expect(s.position().status).toBe('closed');
  });

  it('their partial sell heard while nothing can be written is sold once the disk is back, once (marking it seen, the first write, failed and the sell was lost for good)', async () => {
    const s = server({ ...none, mirror: { enabled: true, mode: 'same' } });
    await s.buy();
    const disk = diskFull(s.store);
    disk.on();
    const half = { ...trade('sell', MINT, 1_000_000n), tokenAmount: 1_000_000n }; // they sold half
    await s.engine.onLeaderTrade(half); await s.engine.idle();
    await s.engine.onLeaderTrade(half); await s.engine.idle(); // heard twice (the stream and the poll)
    expect(s.chain.sent).toHaveLength(0); // nothing can be written down before it is sent: nothing is sent
    disk.off();
    for (let t = 1_000; t <= 30_000; t += 500) { s.at(t); await s.tick(); }
    expect(s.chain.sent.map((x) => x.tokens)).toEqual([500_000n]);
    expect(s.position()).toMatchObject({ status: 'open', tokensHeld: 500_000n, proceedsLamports: 500_000_000n });
  });

  it('their buy heard while nothing can be written is not copied, and the engine does not fail', async () => {
    const s = server(none);
    const disk = diskFull(s.store);
    disk.on();
    await expect(s.engine.onLeaderTrade(trade('buy'))).resolves.toBeUndefined();
    await s.engine.idle();
    expect(s.chain.buys).toBe(0);
    expect(s.store.activePositions()).toHaveLength(0);
  });

  it('Sell now whose own sale landed, could not be booked at once, and was paid for only in part says so', async () => {
    const s = server(none);
    await s.buy();
    s.chain.marketCap = 400_000n;
    const insertFill = s.store.insertFill.bind(s.store);
    let broken = true;
    s.store.insertFill = (f) => { if (broken && f.side === 'sell') { broken = false; throw new Error('disk I/O error'); } return insertFill(f); };
    const r = await s.engine.sellNow(s.uid, 1);
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/^Sold part of it/);
  });
});
