// Runs one scenario against the real Engine and Store with the fake market, and checks the invariants.
//
// The engine is driven exactly as src/server.ts drives it: leader trades through onLeaderTrade, the clock through
// tick(), the safety net (restore + reconcile) 3 s after a start and every 30 s, Sell now through sellNow, copies
// paused / edited / deleted through the Store the way src/http/app.ts does, restarts as stop() + idle() + a new
// Engine on the same Store. Nothing in src/ is modified: the harness wraps the engine's sell / bagStep / buy on the
// instance (to know which order a trade belongs to) and the store's write methods (to see every booking).
import './env.js';
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { Engine, fmtSol, fmtTokens, portion } from '../../src/engine/engine.js';
import type { SellOrder } from '../../src/engine/rules.js';
import { validateSettings, type CopySettings, type SellSettings } from '../../src/engine/settings.js';
import { log } from '../../src/log.js';
import { pnlSummary } from '../../src/pnl.js';
import { Store, type EventKind, type Position } from '../../src/store.js';
import type { LeaderTrade } from '../../src/watch/parse.js';
import { als, DEN, emptyTape, Exec, Market, type BuyCall, type Ctx, type SellCall, type Tape } from './market.js';
import { LEADERS, MINTS, type Action, type Scenario } from './scenario.js';
import { Rng, Sim, SimSpin } from './sim.js';

export interface Violation {
  /** code:kind, e.g. "M2:proceeds!=sell-fills". Violations with the same sig are the same defect class. */
  sig: string;
  code: string;
  kind: string;
  message: string;
  /** Index of the step during which it was seen (steps.length: after the last step, at quiescence). */
  step: number;
  t: number;
  count: number;
  /** The last lines of the transcript when it was first seen. */
  tail: string[];
  /** True for the first violation of the scenario (later ones may be consequences). */
  first: boolean;
}

export interface RunResult {
  seed: number;
  profile: string;
  live: boolean;
  violations: Violation[];
  /** Documented outcomes that are not violations (e.g. a partial sell that gave up after 8 tries). */
  notes: Record<string, number>;
  stats: { steps: number; positions: number; opened: number; closed: number; buys: number; sells: number; sellFails: number; restarts: number; events: number; simSeconds: number };
  transcript: string[];
  tape: Tape;
  /** A harness or engine exception that ended the run early. */
  crashed?: string;
}

export interface RunOptions {
  /** Keep the whole transcript (default: the last 400 lines). */
  fullTranscript?: boolean;
  tailLines?: number;
}

interface FeedRec { i: number; t: number; op: number; userId: number; copyId: number | null; kind: EventKind; message: string; mint: string | null; signature: string | null; ctx?: Ctx }
interface MirrorDue { sig: string; percent: number; mode: string; invoked: boolean; ok: boolean }
interface Flying {
  key: string; kind: 'bag' | 'queue'; tokens: bigint; call: SellCall;
  /** The engine has been told it sold. Its coins stay reserved until the sale is booked (the wallet is read first). */
  answered?: boolean;
  /** A real sell of an earlier engine whose outcome that engine never booked (it crashed, was cut off, or stopped
   *  while the outcome was unknown). It was written down before it was sent (sells_out): the new engine treats it as on
   *  its way until it has settled it from its own transaction (the row is then deleted). */
  orphan?: boolean;
}
interface Track {
  pid: number; userId: number; copyId: number; mint: string; leader: string; sell: SellSettings; leaderSig: string; createdAt: number;
  /** Opened by restore() from the wallet's balance (a buy cut off by a restart): its cost is an estimate, it has no buy fill. */
  recovered: boolean;
  mirrorDue: MirrorDue[];
  stopDue: Set<number>;
  sellNowOk: boolean;
  gaveUp: Set<string>;
  success: Map<string, { n: number; firstPartial: boolean }>;
  overAsk: Map<string, number>;
  /** stage → running bagStep invocations of the current engine. */
  bagActive: Map<number, number>;
  /** Orders the current engine has started (`reason:stage:tag`) → feed length when first started. */
  invoked: Map<string, number>;
  /** Executor calls in flight from the position's queue (its buy, its queued sells). */
  queueFlying: number;
  /** Jobs of the position's queue that are running right now (a sell may be waiting on the wallet, not on a trade). */
  queueActive: number;
  /** Balance reads the engine is waiting for on this position's behalf. */
  reading: number;
  /** Queue sells of everything that sold all they asked for (invocation ids): checked when the engine has booked them. */
  fullExitSold: Map<number, SellCall>;
  /** The last Sell now sale could be paid for only in part (the feed tells the user to press again). */
  manualPartial: boolean;
  /** When a timed step's sale last failed (its coins stay for the last step: documented). */
  bagFailedAt: number;
  /** Sells in flight (the engine reserves their tokens): invocation → what it asked. */
  flying: Map<number, Flying>;
  /** Failed attempts of an order since it last succeeded (the next attempt must be checked first). */
  failed: Map<string, number>;
  proceedsWriter: string;
  zeroBookedPaper: Set<number>;
  /** Error lines in the feed per order since this position last sold anything (one per failing sell, not one per retry). */
  errorLines: Map<string, number>;
  /** The buy was handed back with the quote's coin count: what the quote said, what the wallet received, and whether
   *  the exact count has reached the engine since (it may never: the read can fail, the server can restart). */
  quotedBuy?: { quote: bigint; real: bigint; refined: boolean };
  /** Closed on a quote's coin count and opened again when the exact count showed more (the engine sells the rest). */
  reopened?: boolean;
}

const START = 1_800_000_000_000;
const SOL = 1_000_000_000n;
const lamports = (sol: number) => BigInt(Math.round(sol * 1e9));
const short = (s: string) => `${s.slice(0, 4)}`;
const okey = (o: SellOrder) => `${o.reason}:${o.stage ?? ''}:${o.tag ?? ''}`;

function orderText(o?: SellOrder): string {
  if (!o) return '?';
  const s = o.stage !== undefined ? `[${o.stage}]` : '';
  const basis = o.everything ? ' everything' : o.basis === 'bag' ? ' of-bag' : (o as { rest?: boolean }).rest ? ' (what is left after a full exit)' : '';
  return `${o.reason}${s} ${Number(o.percent.toFixed(4))}%${basis}${o.tag ? ` tag=${o.tag}` : ''}`;
}
const orderKind = (ctx: Ctx, o: SellOrder) => (ctx.kind === 'bag' ? (o.everything ? 'bag-last' : 'bag-step') : o.reason);

/** A throwaway wallet per user index: deterministic, never printed, never used on a chain. */
function walletOf(i: number): Keypair {
  return Keypair.fromSeed(createHash('sha256').update(`motionlarp-fuzz-wallet-${i}`).digest());
}

export async function runScenario(sc: Scenario, opt: RunOptions = {}): Promise<RunResult> {
  return new Run(sc, opt).go();
}

class Run {
  private readonly sim = new Sim(START);
  private readonly store = new Store(':memory:');
  private readonly market: Market;
  private readonly tape: Tape;
  private engine!: Engine;
  private exec!: Exec;
  private gen = 0;
  private inv = 0;
  private safetyEpoch = 0;
  private reconciling = false;
  private maxBuy: number;

  private readonly userIds: number[] = [];
  private readonly wallets = new Map<number, Keypair>();
  private readonly feeBps = new Map<number, number>();
  private readonly userOff = new Set<number>();
  private readonly copyIds: number[] = [];
  private readonly copies = new Map<number, { userId: number; last: CopySettings; deleted: boolean }>();
  private readonly pos = new Map<number, Track>();
  private readonly inserted: number[] = [];
  private readonly feed: FeedRec[] = [];
  private readonly dirty = new Set<number>();
  private post: (() => void)[] = [];
  private storeOps = 0;
  private lastFill: { op: number; pid: number; userId: number; side: string; tokens: bigint; lamports: bigint } | null = null;
  private lastFillUpdate = -1;
  private readonly sellSlot = new Map<string, number>();
  private slot = 1_000;
  private nSig = 0;
  private closedCount = 0;

  private readonly transcript: string[] = [];
  private readonly violations = new Map<string, Violation>();
  private readonly notes: Record<string, number> = {};
  private step = -1;
  private restarts = 0;
  /** A crash, or a shutdown that ran out of time: trades in flight were not booked. */
  private cutOff = false;
  /** From the engine's stop() (an update's shutdown, a crash) until the new engine starts: a stopped engine sends
   *  nothing, and the rest of a full exit it booked is written down (positions.exit_owed) for the next start. */
  private stopping = false;
  private readonly orphanSeen = new Set<string>();
  private readonly proceedsOff = new Set<number>();
  private readonly quotedFillSeen = new Set<number>();
  /** Coins the user held before the site traded (hand-written scenarios): `${owner}|${mint}` → tokens. */
  private readonly own = new Map<string, bigint>();
  private crashed: string | undefined;
  private readonly onRejection = (err: unknown) => this.problem('E1', 'unhandled-rejection', String((err as Error)?.stack ?? err).slice(0, 300));
  private readonly origLog = { warn: log.warn, error: log.error, info: log.info };

  constructor(private readonly sc: Scenario, private readonly opt: RunOptions) {
    this.tape = sc.tape ? structuredClone(sc.tape) : emptyTape();
    this.market = new Market(this.sim, sc.live, sc.overAsk, sc.faults, Rng.derive(sc.seed, 'faults'), this.tape, !!sc.tape);
    this.maxBuy = sc.maxSolPerBuy;
  }

  /** After a crash trades that landed were never booked: the books cannot know, so truth-vs-books checks wait for the end. */
  private get blind(): boolean {
    return this.sc.profile === 'crash' || this.cutOff;
  }

  // ── transcript and violations ─────────────────────────────────────────
  private line(text: string): void {
    this.transcript.push(`+${((this.sim.now - START) / 1000).toFixed(3)}s  ${text}`);
    const keep = this.opt.fullTranscript ? Infinity : 400;
    if (this.transcript.length > keep * 2) this.transcript.splice(0, this.transcript.length - keep);
  }

  private problem(code: string, kind: string, message: string): void {
    const sig = `${code}:${kind}`;
    const hit = this.violations.get(sig);
    if (hit) { hit.count++; return; }
    this.line(`!! ${sig} — ${message}`);
    this.violations.set(sig, { sig, code, kind, message, step: this.step, t: this.sim.now - START, count: 1, tail: this.transcript.slice(-(this.opt.tailLines ?? 45)), first: this.violations.size === 0 });
  }

  private note(key: string): void {
    this.notes[key] = (this.notes[key] ?? 0) + 1;
  }

