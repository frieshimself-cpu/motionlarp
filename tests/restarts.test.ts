// Restarts, shutdowns and crashes while sells are under way (the timing fuzzer's findings of 27 Nov 2026).
// An update restarts the server (src/server.ts shutdown: stop the engine, wait for what is under way, exit); a crash
// (kill -9, out of memory) exits at once. Each test plays the old process, then a new Engine on the same database.
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