  // ── setup ─────────────────────────────────────────────────────────────
  async go(): Promise<RunResult> {
    const { sc, sim, store, market } = this;
    process.on('unhandledRejection', this.onRejection);
    log.warn = (msg: string, data?: unknown) => {
      // 'timed step failed' is the engine catching an exception that escaped a timed step: never expected.
      if (/timed step failed|tick failed/.test(msg)) this.problem('E1', 'engine-exception', `${msg} ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      else this.line(`log.warn ${msg}`);
    };
    log.error = (msg: string) => this.line(`log.error ${msg}`);
    log.info = () => undefined;
    sim.install();
    sim.afterEvent = () => this.afterEvent();
    try {
      market.hooks = {
        buyAsk: (c) => this.buyAsk(c), buyDone: (c) => this.buyDone(c), sellAsk: (c) => this.sellAsk(c), sellLanded: (c) => this.sellLanded(c), sellDone: (c) => this.sellDone(c), sellSettled: (c, final) => this.sellSettled(c, final),
        reading: (ctx, d) => { const tr = ctx && ctx.gen === this.gen ? this.pos.get(ctx.positionId) : undefined; if (tr) tr.reading = Math.max(0, tr.reading + d); },
        refined: (c) => {
          const q = c.kind === 'buy' && c.quotedTokens !== undefined;
          this.line(`market ${c.kind}#${c.id} exact SOL ${c.refined === 'null' ? 'could not be read' : `is ${c.exact}`}${q && c.refined !== 'null' ? `, exact coins ${c.tokens} (the quote said ${(c as BuyCall).quotedTokens})` : ''}${c.refineSeen ? '' : ' (nobody is listening any more)'}`);
          const tr = q && c.pid !== undefined ? this.pos.get(c.pid) : undefined;
          if (tr?.quotedBuy && c.refined === 'exact' && c.refineSeen) tr.quotedBuy.refined = true;
        },
        problem: (code, kind, message) => this.problem(code, kind, message),
      };
      sc.mints.forEach((perSol, i) => {
        market.price.set(MINTS[i]!, (SOL * DEN) / BigInt(perSol));
        market.cap.set(MINTS[i]!, BigInt(perSol) * 200n); // what 200 SOL buys at the first price
      });
      for (const l of LEADERS) market.leaders.add(l);
      sc.users.forEach((u, i) => {
        const id = store.createUser(`u${i + 1}`, 'x');
        const kp = walletOf(i);
        this.userIds.push(id);
        this.wallets.set(id, kp);
        this.feeBps.set(id, u.feeBps);
        store.setWallet(id, kp.publicKey.toBase58(), 'enc');
        market.sol.set(kp.publicKey.toBase58(), lamports(u.sol));
      });
      for (const pre of sc.preload ?? []) {
        const owner = this.wallets.get(this.userIds[pre.user]!)!.publicKey.toBase58();
        market.setTokens(owner, MINTS[pre.mint]!, BigInt(pre.tokens));
        this.own.set(`${owner}|${MINTS[pre.mint]!}`, BigInt(pre.tokens));
        this.line(`u${pre.user + 1}'s wallet already holds ${pre.tokens} of ${short(MINTS[pre.mint]!)} (bought by hand, not the site's)`);
      }
      if (sc.about) this.line(`scenario: ${sc.about}`);
      this.wrapStore();
      for (const c of sc.copies) {
        const userId = this.userIds[c.user % this.userIds.length]!;
        const s = validateSettings(c.input);
        const id = store.createCopy(userId, s);
        this.copyIds.push(id);
        this.copies.set(id, { userId, last: s, deleted: false });
        this.line(`copy #${id} of u${this.userIds.indexOf(userId) + 1}: ${describeSettings(s)}`);
        if (sc.sabotage === 'min-zero') store.db.prepare('UPDATE copies SET settings = ? WHERE id = ?').run(JSON.stringify({ ...s, minLeaderBuySol: 0 }), id);
      }
      this.line(`market: Live switch ${sc.live ? 'ON (real trades)' : 'OFF (test mode)'}, over-ask ${sc.overAsk}, profile ${sc.profile}, priceMs ${sc.priceMs}, retries ${sc.retry}, max per buy ${sc.maxSolPerBuy} SOL, wallets ${sc.users.map((u) => `${u.sol} SOL`).join(' / ')}`);
      this.startEngine();

      for (let i = 0; i < sc.steps.length; i++) {
        this.step = i;
        const s = sc.steps[i]!;
        await sim.advance(s.dt);
        await this.keepFresh();
        await this.perform(s.act);
        await this.tick();
        this.checkStep(false);
      }
      this.step = sc.steps.length;
      await this.quiesce();
      this.finalChecks();
    } catch (err) {
      if (err instanceof SimSpin) this.problem('E2', 'engine-spins', err.message);
      else {
        this.crashed = String((err as Error)?.stack ?? err);
        this.problem('E0', 'harness-or-engine-exception', this.crashed.slice(0, 400));
      }
    } finally {
      // Let a rejection raised by the last event surface before the listener goes away.
      await sim.drain();
      sim.afterEvent = null;
      sim.uninstall();
      Object.assign(log, this.origLog);
      process.off('unhandledRejection', this.onRejection);
      try { this.engine?.stop(); } catch { /* ignore */ }
      try { store.close(); } catch { /* ignore */ }
    }
    const sells = market.sells.filter((s) => s.delivered || s.severed);
    return {
      seed: sc.seed, profile: sc.profile, live: sc.live, violations: [...this.violations.values()], notes: this.notes,
      stats: {
        steps: sc.steps.length, positions: this.pos.size, opened: market.buys.filter((b) => b.landedAt !== undefined).length,
        closed: this.closedCount, buys: market.buys.length, sells: sells.length, sellFails: sells.filter((s) => !s.ok).length, restarts: this.restarts, events: sim.fired, simSeconds: Math.round((sim.now - START) / 1000),
      },
      transcript: this.transcript, tape: this.tape, ...(this.crashed ? { crashed: this.crashed } : {}),
    };
  }

  /** src/server.ts renews the SOL balance of every wallet that may buy every 3 s, where the engine offers that
   *  (keepBalancesFresh): done here before a step when 3 s have passed, so a buy sees what the server's would. */
  private lastFresh = -Infinity;
  private async keepFresh(): Promise<void> {
    const e = this.engine as unknown as { keepBalancesFresh?: () => Promise<void> };
    if (typeof e.keepBalancesFresh !== 'function' || this.sim.now - this.lastFresh < 3_000) return;
    this.lastFresh = this.sim.now;
    void e.keepBalancesFresh().catch((err) => this.problem('E1', 'keep-balances-fresh-rejected', String(err)));
    await this.sim.settle();
  }

  private startEngine(): void {
    const { sc, sim, store } = this;
    this.gen++;
    this.stopping = false;
    const gen = this.gen;
    this.exec = new Exec(this.market, gen);
    const skew = sc.sabotage === 'clock-ahead' ? 3_000 : sc.sabotage === 'clock-behind' ? -3_000 : 0;
    const feeOff = sc.sabotage === 'fee-off' ? 7 : 0;
    this.engine = new Engine({
      store, executor: this.exec, walletFor: (id) => this.wallets.get(id) ?? null, now: () => sim.now + skew, priceMs: sc.priceMs,
      maxSolPerBuy: () => this.maxBuy, feeReserveSol: 0.01, feeBpsFor: (id) => (this.feeBps.get(id) ?? 0) + feeOff,
      ...(sc.retry === 'fast' ? { fastRetryMs: [0, 100, 100, 200, 200, 400], slowRetryMs: 2_000 } : {}),
    });
    this.instrument(this.engine, gen);
    for (const t of this.pos.values()) {
      t.bagActive.clear(); t.invoked.clear(); t.queueFlying = 0; t.queueActive = 0; t.reading = 0; t.fullExitSold.clear(); t.failed.clear(); t.overAsk.clear(); t.errorLines.clear();
      // (A stop loss level that came due before the restart stays due: the new engine's first check uses the price
      // the old one stored, and a level that comes due while a sell from before the restart is unsettled is held and
      // sold after it. The levels are not counted afresh: one that never fires is flagged.)
      // The old engine's real sells it never booked stay on their way for the new one (it found them written down);
      // anything else it had out is gone with it (a test sell cut off was never sent anywhere).
      for (const [inv, f] of t.flying) {
        if (f.call.live && f.call.signature) f.orphan = true;
        else t.flying.delete(inv);
      }
    }
    // src/server.ts: restore() 3 s after the start, then restore() + reconcile() every 30 s, and settleLeftovers()
    // every 5 s while a sell left by the process before is not settled. A new process starts with no pass running
    // (the flag is the old process's: its pass may wait forever on its dead executor, and every pass of the new one
    // was skipped).
    this.reconciling = false;
    const epoch = ++this.safetyEpoch;
    const engine = this.engine;
    const leftovers = () => {
      if (epoch !== this.safetyEpoch) return;
      sim.schedule(5_000, leftovers);
      if (engine.awaitingLeftovers()) void engine.settleLeftovers().catch((err) => this.problem('E1', 'leftovers-rejected', String(err)));
    };
    sim.schedule(5_000, leftovers);
    sim.schedule(3_000, () => { if (epoch === this.safetyEpoch) void engine.restore().catch((err) => this.problem('E1', 'restore-rejected', String(err))); });
    const safety = () => {
      if (epoch !== this.safetyEpoch) return;
      sim.schedule(30_000, safety);
      if (this.reconciling) return;
      this.reconciling = true;
      Promise.all([engine.restore(), engine.reconcile()]).catch((err) => this.problem('E1', 'safety-net-rejected', String(err))).finally(() => { this.reconciling = false; });
    };
    sim.schedule(30_000, safety);
  }

  /** Wraps the engine's own steps so every executor call and every booking knows which order it belongs to. */
  private instrument(engine: Engine, gen: number): void {
    const e = engine as unknown as Record<string, unknown>;
    for (const name of ['sell', 'bagStep', 'buy']) {
      if (typeof e[name] !== 'function') throw new Error(`fuzz harness: Engine.${name}() not found: the engine's internals changed, update e2e/fuzz/run.ts`);
    }
    const sell = (e.sell as (...a: unknown[]) => Promise<{ ok: boolean; error?: string }>).bind(engine);
    e.sell = (positionId: number, order: SellOrder, ...rest: unknown[]) => {
      const inv = ++this.inv;
      const tr = this.pos.get(positionId);
      if (gen === this.gen) { this.sellInvoked(positionId, order); if (tr) tr.queueActive++; }
      const res = als.run({ kind: 'queue', positionId, order, gen, inv }, () => sell(positionId, order, ...rest));
      const done = () => { if (tr && gen === this.gen) { tr.queueActive = Math.max(0, tr.queueActive - 1); this.landedOrGone(tr, inv); } };
      void res.then((r) => { done(); if (gen === this.gen) this.sellReturned(positionId, order, r, inv); }, done);
      return res;
    };
    const bagStep = (e.bagStep as (...a: unknown[]) => Promise<void>).bind(engine);
    e.bagStep = (positionId: number, order: SellOrder, ...rest: unknown[]) => {
      const inv = ++this.inv;
      const tr = this.pos.get(positionId);
      const stage = order.stage ?? 0;
      if (tr && gen === this.gen) {
        tr.bagActive.set(stage, (tr.bagActive.get(stage) ?? 0) + 1);
        tr.invoked.set(`bag#${inv}`, this.feed.length);
      }
      this.timedNotEarly(positionId, order, 'started');
      const res = als.run({ kind: 'bag', positionId, order, gen, inv }, () => bagStep(positionId, order, ...rest));
      const done = () => { if (tr && gen === this.gen) { tr.bagActive.set(stage, Math.max(0, (tr.bagActive.get(stage) ?? 0) - 1)); this.landedOrGone(tr, inv); } };
      void res.then(done, done);
      return res;
    };
    const buy = (e.buy as (...a: unknown[]) => Promise<void>).bind(engine);
    e.buy = (id: number, ...rest: unknown[]) => {
      const tr = this.pos.get(id);
      if (tr && gen === this.gen) tr.queueActive++;
      const res = als.run({ kind: 'buy', positionId: id, gen, inv: ++this.inv }, () => buy(id, ...rest));
      const done = () => { if (tr && gen === this.gen) tr.queueActive = Math.max(0, tr.queueActive - 1); };
      void res.then(done, done);
      return res;
    };
  }

  /** An engine step has returned: nothing it sent is on its way any more, except a sell whose outcome it never learnt. */
  private landedOrGone(tr: Track, inv: number): void {
    const f = tr.flying.get(inv);
    if (f && (f.answered || !f.call.uncertain)) tr.flying.delete(inv);
  }

  /** Every booking the engine makes goes through here first. */
  private wrapStore(): void {
    const { store } = this;
    const orig = {
      insertPosition: store.insertPosition.bind(store), updatePosition: store.updatePosition.bind(store), insertFill: store.insertFill.bind(store),
      updateFillLamports: store.updateFillLamports.bind(store), addEvent: store.addEvent.bind(store),
    };
    store.insertPosition = (p) => {
      const id = orig.insertPosition(p);
      this.storeOps++;
      this.pos.set(id, {
        pid: id, userId: p.userId, copyId: p.copyId, mint: p.mint, leader: p.leader, sell: p.sell, leaderSig: p.leaderSig, createdAt: this.sim.now, recovered: false,
        mirrorDue: [], stopDue: new Set(), sellNowOk: false, gaveUp: new Set(), success: new Map(), overAsk: new Map(), bagActive: new Map(), invoked: new Map(), queueFlying: 0, queueActive: 0, reading: 0, fullExitSold: new Map(), manualPartial: false, bagFailedAt: -1,
        flying: new Map(), failed: new Map(), proceedsWriter: '', zeroBookedPaper: new Set(), errorLines: new Map(),
      });
      this.inserted.push(id);
      this.dirty.add(id);
      this.line(`store p${id} created (opening) for copy #${p.copyId}, coin ${short(p.mint)}`);
      return id;
    };
    store.updatePosition = (id, patch) => {
      const before = store.position(id);
      const ctx = als.getStore();
      const tr = this.pos.get(id);
      const who = this.lastFillUpdate === this.storeOps ? 'refine' : ctx ? `${ctx.kind}:${ctx.order ? ctx.order.reason : 'buy'}` : 'engine';
      // (the one exception: the exact coin count of a buy that was handed back with its quote's count)
      const buyCorrection = patch.tokensBought !== undefined && (ctx?.kind === 'buy' || !ctx);
      if (before && patch.tokensHeld !== undefined && before.status === 'open' && patch.tokensHeld > before.tokensHeld && !buyCorrection) {
        this.problem('T3', `books-grew@${who}`, `p${id}: tokensHeld written up from ${before.tokensHeld} to ${patch.tokensHeld} by ${who} ${orderText(ctx?.order)} (a sell can only lower it)`);
      }
      if (before && patch.status === 'open' && before.status === 'opening' && !ctx && tr) tr.recovered = true; // restore()
      if (tr && patch.proceedsLamports !== undefined && patch.proceedsLamports !== before?.proceedsLamports) tr.proceedsWriter = who;
      if (before && patch.status === 'closed' && before.status !== 'closed') this.closedCount++;
      if (before && patch.status === 'open' && before.status === 'closed' && tr) { tr.reopened = true; this.note('position-opened-again:the-buy-received-more-than-its-quote-said'); }
      orig.updatePosition(id, patch);
      this.storeOps++;
      this.dirty.add(id);
      // A sell the engine was told has sold stays reserved until this, its booking (the engine reads the wallet in
      // between): from here on the books carry it. (The exact SOL arriving later is not a booking of coins.)
      if (tr && ctx && ctx.gen === this.gen && who !== 'refine' && patch.tokensHeld !== undefined && tr.flying.get(ctx.inv)?.answered) tr.flying.delete(ctx.inv);
      const bits: string[] = [];
      if (patch.status !== undefined) bits.push(`status ${before?.status}→${patch.status}`);
      if (patch.mode !== undefined && patch.mode !== before?.mode) bits.push(`mode ${patch.mode}`);
      if (patch.tokensBought !== undefined) bits.push(`bought ${patch.tokensBought}`);
      if (patch.tokensHeld !== undefined) bits.push(`held ${before?.tokensHeld}→${patch.tokensHeld}`);
      if (patch.costLamports !== undefined) bits.push(`cost ${before?.costLamports}→${patch.costLamports}`);
      if (patch.proceedsLamports !== undefined) bits.push(`proceeds ${before?.proceedsLamports}→${patch.proceedsLamports}`);
      if (patch.firedTimed !== undefined) bits.push(`firedTimed [${patch.firedTimed.join(',')}]`);
      if (patch.firedStop !== undefined) bits.push(`firedStop [${patch.firedStop.join(',')}]`);
      if (patch.deadFired !== undefined) bits.push('deadFired');
      if (patch.buySig !== undefined && patch.status === undefined) bits.push(`buy signed ${patch.buySig}`);
      if (bits.length) this.line(`store p${id} ${bits.join(', ')}  (by ${who}${ctx?.order ? ` ${orderText(ctx.order)}` : ''})`);
    };
    const sabotaged = new Set<string>();
    store.insertFill = (f) => {
      const id = orig.insertFill(f);
      this.storeOps++;
      this.lastFill = { op: this.storeOps, pid: f.positionId, userId: f.userId, side: f.side, tokens: f.tokens, lamports: f.lamports };
      this.dirty.add(f.positionId);
      if (f.side === 'sell' && f.error === null) this.pos.get(f.positionId)?.errorLines.clear(); // a sale: a new failing spell may say so again
      this.line(`store fill p${f.positionId} ${f.side}/${f.reason} tokens ${f.tokens} lamports ${f.lamports}${f.error ? ` ERROR ${f.error}` : ''} sig ${f.signature ?? '-'}`);
      // Self-test: faults planted by the harness (never in a normal run).
      const sab = this.sc.sabotage;
      if (sab && f.error === null && !sabotaged.has(`${sab}:${f.positionId}`)) {
        const once = () => sabotaged.add(`${sab}:${f.positionId}`);
        if (sab === 'refire' && f.side === 'sell' && f.reason === 'timed') { once(); queueMicrotask(() => store.db.prepare("UPDATE positions SET fired_timed = '[]' WHERE id = ? AND status = 'open'").run(f.positionId)); }
        if (sab === 'lose-proceeds' && f.side === 'sell') { once(); queueMicrotask(() => store.db.prepare('UPDATE positions SET proceeds_lamports = proceeds_lamports - 1000 WHERE id = ?').run(f.positionId)); }
        if (sab === 'hide-coins' && f.side === 'buy') { once(); queueMicrotask(() => { store.db.prepare("UPDATE positions SET tokens_held = tokens_held / 2 WHERE id = ? AND status = 'open'").run(f.positionId); this.dirty.add(f.positionId); }); }
        if (sab === 'twin-position' && f.side === 'buy') {
          once();
          queueMicrotask(() => { const p = store.position(f.positionId); if (p?.status === 'open') { const twin = orig.insertPosition({ userId: p.userId, copyId: p.copyId, mint: p.mint, mode: p.mode, leaderSig: 'twin', sell: p.sell, copyName: p.copyName, leader: p.leader, now: this.sim.now }); orig.updatePosition(twin, { status: 'opening' }); } });
        }
      }
      return id;
    };
    // A sell written down before it was sent leaves the list when the engine has booked it or knows it failed: an
    // earlier engine's sell is on its way for the new one until then.
    const st0 = store as unknown as { deleteSellOut?: (sig: string) => void };
    if (typeof st0.deleteSellOut === 'function') {
      const deleteSellOut = st0.deleteSellOut.bind(store);
      st0.deleteSellOut = (sig) => {
        deleteSellOut(sig);
        for (const tr of this.pos.values()) {
          for (const [inv, f] of tr.flying) {
            if (f.orphan && f.call.signature === sig) { tr.flying.delete(inv); this.dirty.add(tr.pid); this.line(`sell#${f.call.id} p${tr.pid} (sent before the restart) is settled: no longer on its way`); }
          }
        }
      };
    }
    store.updateFillLamports = (fillId, lam) => {
      orig.updateFillLamports(fillId, lam);
      this.storeOps++;
      this.lastFillUpdate = this.storeOps;
      this.line(`store fill #${fillId} lamports → ${lam} (exact)`);
    };
    // (the same booking under its newer name, where the store has it: the exact figure, or "nothing exact to be had")
    const st = store as unknown as { setFillExact?: (fillId: number, lam: bigint | null, ...more: unknown[]) => void };
    if (typeof st.setFillExact === 'function') {
      const setFillExact = st.setFillExact.bind(store);
      st.setFillExact = (fillId, lam, ...more) => {
        setFillExact(fillId, lam, ...more);
        this.storeOps++;
        if (lam !== null) this.lastFillUpdate = this.storeOps;
        this.line(lam === null ? `store fill #${fillId} keeps its figure (nothing exact to be read)` : `store fill #${fillId} lamports → ${lam} (exact)${more[0] !== undefined ? `, tokens → ${String(more[0])}` : ''}`);
      };
    }
    store.addEvent = (e) => {
      if ((this.sc.sabotage === 'mute-sells' && e.kind === 'sell') || (this.sc.sabotage === 'mute-skips' && e.kind === 'skip')) return;
      orig.addEvent(e);
      this.storeOps++;
      const rec: FeedRec = { i: this.feed.length, t: this.sim.now, op: this.storeOps, userId: e.userId, copyId: e.copyId ?? null, kind: e.kind, message: e.message, mint: e.mint ?? null, signature: e.signature ?? null, ctx: als.getStore() };
      this.feed.push(rec);
      this.line(`feed ${e.kind}: ${e.message}`);
      if (e.kind === 'sell' || e.kind === 'buy') this.checkTradeLine(rec);
      if (e.kind === 'error' && /^Gave up/.test(e.message) && rec.ctx?.order) this.pos.get(rec.ctx.positionId)?.gaveUp.add(okey(rec.ctx.order));
      // The engine's own rule: "one feed line per failing sell, not one per retry; one more when it turns into the
      // slow, endless kind". (Sell now pressed by the user answers every press: those lines are the user's own.)
      if (e.kind === 'error' && rec.ctx?.order && rec.ctx.gen === this.gen) {
        const o = rec.ctx.order;
        const tr = this.pos.get(rec.ctx.positionId);
        if (tr && !(o.reason === 'manual' && !o.rest)) {
          const n = (tr.errorLines.get(okey(o)) ?? 0) + 1;
          tr.errorLines.set(okey(o), n);
          if (n === 4) this.problem('FE5', `failure-line-repeated:${orderKind(rec.ctx, o)}${o.rest ? '-rest' : ''}`, `p${tr.pid}: ${orderText(o)} has written ${n} failure lines with no sale in between (it is retried without anyone pressing anything): "${e.message}"`);
        }
      }
    };
  }

  // ── the feed (invariant 7) ────────────────────────────────────────────
  private checkTradeLine(rec: FeedRec): void {
    const f = this.lastFill;
    if (!f || f.op !== rec.op - 1 || f.side !== rec.kind || f.userId !== rec.userId) {
      this.problem('FE2', `${rec.kind}-line-without-a-fill`, `feed says "${rec.message}" but no ${rec.kind} was booked with it`);
      return;
    }
    const p = this.store.position(f.pid);
    if (!p) return;
    if (rec.kind === 'sell') {
      if (!rec.message.includes(`for ${fmtSol(f.lamports)}`) || !rec.message.includes(`${fmtTokens(f.tokens, p.decimals)} tokens`)) {
        this.problem('FE2', 'sell-line-numbers', `feed line "${rec.message}" does not carry the booked fill (${f.tokens} tokens, ${f.lamports} lamports)`);
      }
      const saysClosed = /Position closed\.$/.test(rec.message);
      if (saysClosed !== (p.status === 'closed')) this.problem('FE2', saysClosed ? 'says-closed-but-open' : 'closed-without-saying', `feed line "${rec.message}" while p${p.id} is ${p.status} holding ${p.tokensHeld}`);
    }
  }

  // ── engine wrappers' callbacks ────────────────────────────────────────
  private timedNotEarly(pid: number, order: SellOrder, when: string): void {
    if (order.reason !== 'timed' || order.stage === undefined) return;
    const p = this.store.position(pid);
    const st = p?.sell.timed[order.stage];
    if (!p || !st) return;
    const due = p.openedAt + st.afterSec * 1000;
    if (this.sim.now < due) this.problem('TM1', `timed-before-its-time:${order.basis ?? 'left'}`, `p${pid} timed step ${order.stage} (+${st.afterSec}s) ${when} ${((due - this.sim.now) / 1000).toFixed(3)}s early`);
  }

  private sellInvoked(pid: number, order: SellOrder): void {
    const tr = this.pos.get(pid);
    if (!tr) return;
    if (!tr.invoked.has(okey(order))) tr.invoked.set(okey(order), this.feed.length);
    // (a ":rest" order is the follow-up of a full exit that left coins to other sells on their way, an ":owed" one a
    // full exit written down in the database and taken up again after a restart: both documented in the engine)
    // (":exact": what a buy turned out to have received beyond its quote's count, sold after the position was closed)
    const tag = (order.tag ?? '').replace(/(:rest|:owed)+$/, '');
    if (order.reason === 'mirror' && tag !== 'reconcile' && !/:exact(:rest|:owed)*$/.test(order.tag ?? '')) {
      const due = tr.mirrorDue.find((d) => d.sig === tag);
      if (!due) this.problem('MI1', 'mirror-order-nobody-asked-for', `p${pid}: ${orderText(order)}`);
      else if (tag !== order.tag) { if (due.percent < 100) this.problem('MI1', 'rest-order-after-a-partial-rule', `p${pid}: ${orderText(order)} follows a rule that called for ${due.percent}%`); }
      else {
        due.invoked = true;
        if (Math.abs(due.percent - order.percent) > 1e-9) this.problem('MI1', `mirror-wrong-share:${due.mode}`, `p${pid}: the rule calls for ${due.percent}% and the order says ${order.percent}%`);
      }
    }
  }

  private sellReturned(pid: number, order: SellOrder, r: { ok: boolean; error?: string }, inv: number): void {
    const tr = this.pos.get(pid);
    if (!tr) return;
    // A sell of everything that went through in full and is now booked: once nothing else of this position is on
    // its way and no timed step is still working, nothing may be left (the position is closed).
    const sale = tr.fullExitSold.get(inv);
    if (sale) {
      tr.fullExitSold.delete(inv);
      // (checked once the engine has had its turn: a follow-up sell of what is left may be starting right now)
      this.post.push(() => {
        const p = this.store.position(pid);
        let running = 0;
        for (const n of tr.bagActive.values()) running += n;
        if (p && p.status === 'open' && tr.flying.size === 0 && running === 0 && tr.queueActive === 0 && tr.reading === 0) {
          // A stopped engine sends nothing: what is left is sold after the restart, if it is written down.
          if (this.stopping && p.exitOwed) { this.note('full-exit-left-coins-to-the-next-start:the-server-was-stopping'); return; }
          this.problem('FX1', `full-exit-left-coins-behind:${order.reason}`, `p${pid} ${orderText(order)} sold the ${sale.sold} it asked for, nothing else is on its way or about to go, and the position still holds ${p.tokensHeld} (wallet ${sale.live ? this.market.tokens(sale.owner, sale.mint) : 'n/a'})`);
        }
      });
    }
    if (order.reason !== 'mirror' || !r.ok) return;
    const due = tr.mirrorDue.find((d) => d.sig === order.tag);
    if (due) due.ok = true;
  }

  // ── market hooks: every trade the engine asks for ─────────────────────
  private buyAsk(c: BuyCall): void {
    const tr = c.pid !== undefined ? this.pos.get(c.pid) : undefined;
    const fate = c.plan.unsure ? `outcome will be UNKNOWN to the engine (in truth it ${c.plan.unsure === 'landed' ? 'lands' : 'never lands'})` : c.plan.fail ? `will fail (${c.plan.fail})` : `lands +${c.plan.L1}ms, told +${c.plan.L1 + c.plan.L2}ms`;
    this.line(`exec buy#${c.id} p${c.pid ?? '?'} ${fmtSol(c.lamports)} of ${short(c.mint)} ${c.live ? 'REAL' : 'test'} → ${fate}`);
    if (!tr) { this.problem('E3', 'buy-outside-a-position', `buy#${c.id} has no position context`); return; }
    if (c.gen === this.gen) tr.queueFlying++;
    const s = this.copies.get(tr.copyId)?.last;
    if (!s) return;
    if (c.lamports !== lamports(s.buySol)) this.problem('F1', 'buy-amount', `p${tr.pid}: buy of ${c.lamports} lamports, the copy says ${s.buySol} SOL`);
    if (c.lamports > lamports(this.maxBuy)) this.problem('B5', 'buy-above-max-per-buy', `p${tr.pid}: buy of ${fmtSol(c.lamports)} with max per buy ${this.maxBuy} SOL`);
    if (c.priorityFeeSol !== s.priorityFeeSol || c.tipSol !== s.tipSol || c.slippagePct !== s.slippagePct) {
      this.problem('F1', 'buy-fees', `p${tr.pid}: buy sent with priority ${c.priorityFeeSol} tip ${c.tipSol} slippage ${c.slippagePct}; the copy says ${s.priorityFeeSol} / ${s.tipSol} / ${s.slippagePct}`);
    }
    if (c.feeBps !== (this.feeBps.get(tr.userId) ?? 0)) this.problem('F1', 'buy-platform-fee', `p${tr.pid}: platform fee ${c.feeBps} bps, the user's is ${this.feeBps.get(tr.userId)}`);
    if (!c.reqLive) this.problem('F1', 'buy-not-marked-live', `p${tr.pid}: buy request with live=false`);
  }

  private buyDone(c: BuyCall): void {
    const tr = c.pid !== undefined ? this.pos.get(c.pid) : undefined;
    this.line(`exec buy#${c.id} p${c.pid ?? '?'} ${c.severed ? `answer lost (the engine is gone)${c.landedAt !== undefined ? ' — it DID land' : c.sentAt === undefined ? ' — never sent' : ''}` : c.ok ? `ok: ${c.quotedTokens ?? c.tokens} tokens${c.quotedTokens !== undefined ? ` (the QUOTE's count: the reads were slow; the wallet received ${c.tokens})` : ''}, est ${c.est}${c.live ? `, exact ${c.exact}` : ''}` : `${c.uncertain ? 'OUTCOME UNKNOWN' : 'FAILED'} ${c.error}${c.uncertain && c.landedAt !== undefined ? '  [it DID land]' : ''}`}`);
    if (!tr) return;
    if (c.ok && !c.severed && c.quotedTokens !== undefined && c.tokens !== undefined) tr.quotedBuy = { quote: c.quotedTokens, real: c.tokens, refined: false };
    // (in the next microtask: the engine's own bookkeeping ends when its await returns, not before)
    if (c.gen === this.gen) queueMicrotask(() => { tr.queueFlying = Math.max(0, tr.queueFlying - 1); });
    if (c.severed) return;
    const from = this.feed.length;
    this.post.push(() => {
      const mine = this.feed.slice(from).filter((e) => e.userId === tr.userId && e.mint === c.mint);
      if (c.ok && !mine.some((e) => e.kind === 'buy')) this.problem('FE1', 'buy-without-a-feed-line', `p${tr.pid}: the buy landed and the feed has no "Bought" line`);
      if (!c.ok && !mine.some((e) => e.kind === 'error')) this.problem('FE4', 'failed-buy-without-a-feed-line', `p${tr.pid}: the buy failed (${c.error}) and the feed has no line for it`);
      const p = this.store.position(tr.pid);
      if (p && c.ok && p.mode !== (c.live ? 'live' : 'paper')) this.problem('X1', 'position-mode', `p${tr.pid}: a ${c.live ? 'real' : 'test'} buy made a "${p.mode}" position`);
      if (p && !c.ok && c.uncertain && p.status !== 'opening') this.problem('X1', 'unknown-buy-not-kept-opening', `p${tr.pid}: the buy's outcome is unknown and the position is ${p.status}`);
      if (p && !c.ok && !c.uncertain && p.status !== 'failed') this.problem('X1', 'failed-buy-not-marked-failed', `p${tr.pid}: the buy failed and the position is ${p.status}`);
    });
  }

  private sellAsk(c: SellCall): void {
    const ctx = c.ctx;
    const tr = c.pid !== undefined ? this.pos.get(c.pid) : undefined;
    const p = c.pid !== undefined ? this.store.position(c.pid) : undefined;
    const fate = c.plan.unsure === 'lost' && c.live ? 'never lands, and is reported OUTCOME UNKNOWN' : c.plan.fail ? (c.plan.ghost ? `lands +${c.plan.L1}ms but is reported OUTCOME UNKNOWN` : `will fail (${c.plan.fail})`) : `lands +${c.plan.L1}ms, told +${c.plan.L1 + c.plan.L2}ms${c.plan.part ? `, fills ${c.plan.part * 100}%` : ''}`;
    this.line(`exec sell#${c.id} p${c.pid ?? '?'} ${orderText(ctx?.order)} asks ${c.asked}${c.live ? ` (wallet ${c.walletAtAsk}, books ${p?.tokensHeld})` : ` (test; books ${p?.tokensHeld})`}${c.checkFirst ? ' [retry: checked first]' : ''}${c.closeIfEmpty ? ' [close account]' : ''} → ${this.market.outageUntil > this.sim.now && !this.market.calm ? 'RPC outage: fails' : c.overAsk ? `over-ask (${this.sc.overAsk})` : fate}`);
    if (!tr || !p || !ctx?.order) { this.problem('E3', 'sell-outside-an-order', `sell#${c.id} of ${c.asked} has no order context`); return; }
    const order = ctx.order;
    const current = c.gen === this.gen;
    const kind = orderKind(ctx, order);
    this.timedNotEarly(p.id, order, 'sent');

    // What it asks for (invariants 1 and 6). Tokens another sell of this position has out right now are reserved.
    const live = p.mode === 'live';
    // The wallet as the engine was last told it (a balance read is a moment old), and when that was true.
    const read = live ? (ctx.wallet ?? { value: c.walletAtAsk, at: this.sim.now }) : { value: 0n, at: this.sim.now };
    let others = 0n;
    for (const [inv, f] of tr.flying) if (inv !== ctx.inv) others += f.tokens;
    let expect: bigint;
    let rule: string;
    if (ctx.kind === 'bag') {
      const free = p.tokensHeld - others;
      if (order.everything) {
        expect = live ? read.value : (free > 0n ? free : 0n);
        rule = live ? 'everything the wallet holds' : `everything the books hold (${p.tokensHeld}) less what other sells have out (${others})`;
      } else {
        const share = portion(p.tokensBought, order.percent);
        expect = share < free ? share : free;
        rule = `${order.percent}% of the ${p.tokensBought} bought (${share}), or what is left (${p.tokensHeld} held − ${others} out)`;
      }
    } else {
      // Real: the wallet is the truth. A timed step that has already landed has left the wallet: only the tokens of
      // sells that are still on their way are "out" and must be left alone. Test: the books, less everything out.
      let onTheWay = 0n;
      for (const [inv, f] of tr.flying) if (inv !== ctx.inv && (!live || f.call.landedAt === undefined || f.call.landedAt > read.at)) onTheWay += f.tokens;
      const held = live ? (read.value < p.tokensHeld ? read.value : p.tokensHeld) : p.tokensHeld;
      let free = held > onTheWay ? held - onTheWay : 0n;
      // Where the engine cannot know what a sell that is out has really done (the market paid only part of it, its
      // outcome is unknown, a crash) the documented rule is the reference: the position's coins less everything
      // that is out, the wallet only as a cap.
      // The same where the books carry a quote's coin count (a buy handed back before its exact count could be read).
      if (live && (this.sc.faults.partial > 0 || this.sc.faults.ghost > 0 || this.blind || tr.quotedBuy)) {
        const own = p.tokensHeld > others ? p.tokensHeld - others : 0n;
        free = read.value < own ? read.value : own;
      }
      expect = portion(free, order.percent);
      rule = `${Number(order.percent.toFixed(4))}% of what is held (${held}${live ? `: wallet ${read.value}, books ${p.tokensHeld}` : ''}) less what other sells still have on their way (${onTheWay}${others !== onTheWay ? `; another ${others - onTheWay} had already left the wallet when it was read, the engine has not been told yet` : ''})`;
    }
    // The last step of a "% of the bag" ladder: the README says "whatever is left in the wallet"; the engine may
    // instead leave coins that are clearly not this position's (the wallet holds over 2 % more than the books) and
    // sell the books' coins only. Either is taken here; what it means for coins left behind is judged by T5 and Q.
    if (ctx.kind === 'bag' && order.everything && live && c.asked !== expect && read.value > p.tokensHeld + p.tokensHeld / 50n && c.asked === p.tokensHeld) expect = c.asked;
    if (c.asked !== expect) {
      // A sell whose outcome is unknown must be settled before anything else is sold (its coins stay reserved): an
      // ask that only fits when that sell is ignored has its own name.
      let unsettled = 0n;
      for (const [inv, f] of tr.flying) if (inv !== ctx.inv && (f.call.uncertain || f.orphan) && !f.answered) unsettled += f.tokens;
      if (unsettled > 0n) this.problem('US1', 'sold-on-before-a-sell-of-unknown-outcome-was-settled', `p${p.id} ${orderText(order)} asked ${c.asked} while sell(s) of ${unsettled} tokens with an unknown outcome were not settled yet (the rule leaves ${expect} to ask for)`);
      else this.problem('AM1', `ask:${kind}`, `p${p.id} ${orderText(order)} asked ${c.asked}; the rule is ${rule} = ${expect}`);
    }
    if (c.asked <= 0n) this.problem('AM1', 'ask-zero', `p${p.id} ${orderText(order)} asked to sell ${c.asked} tokens`);
    if (c.live !== live || c.exit !== live) this.problem('X1', 'sell-real-or-test', `p${p.id} is a ${p.mode} position; its sell went out as ${c.live ? 'real' : 'test'} (exit=${c.exit})`);
    if (c.live && !this.market.buys.some((b) => b.pid === p.id && b.live && b.landedAt !== undefined)) {
      this.problem('X1', 'real-sell-for-a-position-never-bought-for-real', `p${p.id}: a REAL sell of ${c.asked} ${short(c.mint)} goes out, yet no real buy ever landed for this position (its coins are not the site's)`);
    }

    if (current) {
      // LIVE: never more than the wallet holds for long.
      const k = `${ctx.kind}:${okey(order)}`;
      if (c.overAsk && tr.quotedBuy && !tr.quotedBuy.refined) {
        // (the books carry more coins than the buy received until its exact count arrives: documented)
        this.note('asked-for-more-than-the-wallet-holds:the-books-carry-the-quote\'s-coin-count');
      } else if (c.overAsk) {
        const n = (tr.overAsk.get(k) ?? 0) + 1;
        tr.overAsk.set(k, n);
        if (n >= 3) this.problem('OA1', `over-ask-not-corrected:${kind}`, `p${p.id} ${orderText(order)} asked ${c.asked} with ${c.walletAtAsk} in the wallet, ${n} times in a row`);
      } else tr.overAsk.delete(k);
      // A retry is checked (simulated) before it is sent.
      const failKey = ctx.kind === 'bag' ? `bag#${ctx.inv}` : okey(order);
      if ((tr.failed.get(failKey) ?? 0) > 0 && !c.checkFirst && order.reason !== 'manual') this.problem('R1', `retry-not-checked-first:${kind}`, `p${p.id} ${orderText(order)}: attempt after ${tr.failed.get(failKey)} failure(s) went out without checkFirst`);
      tr.flying.set(ctx.inv, { key: okey(order), kind: ctx.kind === 'bag' ? 'bag' : 'queue', tokens: c.asked, call: c });
      if (ctx.kind !== 'bag') tr.queueFlying++;
    }

    // Fees and slippage of the copy (the sell fees), also after the copy was paused, edited or deleted.
    const s = this.store.copy(tr.copyId)?.settings ?? this.copies.get(tr.copyId)?.last;
    const deleted = this.copies.get(tr.copyId)?.deleted;
    if (s && (c.slippagePct !== s.slippagePct || c.priorityFeeSol !== s.sellPriorityFeeSol || c.tipSol !== s.sellTipSol)) {
      this.problem('F1', deleted ? 'sell-fees-after-copy-deleted' : 'sell-fees', `p${p.id}: sell sent with slippage ${c.slippagePct}% priority ${c.priorityFeeSol} tip ${c.tipSol}; the copy${deleted ? ' (deleted)' : ''} says ${s.slippagePct}% / ${s.sellPriorityFeeSol} / ${s.sellTipSol}`);
    }
    if (c.feeBps !== (this.feeBps.get(tr.userId) ?? 0)) this.problem('F1', 'sell-platform-fee', `p${p.id}: platform fee ${c.feeBps} bps, the user's is ${this.feeBps.get(tr.userId)}`);
  }

  /** A real sell has just changed the wallet. It must belong to a position that is still open. */
  private sellLanded(c: SellCall): void {
    const p = c.pid !== undefined ? this.store.position(c.pid) : undefined;
    if (!p || p.status === 'open') return;
    const now = this.store.activePositionOfUser(p.userId, p.mint);
    this.problem('ST1', now ? 'sell-of-a-closed-position-sold-the-next-position\'s-coins' : 'sell-of-a-closed-position-landed', `sell#${c.id} (${orderText(c.ctx?.order)}, sent ${((this.sim.now - c.t0) / 1000).toFixed(1)}s ago for p${p.id}) landed after p${p.id} was ${p.status}: it sold ${c.sold} of ${short(c.mint)}${now ? `, which belong to p${now.id} (opened since)` : ''}`);
  }

  /** The engine asked the chain about a sell of unknown outcome. A final answer ends the wait. */
  private sellSettled(c: SellCall, final: boolean): void {
    const ctx = c.ctx;
    const tr = c.pid !== undefined ? this.pos.get(c.pid) : undefined;
    this.line(`exec sell#${c.id} p${c.pid ?? '?'} read again from its own transaction: ${c.landedAt !== undefined ? `it landed (sold ${c.sold} for ${c.exact})` : c.chainFailed ? 'it failed' : final ? 'never found: it did not land' : 'not found yet'}`);
    // A sell of an earlier engine that the new one settles: landed, it is booked now (once: a step sold again
    // meanwhile is DF1); it stays on its way until the engine deletes its row.
    const orphan = tr ? [...tr.flying.values()].find((f) => f.orphan && f.call === c) : undefined;
    if (orphan) {
      if (c.landedAt !== undefined && !orphan.answered && tr && ctx?.order) {
        orphan.answered = true;
        const o = ctx.order;
        if ((c.sold ?? 0n) > 0n && (o.reason === 'timed' || o.reason === 'stop_loss' || o.reason === 'dead_coin') && !o.everything) {
          const k = okey(o);
          const hit = tr.success.get(k);
          if (!hit) tr.success.set(k, { n: 1, firstPartial: c.sold! < c.asked });
          else { hit.n++; if (!hit.firstPartial) this.problem('DF1', `fired-twice:${orderKind(ctx, o)}`, `p${tr.pid} ${orderText(o)} sold a second time (sell#${c.id}, ${c.sold} tokens, sent before the restart)`); }
        }
      }
      return;
    }
    // (a sell the engine was already told about is read again only for its exact figures: nothing is settled)
    if (!c.uncertain) return;
    if (!tr || !ctx || c.gen !== this.gen || !final) return;
    const mine = tr.flying.get(ctx.inv);
    // Landed: the engine books it now, its coins reserved until then. Not landed: the reservation ends with the answer.
    if (c.landedAt !== undefined && mine?.call === c) mine.answered = true;
    queueMicrotask(() => {
      if (c.landedAt === undefined && tr.flying.get(ctx.inv)?.call === c) tr.flying.delete(ctx.inv);
      if (ctx.kind !== 'bag') tr.queueFlying = Math.max(0, tr.queueFlying - 1);
    });
    if (c.landedAt === undefined && ctx.order) {
      const failKey = ctx.kind === 'bag' ? `bag#${ctx.inv}` : okey(ctx.order);
      tr.failed.set(failKey, (tr.failed.get(failKey) ?? 0) + 1);
      if (ctx.kind === 'bag') tr.bagFailedAt = this.sim.now;
    } else if (ctx.order) {
      // Booked from its own transaction: the same accounting as a sell that was confirmed in time.
      const k = okey(ctx.order);
      const o = ctx.order;
      if ((c.sold ?? 0n) > 0n && (o.reason === 'timed' || o.reason === 'stop_loss' || o.reason === 'dead_coin') && !o.everything) {
        const hit = tr.success.get(k);
        if (!hit) tr.success.set(k, { n: 1, firstPartial: c.sold! < c.asked });
        else { hit.n++; if (!hit.firstPartial) this.problem('DF1', `fired-twice:${orderKind(ctx, o)}`, `p${tr.pid} ${orderText(o)} sold a second time (sell#${c.id}, ${c.sold} tokens)`); }
      }
      if (ctx.kind !== 'bag' && o.percent >= 100 && c.sold === c.asked && !this.blind && this.sc.faults.partial === 0) tr.fullExitSold.set(ctx.inv, c);
    }
  }

  private sellDone(c: SellCall): void {
    const ctx = c.ctx;
    const tr = c.pid !== undefined ? this.pos.get(c.pid) : undefined;
    this.line(`exec sell#${c.id} p${c.pid ?? '?'} ${c.severed ? `answer lost (the engine is gone)${c.landedAt !== undefined ? ' — it DID land' : ''}` : c.ok ? `ok: sold ${c.sold}, est ${c.est}${c.live ? `, exact ${c.exact}` : ''}` : `${c.uncertain ? 'OUTCOME UNKNOWN' : 'FAILED'} ${c.error}${c.uncertain ? (c.landedAt !== undefined ? '  [it DID land]' : '  [it did not land]') : ''}`}`);
    if (!tr || !ctx?.order) return;
    const order = ctx.order;
    if (c.gen === this.gen && !(c.uncertain && c.signature && !c.severed)) {
      // The engine keeps this sell's tokens reserved until it has booked the sale (it reads the wallet first), or,
      // when the sell failed, until its await returns (the next microtask): a step that sizes itself in between must
      // still see them as "out".
      const mine = tr.flying.get(ctx.inv);
      const sold = !!c.ok && !c.severed && mine?.call === c;
      if (sold) mine!.answered = true;
      queueMicrotask(() => {
        // (a real sell whose answer the engine never got, because it was gone, is still out: written down, it is
        // settled by the next engine)
        if (!sold && !(c.severed && c.live && c.signature) && tr.flying.get(ctx.inv)?.call === c) tr.flying.delete(ctx.inv);
        if (ctx.kind !== 'bag') tr.queueFlying = Math.max(0, tr.queueFlying - 1);
      });
    }
    if (c.severed || c.gen !== this.gen) return;
    // "Sent, outcome unknown": not a failure yet. The engine asks the chain what became of it (sellSettled) and
    // keeps its coins reserved until it knows.
    if (c.uncertain && c.signature) return;
    const k = okey(order);
    const failKey = ctx.kind === 'bag' ? `bag#${ctx.inv}` : k;
    const kind = orderKind(ctx, order);
    if (c.ok) {
      tr.failed.delete(failKey);
      // (the last step of a bag exit stays on duty and may sell in several parts: documented)
      if ((c.sold ?? 0n) > 0n && (order.reason === 'timed' || order.reason === 'stop_loss' || order.reason === 'dead_coin') && !order.everything) {
        const hit = tr.success.get(k);
        if (!hit) tr.success.set(k, { n: 1, firstPartial: c.sold! < c.asked });
        else {
          hit.n++;
          // A second sale that only finishes what a partial fill left is not a second firing.
          if (!hit.firstPartial) this.problem('DF1', `fired-twice:${kind}`, `p${tr.pid} ${orderText(order)} sold a second time (sell#${c.id}, ${c.sold} tokens)`);
        }
      }
      // In test mode a fill for tokens the books no longer hold is dropped without a fill row (documented in settleSell).
      if (!c.live && ctx.kind === 'bag' && (this.store.position(tr.pid)?.tokensHeld ?? 0n) === 0n) tr.zeroBookedPaper.add(c.id);
      if (ctx.kind !== 'bag' && order.percent >= 100 && c.sold === c.asked && !this.blind && this.sc.faults.partial === 0) tr.fullExitSold.set(ctx.inv, c);
      if (order.reason === 'manual') tr.manualPartial = c.sold! < c.asked;
    } else {
      tr.failed.set(failKey, (tr.failed.get(failKey) ?? 0) + 1);
      if (ctx.kind === 'bag') tr.bagFailedAt = this.sim.now;
      if (order.reason === 'manual') return; // Sell now reports its last failure only (checked where it is pressed)
      const from = tr.invoked.get(failKey) ?? 0;
      this.post.push(() => {
        const p = this.store.position(tr.pid);
        // A failure the engine has nothing to report about: the position was closed another way meanwhile.
        if (!p || p.status !== 'open') return;
        // (after a sale the market could pay only part of, the feed has already said "the rest is sold as soon as it can be")
        if (!this.feed.slice(from).some((e) => e.userId === tr.userId && e.mint === c.mint && (e.kind === 'error' || (e.kind === 'sell' && /only part of it/.test(e.message))))) {
          this.problem('FE4', `failed-sell-without-a-feed-line:${kind}`, `p${tr.pid} ${orderText(order)} failed (${c.error}) and the feed has no line for it`);
        }
      });
    }
  }

  // ── after every event: the books ──────────────────────────────────────
  private afterEvent(): void {
    if (this.post.length) {
      const post = this.post;
      this.post = [];
      for (const fn of post) fn();
    }
    if (this.dirty.size) {
      for (const pid of this.dirty) this.checkBooks(pid);
      this.dirty.clear();
    }
  }

  private checkBooks(pid: number): void {
    const p = this.store.position(pid);
    const tr = this.pos.get(pid);
    if (!p || !tr) return;
    if (p.tokensHeld < 0n) this.problem('T1', 'held-negative', `p${pid} tokensHeld ${p.tokensHeld}`);
    if (p.tokensHeld > p.tokensBought) this.problem('T1', 'held-above-bought', `p${pid} holds ${p.tokensHeld} of ${p.tokensBought} bought`);
    if ((p.status === 'closed' || p.status === 'failed') && p.tokensHeld !== 0n) this.problem('T2', `${p.status}-holding-tokens`, `p${pid} is ${p.status} with tokensHeld ${p.tokensHeld}`);
    // (while one of its sells is still out, that sell's booking, or the last step that is on duty, closes it)
    let under = tr.queueActive + tr.reading + tr.flying.size;
    for (const n of tr.bagActive.values()) under += n;
    if (p.status === 'open' && p.tokensHeld === 0n && under === 0) this.problem('T2', 'open-holding-nothing', `p${pid} is open with tokensHeld 0 and nothing of it is under way (no rule will ever close it, and the coin cannot be bought again)`);
    if (p.status === 'opening' || p.status === 'failed') return;
    const fills = this.store.fills(pid).filter((f) => f.error === null);
    const buys = fills.filter((f) => f.side === 'buy');
    const sells = fills.filter((f) => f.side === 'sell');
    if (buys.length > 1) this.problem('M1', 'two-buy-fills', `p${pid} has ${buys.length} buy fills`);
    if (buys.length === 1) {
      if (p.costLamports !== buys[0]!.lamports) this.problem('M1', 'cost!=buy-fill', `p${pid} costLamports ${p.costLamports}, its buy fill says ${buys[0]!.lamports}`);
      if (p.tokensBought !== buys[0]!.tokens) {
        // After the exact count of a quoted buy arrived, the position says the exact count and the buy's own row
        // (History) still the quote's: counted, not flagged (see the report's notes).
        if (tr.quotedBuy && buys[0]!.tokens === tr.quotedBuy.quote) { if (!this.quotedFillSeen.has(pid)) { this.quotedFillSeen.add(pid); this.note('buy-row-keeps-the-quote\'s-coin-count-after-the-exact-count-arrived'); } }
        else this.problem('M1', 'bought!=buy-fill', `p${pid} tokensBought ${p.tokensBought}, its buy fill says ${buys[0]!.tokens}`);
      }
    } else if (!tr.recovered) this.problem('M1', 'open-without-a-buy-fill', `p${pid} is ${p.status} and has no buy fill`);
    const sum = sells.reduce((a, f) => a + f.lamports, 0n);
    // (reported once per position, with the booking that broke it: the gap stays for good)
    if (p.proceedsLamports !== sum && !this.proceedsOff.has(pid)) {
      this.proceedsOff.add(pid);
      this.problem('M2', `proceeds!=sell-fills@${tr.proceedsWriter || '?'}`, `p${pid} proceedsLamports ${p.proceedsLamports}, its ${sells.length} sell fills add up to ${sum} (difference ${p.proceedsLamports - sum}; last written by ${tr.proceedsWriter})`);
    }
  }

  // ── after every step ──────────────────────────────────────────────────
  private checkStep(final: boolean): void {
    const { store, market } = this;
    const active = store.activePositions();
    const seen = new Map<string, number>();
    for (const p of active) {
      const k = `${p.userId}|${p.mint}`;
      if (seen.has(k)) {
        // A position opened again for the coins beyond its quote's count, beside a newer one of the same coin: the
        // engine's own doing, for the moment it takes to sell them. Counted, not flagged.
        if (this.pos.get(p.id)?.reopened || this.pos.get(seen.get(k)!)?.reopened) this.note('two-positions-in-one-coin-for-a-moment:one-was-opened-again-for-its-exact-count');
        else this.problem('O1', 'two-positions-one-coin', `user ${p.userId} has p${seen.get(k)} and p${p.id} active in ${short(p.mint)}`);
      }
      seen.set(k, p.id);
      // Stop loss levels the last price check passed (the engine works from the same stored numbers), also while it
      // waits for a sell from before a restart (a level that comes due then is held and sold once that is settled).
      if (p.status === 'open' && p.refValueLamports !== null && p.costLamports > 0n) {
        const loss = (1 - Number(p.refValueLamports) / Number(p.costLamports)) * 100;
        const tr = this.pos.get(p.id);
        p.sell.stopLoss.forEach((l, i) => { if (loss >= l.lossPct && !p.firedStop.includes(i)) tr?.stopDue.add(i); });
      }
    }
    // The wallet is the truth. With nothing in flight for a coin, the books of a real position must say what the
    // wallet holds, and no coin may sit in the wallet without a position.
    if (this.blind && !final) return;
    for (const uid of this.userIds) {
      const owner = this.wallets.get(uid)!.publicKey.toBase58();
      for (let m = 0; m < this.sc.mints.length; m++) {
        const mint = MINTS[m]!;
        if (market.inFlight(owner, mint) > 0) continue;
        const mine = this.own.get(`${owner}|${mint}`) ?? 0n;
        if (market.tokens(owner, mint) < mine) this.problem('T5', 'the-user\'s-own-coins-were-sold', `u${this.userIds.indexOf(uid) + 1} held ${mine} of ${short(mint)} before the site traded; the wallet now holds ${market.tokens(owner, mint)}`);
        const wallet = market.tokens(owner, mint) > mine ? market.tokens(owner, mint) - mine : 0n;
        const p = active.find((x) => x.userId === uid && x.mint === mint);
        // (a sell that came back is booked only after the wallet has been read again: wait for that)
        const tr = p ? this.pos.get(p.id) : undefined;
        if (tr && (tr.reading > 0 || tr.queueActive > 0 || tr.flying.size > 0) && !final) continue;
        if (!p || p.mode !== 'live') {
          // (coins beyond a quote's count: the engine learns of them when the buy's exact count arrives, and sells them
          // then; whether it did is judged at the end)
          if (!final && [...this.pos.values()].some((t) => t.userId === uid && t.mint === mint && t.quotedBuy && !t.quotedBuy.refined)) continue;
          if (wallet > 0n && !this.orphanSeen.has(`${owner}|${mint}|${wallet}`)) {
            this.orphanSeen.add(`${owner}|${mint}|${wallet}`);
            this.problem('T5', `coins-in-wallet-no-position${this.quotedBefore(uid, mint)}`, `u${this.userIds.indexOf(uid) + 1}'s wallet holds ${wallet} of ${short(mint)} and no real position is open for it`);
          }
        } else if ([...this.pos.values()].some((t) => t.userId === uid && t.mint === mint && t.quotedBuy && !t.quotedBuy.refined)) {
          // The books carry the quote's coin count until the exact one arrives (the executor says so): no comparison
          // yet. (Also for a newer position of the coin: the wallet may still hold an earlier one's uncounted coins.)
        } else if (p.status === 'open' && p.tokensHeld !== wallet) {
          this.problem('T5', p.tokensHeld > wallet ? 'books-above-wallet' : 'books-below-wallet', `p${p.id} books ${p.tokensHeld}, wallet ${wallet} (nothing in flight)`);
        }
      }
    }
  }

  /** "(quoted-buy)" when the last position of this user in this coin was bought with the quote's coin count. */
  private quotedBefore(uid: number, mint: string): string {
    let last: Track | undefined;
    for (const tr of this.pos.values()) if (tr.userId === uid && tr.mint === mint) last = tr;
    return last?.quotedBuy ? '(quoted-buy)' : '';
  }

  // ── the clock ─────────────────────────────────────────────────────────
  private async tick(): Promise<void> {
    const { store, sim } = this;
    const now = sim.now;
    const due: { pid: number; stage: number; bag: boolean; busy: boolean }[] = [];
    for (const p of store.activePositions()) {
      if (p.status !== 'open' || p.tokensHeld <= 0n) continue;
      const tr = this.pos.get(p.id);
      p.sell.timed.forEach((t, stage) => {
        if (!p.firedTimed.includes(stage) && now >= p.openedAt + t.afterSec * 1000) due.push({ pid: p.id, stage, bag: p.sell.timedOf === 'bag', busy: (tr?.queueActive ?? 0) > 0 });
      });
    }
    const gen = this.gen;
    this.engine.tick().catch((err) => this.problem('E1', 'tick-rejected', String((err as Error)?.stack ?? err).slice(0, 300)));
    await sim.settle();
    if (gen !== this.gen) return;
    for (const d of due) {
      const p = store.position(d.pid);
      const tr = this.pos.get(d.pid);
      if (!p || !tr || p.status !== 'open' || p.firedTimed.includes(d.stage)) continue;
      const t = p.sell.timed[d.stage]!;
      const late = ((now - (p.openedAt + t.afterSec * 1000)) / 1000).toFixed(3);
      // A position with a sell from before a restart that is not settled yet sends nothing until it is (US1): its due
      // steps go then.
      if ([...tr.flying.values()].some((f) => f.orphan)) { this.note('timed-step-waits-for-a-sell-sent-before-the-restart'); continue; }
      if (d.bag) {
        if ((tr.bagActive.get(d.stage) ?? 0) === 0) this.problem('TL1', 'timed-step-not-started:bag', `p${p.id} step ${d.stage} (+${t.afterSec}s) is ${late}s overdue at this tick and no attempt is running`);
      } else if (!tr.invoked.has(`timed:${d.stage}:`) && !d.busy && tr.queueActive === 0) {
        this.problem('TL1', 'timed-step-not-started:left', `p${p.id} step ${d.stage} (+${t.afterSec}s) is ${late}s overdue at this tick, its queue is free and no sell was started`);
      }
    }
  }

  // ── what happens ──────────────────────────────────────────────────────
  private async perform(act: Action): Promise<void> {
    const { store, market, sim } = this;
    switch (act.a) {
      case 'tick': return;
      case 'buy': {
        const leader = LEADERS[act.leader]!;
        const mint = MINTS[act.mint % this.sc.mints.length]!;
        const spent = lamports(act.sol);
        const amount = market.tokensFor(mint, spent);
        const before = market.tokens(leader, mint);
        market.setTokens(leader, mint, before + amount);
        const t: LeaderTrade = {
          signature: `L${++this.nSig}`, leader, mint, side: 'buy', solLamports: spent, tokenAmount: amount, tokensBefore: before, tokensAfter: before + amount, venue: 'pumpfun',
          slot: this.nextSlot(), blockTime: act.stale ? Math.floor(sim.now / 1000) - 120 : act.noTime ? null : Math.floor(sim.now / 1000), decimals: 6, ...(act.approx ? { approx: true } : {}),
        };
        this.line(`LEADER ${short(leader)} BUYS ${act.sol} SOL of ${short(mint)} (${t.signature})${act.approx ? ' [amount read from the event: about 1 % under]' : ''}${act.stale ? ' — delivered 2 minutes late' : ''}`);
        await this.deliverBuy(t, act.stale ? 'stale' : null);
        if (act.twice) { this.line(`…the same transaction arrives again (${t.signature})`); await this.deliverBuy(t, 'dup'); }
        return;
      }
      case 'sell': {
        const leader = LEADERS[act.leader]!;
        const mint = MINTS[act.mint % this.sc.mints.length]!;
        const before = market.tokens(leader, mint);
        if (before <= 0n) { this.line(`(leader ${short(leader)} holds no ${short(mint)}: nothing to sell)`); return; }
        let amount = act.share >= 1 ? before : (before * BigInt(Math.round(act.share * 1000))) / 1000n;
        if (amount <= 0n) amount = 1n;
        market.setTokens(leader, mint, before - amount);
        const t: LeaderTrade = {
          signature: `L${++this.nSig}`, leader, mint, side: 'sell', solLamports: market.value(mint, amount), tokenAmount: amount, tokensBefore: before, tokensAfter: before - amount, venue: 'pumpfun',
          slot: this.nextSlot(), blockTime: Math.floor(sim.now / 1000), decimals: 6,
        };
        const pct = Number(((Number(amount) / Number(before)) * 100).toFixed(2));
        if (act.lost) { this.line(`LEADER ${short(leader)} SELLS ${pct}% of its ${short(mint)} — the engine never hears of it`); return; }
        this.line(`LEADER ${short(leader)} SELLS ${pct}% of its ${short(mint)} (${t.signature}${t.tokensAfter === 0n ? ', its whole bag' : ''})`);
        await this.deliverSell(t, false);
        if (act.twice) { this.line(`…the same transaction arrives again (${t.signature})`); await this.deliverSell(t, true); }
        return;
      }
      case 'price': {
        const mint = MINTS[act.mint % this.sc.mints.length]!;
        const next = (market.price.get(mint)! * BigInt(act.num)) / BigInt(act.den);
        market.price.set(mint, next > 0n ? next : 1n);
        this.line(`PRICE of ${short(mint)} ×${act.num}/${act.den}`);
        return;
      }
      case 'sellNow': {
        const open = store.activePositions();
        if (!open.length) return;
        const p = open[act.pick % open.length]!;
        this.line(`USER presses Sell now on p${p.id} (${p.status})`);
        this.pressSellNow(p);
        await sim.settle();
        return;
      }
      case 'pause':
      case 'resume': {
        const id = this.copyIds[act.copy % this.copyIds.length]!;
        const c = this.copies.get(id)!;
        if (c.deleted) return;
        const s = validateSettings({ ...c.last, enabled: act.a === 'resume' });
        store.updateCopy(c.userId, id, s);
        c.last = s;
        this.line(`USER ${act.a === 'pause' ? 'pauses' : 'resumes'} copy #${id}`);
        return;
      }
      case 'edit': {
        const id = this.copyIds[act.copy % this.copyIds.length]!;
        const c = this.copies.get(id)!;
        if (c.deleted) return;
        const s = validateSettings({ ...act.input, enabled: c.last.enabled });
        store.updateCopy(c.userId, id, s);
        c.last = s;
        this.line(`USER edits copy #${id}: ${describeSettings(s)}`);
        return;
      }
      case 'delete': {
        const id = this.copyIds[act.copy % this.copyIds.length]!;
        const c = this.copies.get(id)!;
        if (c.deleted) return;
        store.deleteCopy(c.userId, id);
        c.deleted = true;
        this.line(`USER deletes copy #${id}`);
        return;
      }
      case 'restart': return act.kind === 'crash' ? this.crash(act.downMs) : this.restartGraceful(act.downMs);
      case 'outage': {
        market.outageUntil = sim.now + act.ms;
        this.line(`RPC OUTAGE for ${act.ms / 1000}s: every trade, quote and balance read fails`);
        return;
      }
      case 'maxBuy': {
        this.maxBuy = act.sol;
        this.line(`OWNER sets max per buy to ${act.sol} SOL`);
        return;
      }
      case 'userOff': {
        const uid = this.userIds[act.user % this.userIds.length]!;
        store.setUserDisabled(uid, act.off);
        if (act.off) this.userOff.add(uid); else this.userOff.delete(uid);
        this.line(`OWNER ${act.off ? 'disables' : 'enables'} u${this.userIds.indexOf(uid) + 1}`);
        return;
      }
      case 'liveSwitch': {
        if (market.switchOn === act.on) return;
        market.switchOn = act.on;
        this.line(`OWNER switches Live trading ${act.on ? 'ON' : 'OFF'}`);
        return;
      }
    }
  }

  private nextSlot(): number {
    this.slot = Math.max(this.slot + 1, 1_000 + Math.floor((this.sim.now - START) / 400));
    return this.slot;
  }

  /** Sell now: three tries inside the engine; the answer is what the user sees. */
  private pressSellNow(p: Position): void {
    const tr = this.pos.get(p.id);
    const gen = this.gen;
    const from = this.feed.length;
    const pressedAt = this.sim.now;
    if (tr) tr.manualPartial = false;
    this.engine.sellNow(p.userId, p.id).then((r) => {
      if (gen !== this.gen) return;
      this.line(`Sell now on p${p.id} answered ${r.ok ? 'ok' : `error: ${r.error}`}`);
      const now = this.store.position(p.id);
      if (r.ok && tr?.manualPartial) {
        // Documented: the market paid for only part; the feed says "Sell now again once it has filled up".
        this.note('sell-now-sold-only-part:the-user-is-told-to-press-again');
      } else if (r.ok) {
        if (tr) tr.sellNowOk = true;
        // "ok" with the position still open is right only while other sells have the rest out (their tokens are
        // reserved: Sell now takes what is free) or the sell of what is left is under way. Judged once the engine has
        // had its turn: that follow-up may be starting right now.
        this.post.push(() => {
          const now = this.store.position(p.id);
          let out = 0n;
          for (const f of tr?.flying.values() ?? []) out += f.tokens;
          let running = 0;
          for (const n of tr?.bagActive.values() ?? []) running += n;
          if (now && now.status !== 'closed' && now.tokensHeld > out && running === 0 && (tr?.queueActive ?? 0) === 0 && (tr?.reading ?? 0) === 0 && this.sc.faults.partial === 0 && !this.blind && (tr?.bagFailedAt ?? -1) < pressedAt) {
            // (a stopped engine sends nothing: the rest of the press is written down and sold after the restart)
            if (this.stopping && now.exitOwed) this.note('sell-now-rest-owed-to-the-next-start:the-server-was-stopping');
            else this.problem('SN1', 'sell-now-said-ok-position-still-open', `p${p.id}: Sell now answered ok and the position is ${now.status} holding ${now.tokensHeld} (other sells have ${out} out, no timed step is running, nothing else is under way)`);
          }
        });
      } else if (p.status !== 'open') {
        if (r.error !== 'no open position with that id') this.problem('SN1', 'sell-now-on-a-non-open-position', `p${p.id} was ${p.status}; Sell now answered "${r.error}"`);
      } else if (r.error !== 'position is not open' && now?.status === 'open') {
        if (!this.feed.slice(from).some((e) => e.kind === 'error' && e.userId === p.userId && e.mint === p.mint)) this.problem('FE4', 'failed-sell-without-a-feed-line:manual', `p${p.id}: Sell now failed (${r.error}) and the feed has no line for it`);
      }
    }, (err) => this.problem('E1', 'sell-now-rejected', String(err)));
  }

  /** What the rules say this leader buy must lead to, checked against what the engine did (invariant 5). */
  private async deliverBuy(t: LeaderTrade, nothing: 'stale' | 'dup' | null): Promise<void> {
    const { store } = this;
    // For every copy that follows this wallet: 'buy' when no rule stands in the way, otherwise every rule that does
    // (the feed must name one of them; which one comes first is the engine's business).
    const expect: { copyId: number; userId: number; want: 'buy' | RegExp[]; why: string }[] = [];
    const later = this.sellSlot.get(`${t.leader}:${t.mint}`) ?? -1;
    if (!nothing && later <= t.slot) {
      const holding = new Set<number>();
      for (const [id, c] of [...this.copies].sort((a, b) => a[0] - b[0])) {
        const s = c.last;
        if (c.deleted || !s.enabled || s.leader !== t.leader || this.userOff.has(c.userId)) continue;
        const min = lamports(s.minLeaderBuySol);
        // An amount read from pump.fun's event is about 1 % under the real spend: within 1.5 % of the minimum it counts.
        const meets = t.solLamports >= min || (t.approx === true && t.solLamports * 1000n >= min * 985n);
        const against: [RegExp, string][] = [];
        if (!meets) against.push([/under your .* minimum/, 'the leader bought less than the minimum']);
        if (holding.has(c.userId) || store.activePositionOfUser(c.userId, t.mint)) against.push([/already holding this coin/, 'the user already has a position in this coin']);
        if ([...this.pos.values()].some((tr) => tr.userId === c.userId && tr.mint === t.mint && tr.flying.size > 0)) against.push([/a sell of this coin is still on its way/, 'a sell of an earlier position of this coin is still on its way']);
        if (s.oncePerCoin && store.hasTraded(id, t.mint)) against.push([/already traded this coin/, 'buy once per coin']);
        if (s.buySol > this.maxBuy) against.push([/above the server limit/, 'above max per buy']);
        if (against.length) expect.push({ copyId: id, userId: c.userId, want: against.map((a) => a[0]), why: against.map((a) => a[1]).join(' / ') });
        else { expect.push({ copyId: id, userId: c.userId, want: 'buy', why: 'every rule allows it' }); holding.add(c.userId); }
      }
    }
    const posFrom = this.inserted.length;
    const feedFrom = this.feed.length;
    await this.engine.onLeaderTrade(t);
    await this.sim.settle();
    const made = this.inserted.slice(posFrom).map((id) => this.pos.get(id)!).filter((tr) => tr.leaderSig === t.signature);
    const skips = this.feed.slice(feedFrom).filter((e) => e.kind === 'skip' && e.signature === t.signature && !/wallet has/.test(e.message));
    if (nothing) {
      if (made.length || skips.length) this.problem('B1', nothing === 'dup' ? 'acted-twice-on-one-transaction' : 'copied-a-stale-buy', `${t.signature}: ${made.length} position(s), ${skips.length} skip line(s) for a ${nothing} delivery`);
      return;
    }
    for (const e of expect) {
      const pos = made.filter((m) => m.copyId === e.copyId);
      const skip = skips.filter((s) => s.copyId === e.copyId);
      if (e.want === 'buy') {
        if (pos.length !== 1) this.problem('B2', 'did-not-buy', `copy #${e.copyId}: ${e.why}, yet ${pos.length} positions were opened${skip.length ? ` and the feed says "${skip[0]!.message}"` : ''}`);
      } else {
        const first = e.why.split(' / ')[0]!.replace(/\s+/g, '-');
        if (pos.length) this.problem('B1', `bought-against-a-rule:${first}`, `copy #${e.copyId} opened p${pos[0]!.pid} although ${e.why}`);
        if (!skip.some((s) => (e.want as RegExp[]).some((re) => re.test(s.message)))) this.problem('FE3', `skip-without-its-feed-line:${first}`, `copy #${e.copyId}: ${e.why}; feed lines: ${JSON.stringify(skip.map((s) => s.message))}`);
      }
    }
    for (const m of made) {
      if (!expect.some((e) => e.copyId === m.copyId)) {
        const c = this.copies.get(m.copyId);
        this.problem('B4', 'a-copy-that-should-not-copy-opened-a-position', `p${m.pid} by copy #${m.copyId} (deleted ${c?.deleted}, enabled ${c?.last.enabled}, leader ${c?.last.leader === t.leader ? 'same' : 'other'}, user disabled ${this.userOff.has(m.userId)})`);
      }
    }
  }

  /** What "sell when they sell" must do with this leader sell (the mirror rule of each open position). */
  private async deliverSell(t: LeaderTrade, dup: boolean): Promise<void> {
    if (!dup) {
      const k = `${t.leader}:${t.mint}`;
      this.sellSlot.set(k, Math.max(t.slot, this.sellSlot.get(k) ?? 0));
      const share = t.tokensBefore <= 0n ? 1 : Math.min(1, Number((t.tokenAmount * 1_000_000n) / t.tokensBefore) / 1_000_000);
      const soldOut = share >= 0.995 || t.tokensAfter === 0n;
      for (const p of this.store.activePositions()) {
        if (p.leader !== t.leader || p.mint !== t.mint || !p.sell.mirror.enabled) continue;
        const mode = p.sell.mirror.mode;
        if (mode === 'exit' && !soldOut) continue;
        this.pos.get(p.id)?.mirrorDue.push({ sig: t.signature, percent: mode !== 'same' || soldOut ? 100 : share * 100, mode, invoked: false, ok: false });
      }
    }
    await this.engine.onLeaderTrade(t);
    await this.sim.settle();
  }

  // ── restarts ──────────────────────────────────────────────────────────
  /** src/server.ts shutdown(): finish a short exit in progress (up to 40 s), stop, let trades in flight finish (up to 100 s). */
  private async restartGraceful(downMs: number): Promise<void> {
    const { sim } = this;
    this.restarts++;
    this.line('SERVER RESTART (update): shutting down');
    this.safetyEpoch++;
    let waited = 0;
    while (waited < 40_000 && this.engine.exitsDueWithin(15_000)) {
      await sim.advance(200);
      waited += 200;
      await this.tick();
      this.checkStep(false);
    }
    if (waited) this.line(`…waited ${waited / 1000}s for an exit in progress`);
    const old = this.engine;
    old.stop();
    this.stopping = true;
    let idle = false;
    void old.idle().then(() => { idle = true; }, (err) => this.problem('E1', 'idle-rejected', String(err)));
    await sim.settle();
    const deadline = sim.now + 100_000;
    while (!idle) {
      const at = sim.nextAt();
      if (at === null || at > deadline) break;
      await sim.advance(at - sim.now);
    }
    if (!idle) {
      // The process exits after 100 s whatever is still in flight: from here it is the same as a crash.
      this.line('…still busy after 100 s: the process exits anyway');
      this.cutOff = true;
      this.note('restart-cut-off-after-100s');
    }
    // src/server.ts: the exact SOL of the last trades is read for up to 5 s more (where the engine has refined()).
    const withRefined = old as unknown as { refined?: () => Promise<void> };
    if (typeof withRefined.refined === 'function') {
      let read = false;
      void withRefined.refined().then(() => { read = true; }, () => { read = true; });
      await sim.settle();
      const until = sim.now + 5_000;
      while (!read) {
        const at = sim.nextAt();
        if (at === null || at > until) { await sim.advance(Math.max(0, until - sim.now)); break; }
        await sim.advance(at - sim.now);
      }
    }
    // The old process is gone: whatever it was still waiting for (the exact SOL of a fresh fill) never arrives.
    this.exec.alive = false;
    await sim.advance(downMs);
    this.line(`SERVER BACK after ${downMs / 1000}s`);
    this.startEngine();
  }

  /** The process dies on the spot (kill -9, out of memory, power): nothing in flight is booked. */
  private async crash(downMs: number): Promise<void> {
    this.restarts++;
    this.cutOff = true;
    this.line('SERVER CRASH: the process dies with trades in flight');
    this.safetyEpoch++;
    this.engine.stop();
    this.stopping = true;
    this.exec.alive = false;
    await this.sim.advance(downMs);
    this.line(`SERVER BACK after ${downMs / 1000}s`);
    this.startEngine();
  }

  // ── the end of the scenario ───────────────────────────────────────────
  private async quiesce(): Promise<void> {
    const { sim, market, store, sc } = this;
    market.calm = true;
    market.outageUntil = 0;
    this.line('──── from here the market lets everything through and prices stand still ────');
    if (sc.finale.leadersExit) {
      for (const leader of LEADERS) {
        for (let m = 0; m < sc.mints.length; m++) {
          const mint = MINTS[m]!;
          const before = market.tokens(leader, mint);
          if (before <= 0n) continue;
          market.setTokens(leader, mint, 0n);
          const t: LeaderTrade = { signature: `L${++this.nSig}`, leader, mint, side: 'sell', solLamports: market.value(mint, before), tokenAmount: before, tokensBefore: before, tokensAfter: 0n, venue: 'pumpfun', slot: this.nextSlot(), blockTime: Math.floor(sim.now / 1000), decimals: 6 };
          this.line(`LEADER ${short(leader)} SELLS its whole bag of ${short(mint)} (${t.signature})`);
          await this.deliverSell(t, false);
        }
      }
    }
    if (sc.finale.dump) {
      for (let m = 0; m < sc.mints.length; m++) market.price.set(MINTS[m]!, 1n);
      this.line('PRICE of every coin falls to nothing');
    }
    const plan: [number, number][] = [[100, 200], [45, 1_000], [50, 5_000], [45, 30_000], [6, 300_000]];
    for (const [n, dt] of plan) {
      for (let i = 0; i < n; i++) {
        await sim.advance(dt);
        await this.tick();
        this.checkStep(false);
      }
      // Nothing left to wait for: no position open and nothing in flight.
      if (!store.activePositions().length && this.idleInside() && dt >= 5_000) break;
    }
    // The last tick's price checks come back; nothing new is started.
    await sim.advance(10_000);
  }

  private idleInside(): boolean {
    const e = this.engine as unknown as Record<string, { size?: number } | undefined>;
    return ['inFlight', 'queues', 'loose', 'orphans'].every((n) => !e[n]?.size);
  }

  private finalChecks(): void {
    const { store, market, sim } = this;
    this.line('──── final checks ────');
    for (const tr of this.pos.values()) {
      const p = store.position(tr.pid);
      if (!p) continue;
      this.checkBooks(tr.pid);
      if (p.status === 'opening') { this.problem('Q', 'left-opening', `p${p.id} is still "opening" at the end (its buy ${market.buys.find((b) => b.pid === p.id)?.landedAt !== undefined ? 'landed' : 'did not land'})`); continue; }
      if (p.status === 'failed') {
        const landed = market.buys.find((b) => b.pid === p.id && b.landedAt !== undefined && b.live);
        if (landed) this.problem('Q', 'buy-landed-position-failed', `p${p.id} is marked failed, yet its buy landed (${landed.tokens} tokens for ${landed.exact} lamports)`);
        continue;
      }
      const s = p.sell;

      // Fills against the trades that really happened (invariant 2).
      const fills = store.fills(p.id).filter((f) => f.error === null);
      const sigs = new Set<string>();
      for (const f of fills) {
        const op = f.signature ? market.bySig.get(f.signature) : undefined;
        if (!op) { this.problem('M3', `${f.side}-fill-without-a-trade`, `p${p.id}: a ${f.side} fill (${f.tokens} tokens, ${f.lamports} lamports, sig ${f.signature}) matches no trade on the market`); continue; }
        sigs.add(f.signature!);
        // What the engine could know: the exact figure once it arrived (while that engine was still running, or
        // read from the buy's own transaction afterwards), the estimate otherwise (the real executor documents both).
        const exactKnown = !op.live || (op.refined === 'exact' && op.refineSeen === true) || op.settled === true;
        const known = exactKnown ? op.exact! : op.est!;
        if (op.live && !exactKnown && op.exact !== op.est) {
          // History and the profit then keep the quote for this trade for good: nothing reads the transaction again.
          const why = op.refined === 'null' ? 'the-exact-figure-could-not-be-read' : 'the-server-restarted-before-the-exact-figure-arrived';
          this.note(`estimate-kept:${why}`);
          if (this.sc.strictExact) this.problem('M5', `estimate-kept:${why}`, `p${p.id}: the ${op.kind} ${f.signature} stays booked at its quote, ${f.lamports} lamports; the chain says ${op.exact} (${op.exact! - f.lamports >= 0n ? '+' : ''}${op.exact! - f.lamports}). Nothing reads the transaction again: History and the profit keep the quote`);
        }
        if (op.kind === 'buy') {
          // (a buy handed back with the quote's coin count keeps it in its own row: counted in checkBooks)
          if (f.tokens !== op.tokens && !(op.quotedTokens !== undefined && f.tokens === op.quotedTokens)) this.problem('M3', 'buy-fill-tokens', `p${p.id}: buy fill says ${f.tokens} tokens, the wallet received ${op.tokens}`);
          if (f.lamports !== known) this.problem('M3', 'buy-fill-sol', `p${p.id}: buy booked at ${f.lamports} lamports, the wallet paid ${known}${exactKnown ? '' : ' (the estimate: the exact figure never reached the engine)'}`);
        } else {
          if (f.tokens !== op.sold) this.problem('M3', 'sell-fill-tokens', `p${p.id}: sell fill says ${f.tokens} tokens, the market sold ${op.sold}`);
          if (f.lamports !== known) {
            // Test mode only: a fill for tokens the books no longer held is scaled down (documented in settleSell).
            const scaled = !op.live && f.lamports >= 0n && f.lamports < op.exact!;
            if (scaled) this.note('test-fill-scaled-to-what-the-books-held');
            else this.problem('M3', 'sell-fill-sol', `p${p.id}: sell booked at ${f.lamports} lamports, the wallet received ${known}${exactKnown ? '' : ' (the estimate: the exact figure never reached the engine)'}`);
          }
        }
      }
      for (const op of market.sells) {
        if (op.pid !== p.id || op.landedAt === undefined || (op.sold ?? 0n) <= 0n || sigs.has(op.signature!)) continue;
        if (!op.live && tr.zeroBookedPaper.has(op.id)) { this.note('test-fill-dropped-nothing-left-in-the-books'); continue; }
        // A test sell is a quote filled inside the process: one whose answer was lost with the process sold nothing
        // anywhere (the books still hold its coins and the rules sell them after the restart).
        if (!op.live && op.severed) { this.note('test-sell-cut-off-by-the-process-ending:nothing-was-sold'); continue; }
        const why = op.uncertain ? 'reported "outcome unknown", it had landed' : op.severed ? 'the engine was gone when it confirmed' : 'delivered to the engine';
        this.problem('M3', `sold-but-not-booked:${op.uncertain ? 'outcome-unknown' : op.severed ? 'engine-gone' : 'delivered'}`, `p${p.id}: sell#${op.id} sold ${op.sold} for ${op.exact} lamports (${why}) and there is no fill for it`);
      }
      if (p.mode === 'live') {
        const soldTokens = fills.filter((f) => f.side === 'sell').reduce((a, f) => a + f.tokens, 0n);
        if (p.tokensBought - p.tokensHeld !== soldTokens) {
          // A buy whose exact coin count never reached the engine keeps the quote's as "bought": counted, not flagged.
          if (tr.quotedBuy && !tr.quotedBuy.refined) this.note('bought-stays-the-quote\'s-coin-count:the-exact-count-never-arrived');
          else this.problem('T4', p.tokensBought - p.tokensHeld > soldTokens ? 'books-say-more-sold-than-the-fills' : 'books-say-less-sold-than-the-fills', `p${p.id}: bought ${p.tokensBought}, holds ${p.tokensHeld}, its sell fills add up to ${soldTokens}`);
        }
      }
      if (p.status !== 'open') continue;

      // Every step that came due must have fired; every rule that calls for a full exit must have closed it.
      const must: string[] = [];
      const gave = (key: string) => tr.gaveUp.has(key);
      s.timed.forEach((t, i) => {
        const bag = s.timedOf === 'bag';
        if (!p.firedTimed.includes(i) && sim.now >= p.openedAt + t.afterSec * 1000) this.problem('Q', `timed-step-never-fired:${bag ? 'bag' : 'left'}`, `p${p.id} step ${i} (+${t.afterSec}s, ${t.percent}%) never fired`);
        if (!bag && t.percent >= 100) must.push('timed-left-100%');
      });
      if (s.timed.length && s.timedOf === 'bag') must.push('timed-bag-last-step');
      const leaderGone = s.mirror.enabled && market.tokens(p.leader, p.mint) === 0n;
      if (leaderGone) must.push('followed-wallet-holds-none(safety-net)');
      for (const d of tr.mirrorDue) {
        if (d.percent >= 100) must.push(`mirror-${d.mode}`);
        else if (!d.ok) {
          if (gave(`mirror::${d.sig}`)) this.note('partial-sell-gave-up-and-was-never-done:mirror-same');
          else this.problem('Q', `mirror-partial-sell-never-done:${d.mode}`, `p${p.id}: their sell ${d.sig} called for ${d.percent}% of ours and it never went through`);
        }
      }
      if (s.deadCoin.enabled) must.push('dead-coin');
      for (const i of tr.stopDue) {
        const l = s.stopLoss[i]!;
        if (!p.firedStop.includes(i)) this.problem('Q', 'stop-level-never-fired', `p${p.id} stop level ${i} (−${l.lossPct}%) was passed and never fired`);
        if (l.percent >= 100) must.push('stop-loss-100%');
      }
      if (tr.sellNowOk) must.push('sell-now-answered-ok');
      if (must.length) {
        const owner = this.wallets.get(p.userId)!.publicKey.toBase58();
        const c = this.copies.get(p.copyId)?.last;
        const starving = p.mode === 'live' && (market.sol.get(owner) ?? 0n) < 5_000n + lamports(c?.sellPriorityFeeSol ?? 0.0005) + lamports(c?.sellTipSol ?? 0);
        const list = [...new Set(must)].sort().join('+');
        this.problem('Q', `still-open${starving ? '(no-SOL-for-the-fee)' : ''}:${list}`, `p${p.id} (${p.mode}) holds ${p.tokensHeld} of ${p.tokensBought} at the end; rules that call for a full exit: ${list}; wallet holds ${market.tokens(owner, p.mint)}, ${market.sol.get(owner)} lamports`);
      }
    }
    for (const tr of this.pos.values()) for (const k of tr.gaveUp) this.note(`partial-sell-gave-up-after-its-tries:${k.split(':')[0]}`);

    // No coin may be left in a wallet without an open real position (nothing would ever sell it).
    for (const uid of this.userIds) {
      const owner = this.wallets.get(uid)!.publicKey.toBase58();
      for (let m = 0; m < this.sc.mints.length; m++) {
        const mint = MINTS[m]!;
        const mine = this.own.get(`${owner}|${mint}`) ?? 0n;
        const wallet = market.tokens(owner, mint) > mine ? market.tokens(owner, mint) - mine : 0n;
        const p = store.activePositionOfUser(uid, mint);
        if (wallet > 0n && (!p || p.mode !== 'live')) this.problem('Q', `coins-left-in-the-wallet-no-position${this.quotedBefore(uid, mint)}`, `u${this.userIds.indexOf(uid) + 1}'s wallet still holds ${wallet} of ${short(mint)} (worth ${fmtSol(market.value(mint, wallet))} now) and no position is open for it`);
      }
    }

    // Nothing may still be marked in flight.
    const e = this.engine as unknown as Record<string, { size?: number } | undefined>;
    for (const name of ['inFlight', 'queues', 'loose', 'reserved', 'quoting', 'orphans']) {
      if (e[name]?.size) this.problem('Q', `still-marked-in-flight:${name}`, `engine.${name} holds ${e[name]!.size} entr${e[name]!.size === 1 ? 'y' : 'ies'} at the end`);
    }
    if (e.retries?.size) this.note('retry-entries-left-at-the-end');

    // The feed: one line per booked buy and sell, no more.
    for (const uid of this.userIds) {
      const name = `u${this.userIds.indexOf(uid) + 1}`;
      let buyFills = 0;
      let sellFills = 0;
      for (const tr of this.pos.values()) {
        if (tr.userId !== uid) continue;
        for (const f of store.fills(tr.pid)) { if (f.error !== null) continue; if (f.side === 'buy') buyFills++; else sellFills++; }
      }
      const lines = this.feed.filter((x) => x.userId === uid);
      const buyLines = lines.filter((x) => x.kind === 'buy').length;
      const sellLines = lines.filter((x) => x.kind === 'sell').length;
      if (buyLines !== buyFills) this.problem('FE1', 'buy-lines!=buys', `${name}: ${buyLines} "Bought" lines for ${buyFills} buys`);
      if (sellLines !== sellFills) this.problem('FE2', 'sell-lines!=sells', `${name}: ${sellLines} "Sold" lines for ${sellFills} sells`);

      // Profit shown = what the wallet really gained or lost through the positions that are closed.
      const mine = [...this.pos.values()].filter((t) => t.userId === uid).map((t) => store.position(t.pid)!);
      for (const mode of ['live', 'paper'] as const) {
        const closed = mine.filter((p) => p.status === 'closed' && p.mode === mode);
        const shown = closed.reduce((a, p) => a + (p.proceedsLamports - p.costLamports), 0n);
        const pnl = pnlSummary(store, uid, 0, sim.now)[mode === 'live' ? 'live' : 'test'];
        const d = BigInt(Math.round(pnl.allSol * 1e9)) - shown;
        if (d > 2n || d < -2n) this.problem('M4', 'profit-summary!=closed-positions', `${name}: the ${mode} profit summary says ${pnl.allSol} SOL, closed positions add up to ${shown} lamports`);
        if (pnl.trades !== closed.length) this.problem('M4', 'profit-summary-trade-count', `${name}: the ${mode} profit summary counts ${pnl.trades} trades, ${closed.length} positions are closed`);
        if (mode !== 'live') continue;
        let real = 0n;
        let exact = true;
        for (const p of closed) {
          for (const b of market.buys) if (b.pid === p.id && b.landedAt !== undefined) { real -= b.exact!; if (!((b.refined === 'exact' && b.refineSeen) || b.settled)) exact = false; }
          for (const x of market.sells) if (x.pid === p.id && x.landedAt !== undefined) { real += x.exact!; if (!((x.refined === 'exact' && x.refineSeen) || x.settled)) exact = false; }
          if (this.pos.get(p.id)!.recovered && !market.buys.some((b) => b.pid === p.id && b.settled)) exact = false;
        }
        if (exact && shown !== real) this.problem('M4', 'profit-shown!=wallet-change', `${name}: closed real positions show ${shown} lamports of profit, the wallet's SOL changed by ${real} through them (difference ${shown - real})`);
      }
    }
    this.checkStep(true);
  }
}

export function describeSettings(s: CopySettings): string {
  const sell = s.sell;
  const bits = [
    `follows ${short(s.leader)}`, `buys ${s.buySol} SOL when they buy ≥ ${s.minLeaderBuySol}`, s.oncePerCoin ? 'once per coin' : 'may re-buy', s.enabled ? '' : 'PAUSED',
    `fees buy ${s.priorityFeeSol}+${s.tipSol} sell ${s.sellPriorityFeeSol}+${s.sellTipSol}`, `slippage ${s.slippagePct}%`,
    sell.mirror.enabled ? `mirror:${sell.mirror.mode}` : 'mirror off',
    sell.timed.length ? `timed(${sell.timedOf === 'bag' ? '% of bag' : '% of left'}): ${sell.timed.map((t) => `${t.percent}%@${t.afterSec}s`).join(' → ')}` : 'no timed sells',
    sell.stopLoss.length ? `stop loss: ${sell.stopLoss.map((l) => `−${l.lossPct}%→sell ${l.percent}%`).join(', ')}` : 'no stop loss',
    sell.deadCoin.enabled ? `dead coin ${sell.deadCoin.idleSec}s` : 'no dead coin',
  ];
  return bits.filter(Boolean).join('; ');
}
