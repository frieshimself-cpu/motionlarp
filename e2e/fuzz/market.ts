// The fake chain. One Market per scenario holds the truth: what every wallet holds, what every coin is worth, and
// every trade that really "landed" (the ledger the engine's books are checked against). The engine talks to it
// through an Exec (the Executor interface), one per engine instance, so a "crashed" engine's calls never return.
//
// A REAL trade (the owner's Live switch on, or the sell of a position bought for real): the wallet's token balance
// is the truth. A sell lands only if the wallet holds the tokens at that moment; SOL moves; fills come back as an
// estimate first and the exact figure later (`refine`), as the real executor does. A TEST trade: nothing is held,
// fills are quotes (simulated: true).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Executor, FillResult, TradeRequest } from '../../src/engine/executor.js';
import type { SellOrder } from '../../src/engine/rules.js';
import type { Rng, Sim } from './sim.js';

/** Which piece of engine work a call belongs to (set by the wrappers in run.ts). */
export interface Ctx {
  kind: 'buy' | 'queue' | 'bag';
  positionId: number;
  order?: SellOrder;
  gen: number;
  inv: number;
  /** The last wallet balance this piece of work was given, and the moment that balance was true. */
  wallet?: { value: bigint; at: number };
}
export const als = new AsyncLocalStorage<Ctx>();

/** value = tokens * price / DEN  (price: lamports per 1e12 base units). */
export const DEN = 1_000_000_000_000n;
export const ATA_RENT = 2_039_280n;

export interface Faults {
  /** Every latency is zero: the market answers inside the same tick. */
  instant: boolean;
  buyFail: number;
  /** Chance that a buy's outcome comes back "unknown" (it may or may not have landed). */
  buyUnsure: number;
  sellFail: number;
  /** Chance that a failed sell starts a run of failures on that coin, and its longest length. */
  streak: number;
  streakMax: number;
  /** Chance that a buy or sell confirms late (3–30 s). */
  slow: number;
  /** Chance that a sell that succeeds sells only part of what was asked. */
  partial: number;
  /** Chance that a failed sell is reported "outcome unknown" although it landed. */
  ghost: number;
  quoteFail: number;
  balFail: number;
  /** Balance reads take up to this long (0: they answer at once), and may show the wallet as it was when asked. */
  balLag: number;
  refineNull: number;
}

export interface OpPlan {
  fail?: string;
  L1: number;
  L2: number;
  L3: number;
  part?: number;
  /** Sell: reported "sent, outcome unknown" although it landed. */
  ghost?: boolean;
  /** Reported "sent, outcome unknown"; in truth it landed, or it never did. (A sell: `ghost` means 'landed'.) */
  unsure?: 'landed' | 'lost';
  refineNull?: boolean;
}
export interface QPlan { fail?: boolean; L: number }
/** A balance read: fails, or answers after L ms with the balance as it is then (late) or as it was when asked. */
export interface BPlan { fail?: boolean; L?: number; late?: boolean }
export interface Tape { buy: OpPlan[]; sell: OpPlan[]; quote: QPlan[]; bal: (BPlan | null)[] }

export const emptyTape = (): Tape => ({ buy: [], sell: [], quote: [], bal: [] });
export const CALM_OP: OpPlan = { L1: 200, L2: 0, L3: 100 };

const SELL_ERRORS = [
  'boom',
  '429 Too Many Requests',
  'sent but did not land: expired before landing',
  'sent but did not land: transaction errored: {"InstructionError":[3,{"Custom":6003}]} (TooLittleSolReceived)',
  'fetch failed',
];
const UNKNOWN = 'sent, outcome unknown: confirmation unknown (RPC unreachable)';

export interface BuyCall {
  id: number; kind: 'buy'; gen: number; t0: number; owner: string; mint: string; pid?: number; ctx?: Ctx;
  lamports: bigint; slippagePct: number; priorityFeeSol: number; tipSol: number; feeBps: number; reqLive: boolean;
  plan: OpPlan; live: boolean;
  /** When the transaction was signed and went out (never, if the engine died first). */
  sentAt?: number;
  landedAt?: number; doneAt?: number; delivered: boolean; severed?: boolean; ok?: boolean; uncertain?: boolean; error?: string; chainFailed?: boolean;
  tokens?: bigint; est?: bigint; exact?: bigint; fee?: bigint; signature?: string; refined?: 'exact' | 'null';
  /** The engine that made the trade was still running when the exact figure arrived. */
  refineSeen?: boolean;
  /** The engine read this buy's own transaction afterwards (settleBuy) and got its exact numbers. */
  settled?: boolean;
}
export interface SellCall {
  id: number; kind: 'sell'; gen: number; t0: number; owner: string; mint: string; pid?: number; ctx?: Ctx;
  asked: bigint; walletAtAsk: bigint; slippagePct: number; priorityFeeSol: number; tipSol: number; feeBps: number;
  exit: boolean; checkFirst: boolean; closeIfEmpty: boolean;
  plan: OpPlan; live: boolean; overAsk: boolean;
  /** What the transaction was built for (after the clamp, when the market clamps). */
  tokens?: bigint;
  /** When the transaction was signed and went out (never, if the engine died first). */
  sentAt?: number;
  landedAt?: number; doneAt?: number; delivered: boolean; severed?: boolean; ok?: boolean; error?: string; ghost?: boolean;
  /** The engine was told "sent, outcome unknown". */
  uncertain?: boolean;
  /** It failed on chain (a later read of the transaction says so). */
  chainFailed?: boolean;
  sold?: bigint; est?: bigint; exact?: bigint; fee?: bigint; signature?: string; refined?: 'exact' | 'null';
  refineSeen?: boolean;
  /** The engine read this sell's own transaction afterwards (settleSell) and got its exact numbers. */
  settled?: boolean;
}

export interface Hooks {
  buyAsk(c: BuyCall): void;
  buyDone(c: BuyCall): void;
  sellAsk(c: SellCall): void;
  /** The moment the wallet changed (before the engine is told). */
  sellLanded(c: SellCall): void;
  sellDone(c: SellCall): void;
  /** The engine asked what became of a sell of unknown outcome; `final`: the answer ends the question. */
  sellSettled(c: SellCall, final: boolean): void;
  /** A balance read for a piece of engine work started (+1) or came back (-1). */
  reading(ctx: Ctx | undefined, d: number): void;
  refined(c: BuyCall | SellCall): void;
  problem(code: string, kind: string, message: string): void;
}

const NEVER = new Promise<never>(() => undefined);
const lam = (sol: number) => BigInt(Math.round(Math.max(0, sol || 0) * 1e9));

export class Exec implements Executor {
  /** False once the engine it belongs to is gone: its pending and future calls never return. */
  alive = true;
  constructor(readonly m: Market, readonly gen: number) {}
  isLive(req: { live: boolean; exit?: boolean }): boolean { return this.m.isLive(req); }
  buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> { return this.m.buy(this, req); }
  sell(req: TradeRequest & { tokens: bigint }): Promise<FillResult> { return this.m.sell(this, req); }
  quoteSell(mint: string, tokens: bigint): Promise<bigint> { return this.m.quoteSell(this, mint, tokens); }
  solBalance(owner: string): Promise<bigint> { return this.m.solBalance(this, owner); }
  tokenBalance(owner: string, mint: string): Promise<bigint> { return this.m.tokenBalance(this, owner, mint); }
  warm(_mint: string): Promise<void> { return this.alive ? Promise.resolve() : NEVER; }
  settleBuy(signature: string, owner: string, mint: string) { return this.m.settleBuy(this, signature, owner, mint); }
  settleSell(signature: string, owner: string, mint: string) { return this.m.settleSell(this, signature, owner, mint); }
}

export class Market {
  readonly price = new Map<string, bigint>();
  private readonly tok = new Map<string, bigint>();
  readonly sol = new Map<string, bigint>();
  readonly leaders = new Set<string>();
  readonly buys: BuyCall[] = [];
  readonly sells: SellCall[] = [];
  /** Trades that landed, by signature. */
  readonly bySig = new Map<string, BuyCall | SellCall>();
  /** Every buy that was signed, landed or not. */
  private readonly signed = new Map<string, BuyCall>();
  /** Every real sell that was signed, landed or not. */
  private readonly signedSells = new Map<string, SellCall>();
  /** Trades asked for and not yet answered, per wallet and coin. */
  private readonly flying = new Map<string, number>();
  private readonly hasAccount = new Set<string>();
  private readonly streaks = new Map<string, number>();
  private readonly cursor = { buy: 0, sell: 0, quote: 0, bal: 0 };
  private n = 0;
  /** Quiescence: every call succeeds promptly, whatever the tape says. */
  calm = false;
  /** Until this moment every trade, quote and balance read fails (an RPC outage). */
  outageUntil = 0;
  hooks!: Hooks;

  constructor(
    readonly sim: Sim,
    /** The owner's Live switch: new buys are real only while it is on. */
    public switchOn: boolean,
    readonly overAsk: 'strict' | 'clamp',
    private readonly faults: Faults,
    private readonly rng: Rng,
    /** Outcomes in call order. In replay mode it is read (missing entries are calm); otherwise it is recorded. */
    readonly tape: Tape,
    private readonly replay: boolean,
  ) {}

  /** As the real executor: a sell of a position bought for real goes out even while the Live switch is off. */
  isLive(req: { live: boolean; exit?: boolean }): boolean {
    return req.live && (this.switchOn || !!req.exit);
  }

  // ── balances and prices ───────────────────────────────────────────────
  tokens(owner: string, mint: string): bigint {
    return this.tok.get(`${owner}|${mint}`) ?? 0n;
  }
  setTokens(owner: string, mint: string, amount: bigint): void {
    if (amount < 0n) {
      this.hooks.problem('W1', 'wallet-negative', `wallet ${owner.slice(0, 4)} would hold ${amount} of ${mint.slice(0, 4)}`);
      amount = 0n;
    }
    this.tok.set(`${owner}|${mint}`, amount);
  }
  value(mint: string, tokens: bigint): bigint {
    return (tokens * this.price.get(mint)!) / DEN;
  }
  /** The most one buy can receive of a coin (its supply is finite: a real amount always fits a u64, and SQLite's INTEGER). */
  readonly cap = new Map<string, bigint>();
  tokensFor(mint: string, lamports: bigint): bigint {
    const t = (lamports * DEN) / this.price.get(mint)!;
    const cap = this.cap.get(mint);
    return cap !== undefined && t > cap ? cap : t;
  }
  inFlight(owner: string, mint: string): number {
    return this.flying.get(`${owner}|${mint}`) ?? 0;
  }
  private bump(owner: string, mint: string, d: number): void {
    const k = `${owner}|${mint}`;
    this.flying.set(k, (this.flying.get(k) ?? 0) + d);
  }
  private outage(): boolean {
    return !this.calm && this.sim.now < this.outageUntil;
  }
  private after(ms: number, fn: () => void): void {
    if (ms <= 0) fn();
    else this.sim.schedule(ms, fn);
  }

  // ── outcomes ──────────────────────────────────────────────────────────
  private calmOp(): OpPlan {
    return this.faults.instant ? { L1: 0, L2: 0, L3: 0 } : CALM_OP;
  }
  private planOp(kind: 'buy' | 'sell', key: string): OpPlan {
    if (this.calm) return this.calmOp();
    const i = this.cursor[kind]++;
    const hit = this.tape[kind][i];
    if (hit) return hit;
    if (this.replay) return this.calmOp();
    const f = this.faults;
    const r = this.rng;
    const plan: OpPlan = {
      L1: f.instant ? 0 : r.chance(f.slow) ? r.int(3_000, 30_000) : r.int(80, 1_500),
      L2: f.instant || r.chance(0.45) ? 0 : r.int(20, 500),
      L3: f.instant ? 0 : r.int(100, 3_000),
    };
    if (kind === 'buy') {
      if (r.chance(f.buyFail)) plan.fail = r.pick(['429 Too Many Requests', 'sent but did not land: transaction errored: {"InstructionError":[3,{"Custom":6002}]} (TooMuchSolRequired)', 'sent but did not land: expired before landing']);
      else if (f.buyUnsure > 0 && r.chance(f.buyUnsure)) plan.unsure = r.chance(0.6) ? 'landed' : 'lost';
    } else {
      const left = this.streaks.get(key) ?? 0;
      if (left > 0) {
        this.streaks.set(key, left - 1);
        plan.fail = 'boom (again)';
      } else if (r.chance(f.sellFail)) {
        plan.fail = r.pick(SELL_ERRORS);
        if (r.chance(f.streak)) this.streaks.set(key, r.int(1, f.streakMax));
      }
      if (!plan.fail && f.partial > 0 && r.chance(f.partial)) plan.part = r.pick([0.1, 0.25, 0.5, 0.75, 0.9]);
      if (plan.fail && f.ghost > 0 && r.chance(f.ghost)) { if (r.chance(0.7)) plan.ghost = true; else plan.unsure = 'lost'; }
    }
    if (f.refineNull > 0 && r.chance(f.refineNull)) plan.refineNull = true;
    this.tape[kind][i] = plan;
    return plan;
  }
  private planQuote(): QPlan {
    const calm: QPlan = { L: this.faults.instant ? 0 : 50 };
    if (this.calm) return calm;
    const i = this.cursor.quote++;
    const hit = this.tape.quote[i];
    if (hit) return hit;
    if (this.replay) return calm;
    const f = this.faults;
    const plan: QPlan = { L: f.instant ? 0 : this.rng.chance(0.3) ? 0 : this.rng.int(10, 600) };
    if (this.rng.chance(f.quoteFail)) plan.fail = true;
    this.tape.quote[i] = plan;
    return plan;
  }
  private planBal(): BPlan {
    if (this.calm) return {};
    const i = this.cursor.bal++;
    const hit = this.tape.bal[i];
    if (hit) return hit;
    if (this.replay) return {};
    const f = this.faults;
    const plan: BPlan = {};
    if (f.balFail > 0 && this.rng.chance(f.balFail)) plan.fail = true;
    if (f.balLag > 0 && this.rng.chance(0.8)) { plan.L = this.rng.int(10, f.balLag); if (this.rng.chance(0.5)) plan.late = true; }
    // Only reads that are not plain are written down (the tape stays small): a hole reads as "answers at once".
    if (plan.fail || plan.L) this.tape.bal[i] = plan;
    return plan;
  }

  // ── Executor ──────────────────────────────────────────────────────────
  buy(exec: Exec, req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    if (!exec.alive) return NEVER;
    const ctx = als.getStore();
    const owner = req.wallet.publicKey.toBase58();
    const mint = req.mint;
    const live = this.isLive(req);
    const plan = this.planOp('buy', `${owner}|${mint}`);
    const call: BuyCall = {
      id: ++this.n, kind: 'buy', gen: exec.gen, t0: this.sim.now, owner, mint, pid: ctx?.positionId, ctx, lamports: req.lamports,
      slippagePct: req.slippagePct, priorityFeeSol: req.priorityFeeSol, tipSol: req.tipSol, feeBps: req.feeBps, reqLive: req.live, plan, live, delivered: false,
    };
    this.buys.push(call);
    this.bump(owner, mint, 1);
    this.hooks.buyAsk(call);
    return new Promise<FillResult>((resolve) => {
      const deliver = (res: FillResult) => {
        call.doneAt = this.sim.now;
        call.ok = res.ok;
        if (!res.ok) { call.error = res.error; call.uncertain = !!res.uncertain; }
        this.bump(owner, mint, -1);
        if (!exec.alive) { call.severed = true; this.hooks.buyDone(call); return; }
        call.delivered = true;
        this.hooks.buyDone(call);
        resolve(res);
      };
      if (this.outage()) return this.after(Math.min(plan.L1, 250), () => deliver({ ok: false, error: 'fetch failed' }));
      const fee = (req.lamports * BigInt(Math.floor(req.feeBps))) / 10_000n;
      const txc = 5_000n + lam(req.priorityFeeSol) + lam(req.tipSol);
      const est = req.lamports + fee + txc;
      if (!live) {
        // A test buy: filled from the quote, nothing sent, nothing held.
        return this.after(plan.L1, () => {
          if (plan.fail) return deliver({ ok: false, error: plan.fail });
          const tokens = this.tokensFor(mint, req.lamports);
          if (tokens <= 0n) return deliver({ ok: false, error: 'the quote returned zero tokens' });
          Object.assign(call, { tokens, fee, est, exact: est, signature: `PAPER_B${call.id}`, landedAt: this.sim.now });
          this.bySig.set(call.signature!, call);
          deliver({ ok: true, signature: call.signature!, tokens, lamports: est, simulated: true, feeLamports: fee, note: 'test fill' });
        });
      }
      // A real buy: built and signed first (the engine is told the signature), then it is out of our hands.
      const signAt = Math.min(40, plan.L1);
      this.after(signAt, () => {
        if (!exec.alive) { call.severed = true; this.bump(owner, mint, -1); this.hooks.buyDone(call); return; }
        call.signature = `B${call.id}`;
        call.sentAt = this.sim.now;
        this.signed.set(call.signature, call);
        try { req.onSigned?.(call.signature); } catch { /* the real executor ignores it too */ }
        this.after(plan.L1 - signAt, () => {
          if (plan.unsure === 'lost') return this.after(plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
          if (plan.fail) { call.chainFailed = /errored/.test(plan.fail); return deliver({ ok: false, error: plan.fail }); }
          const tokens = this.tokensFor(mint, req.lamports);
          if (tokens <= 0n) { call.chainFailed = true; return deliver({ ok: false, error: 'sent but did not land: transaction errored: zero tokens out' }); }
          const acct = `${owner}|${mint}`;
          const exact = est + (this.hasAccount.has(acct) ? 0n : ATA_RENT);
          const have = this.sol.get(owner) ?? 0n;
          if (have < exact) { call.chainFailed = true; return deliver({ ok: false, error: 'sent but did not land: transaction errored: Transfer: insufficient lamports' }); }
          this.hasAccount.add(acct);
          this.sol.set(owner, have - exact);
          this.setTokens(owner, mint, this.tokens(owner, mint) + tokens);
          Object.assign(call, { tokens, fee, est, exact, landedAt: this.sim.now });
          this.bySig.set(call.signature!, call);
          const landedAt = this.sim.now;
          if (plan.unsure === 'landed') return this.after(plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
          const refine = new Promise<{ lamports: bigint } | null>((res) => {
            this.after(plan.L2 + plan.L3 + 1, () => {
              call.refined = plan.refineNull ? 'null' : 'exact';
              call.refineSeen = exec.alive;
              this.hooks.refined(call);
              if (exec.alive) res(plan.refineNull ? null : { lamports: exact });
            });
          });
          this.after(plan.L2, () => deliver({ ok: true, signature: call.signature!, tokens, lamports: est, simulated: false, feeLamports: fee, confirmedAt: landedAt, refine }));
        });
      });
    });
  }

  /** What became of a buy, from its own transaction (the engine's restore() asks). */
  settleBuy(exec: Exec, signature: string, _owner: string, _mint: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' | 'not_found' }> {
    if (!exec.alive) return NEVER;
    if (this.planBal().fail || this.outage()) return Promise.reject(new Error('429 Too Many Requests'));
    const c = this.signed.get(signature);
    if (!c) return Promise.resolve({ state: 'not_found' });
    if (c.landedAt !== undefined) {
      c.settled = true;
      return Promise.resolve({ state: 'landed', tokens: c.tokens!, lamports: c.exact! });
    }
    return Promise.resolve({ state: c.chainFailed ? 'failed' : 'not_found' });
  }

  /** What became of a sell of unknown outcome, from its own transaction (the engine asks before it sells again). */
  settleSell(exec: Exec, signature: string, _owner: string, _mint: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' | 'not_found' }> {
    if (!exec.alive) return NEVER;
    if (this.planBal().fail || this.outage()) return Promise.reject(new Error('429 Too Many Requests'));
    const c = this.signedSells.get(signature);
    if (!c) return Promise.resolve({ state: 'not_found' });
    if (c.landedAt !== undefined) {
      c.settled = true;
      this.hooks.sellSettled(c, true);
      return Promise.resolve({ state: 'landed', tokens: c.sold!, lamports: c.exact! });
    }
    this.hooks.sellSettled(c, !!c.chainFailed || this.sim.now - c.t0 > 120_000);
    return Promise.resolve({ state: c.chainFailed ? 'failed' : 'not_found' });
  }

  sell(exec: Exec, req: TradeRequest & { tokens: bigint }): Promise<FillResult> {
    if (!exec.alive) return NEVER;
    const ctx = als.getStore();
    const owner = req.wallet.publicKey.toBase58();
    const mint = req.mint;
    const live = this.isLive(req);
    const wallet = live ? this.tokens(owner, mint) : 0n;
    const plan = this.planOp('sell', `${owner}|${mint}`);
    const call: SellCall = {
      id: ++this.n, kind: 'sell', gen: exec.gen, t0: this.sim.now, owner, mint, pid: ctx?.positionId, ctx, asked: req.tokens, walletAtAsk: wallet,
      slippagePct: req.slippagePct, priorityFeeSol: req.priorityFeeSol, tipSol: req.tipSol, feeBps: req.feeBps,
      exit: !!req.exit, checkFirst: !!req.checkFirst, closeIfEmpty: !!req.closeIfEmpty, plan, live, overAsk: live && req.tokens > wallet, delivered: false,
    };
    this.sells.push(call);
    this.bump(owner, mint, 1);
    this.hooks.sellAsk(call);
    return new Promise<FillResult>((resolve) => {
      const deliver = (res: FillResult) => {
        call.doneAt = this.sim.now;
        call.ok = res.ok;
        if (!res.ok) { call.error = res.error; call.uncertain = !!res.uncertain; }
        this.bump(owner, mint, -1);
        if (!exec.alive) { call.severed = true; this.hooks.sellDone(call); return; }
        call.delivered = true;
        this.hooks.sellDone(call);
        resolve(res);
      };
      if (this.outage()) return this.after(Math.min(plan.L1, 250), () => deliver({ ok: false, error: 'fetch failed' }));
      let tokens = req.tokens;
      if (call.overAsk) {
        // The task's rule: a sell asking for more than the wallet holds fails. 'clamp' is what the real executor
        // does instead (it builds the sell for what the wallet's token account holds).
        if (this.overAsk === 'strict') return this.after(Math.min(plan.L1, 300), () => deliver({ ok: false, error: 'sent but did not land: transaction errored: {"InstructionError":[2,{"Custom":1}]} (asked for more than the wallet holds)' }));
        tokens = wallet;
        if (tokens <= 0n) return this.after(Math.min(plan.L1, 150), () => deliver({ ok: false, error: 'the wallet holds none of this coin' }));
      }
      call.tokens = tokens;
      const bps = BigInt(Math.floor(req.feeBps));
      const txc = 5_000n + lam(req.priorityFeeSol) + lam(req.tipSol);
      const gross0 = this.value(mint, tokens);
      const fee0 = (gross0 * bps) / 10_000n;
      const est0 = gross0 - fee0 - txc;
      // As the real executor: the token account is closed (its rent returns) when the sell was built for all of it.
      const closing = live && !!req.closeIfEmpty && !req.checkFirst && tokens === wallet;
      if (live) {
        // Built and signed: the engine is told the signature before the transaction goes out.
        call.signature = `S${call.id}`;
        call.sentAt = this.sim.now;
        this.signedSells.set(call.signature, call);
        try { req.onSigned?.(call.signature); } catch { /* the real executor ignores it too */ }
      }
      const unknownLost = live && plan.unsure === 'lost';
      this.after(plan.L1, () => {
        if (unknownLost) return this.after(plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
        if (plan.fail && !plan.ghost) { call.chainFailed = /errored/.test(plan.fail); return deliver({ ok: false, error: plan.fail }); }
        const part = (t: bigint) => {
          if (!plan.part) return t;
          const p = (t * BigInt(Math.round(plan.part * 1000))) / 1000n;
          return p > 0n ? p : 1n;
        };
        if (!live) {
          if (plan.fail) return deliver({ ok: false, error: plan.fail });
          const sold = part(tokens);
          const gross = this.value(mint, sold);
          const fee = (gross * bps) / 10_000n;
          const net = gross - fee - txc;
          Object.assign(call, { sold, est: net, exact: net, fee, signature: `PAPER_S${call.id}`, landedAt: this.sim.now });
          this.bySig.set(call.signature!, call);
          return deliver({ ok: true, signature: call.signature!, tokens: sold, lamports: net, simulated: true, feeLamports: fee, note: 'test fill' });
        }
        const heldNow = this.tokens(owner, mint);
        if (tokens > heldNow) { call.chainFailed = true; return deliver({ ok: false, error: 'sent but did not land: transaction errored: {"InstructionError":[2,{"Custom":1}]}' }); }
        const have = this.sol.get(owner) ?? 0n;
        if (have < txc) { call.chainFailed = true; return deliver({ ok: false, error: 'sent but did not land: transaction errored: Transfer: insufficient lamports (cannot pay the fee)' }); }
        const sold = part(tokens);
        const gross = this.value(mint, sold);
        const fee = (gross * bps) / 10_000n;
        let net = gross - fee - txc;
        // (a market that can pay for only part is known when the sell is built: such a sell does not close the account)
        if (closing && heldNow === sold) { net += ATA_RENT; this.hasAccount.delete(`${owner}|${mint}`); }
        this.setTokens(owner, mint, heldNow - sold);
        this.sol.set(owner, have + net);
        const est = sold === tokens ? est0 : (est0 * sold) / tokens;
        Object.assign(call, { sold, est, exact: net, fee, landedAt: this.sim.now });
        this.bySig.set(call.signature!, call);
        this.hooks.sellLanded(call);
        if (plan.fail && plan.ghost) {
          call.ghost = true;
          return this.after(plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
        }
        const landedAt = this.sim.now;
        const refine = new Promise<{ lamports: bigint } | null>((res) => {
          this.after(plan.L2 + plan.L3 + 1, () => {
            call.refined = plan.refineNull ? 'null' : 'exact';
            call.refineSeen = exec.alive;
            this.hooks.refined(call);
            if (exec.alive) res(plan.refineNull ? null : { lamports: net });
          });
        });
        this.after(plan.L2, () => deliver({ ok: true, signature: call.signature!, tokens: sold, lamports: est, simulated: false, feeLamports: fee, confirmedAt: landedAt, refine }));
      });
    });
  }

  quoteSell(exec: Exec, mint: string, tokens: bigint): Promise<bigint> {
    if (!exec.alive) return NEVER;
    const plan = this.planQuote();
    const down = this.outage();
    return new Promise<bigint>((resolve, reject) => {
      this.after(plan.L, () => {
        if (!exec.alive) return;
        if (plan.fail || down) reject(new Error('429 Too Many Requests'));
        else resolve(this.value(mint, tokens));
      });
    });
  }

  solBalance(exec: Exec, owner: string): Promise<bigint> {
    if (!exec.alive) return NEVER;
    return Promise.resolve(this.sol.get(owner) ?? 0n);
  }

  /** The truth, possibly a moment old. (In test mode nothing is ever held: test buys do not touch the wallet.) */
  tokenBalance(exec: Exec, owner: string, mint: string): Promise<bigint> {
    if (!exec.alive) return NEVER;
    const plan = this.planBal();
    const down = this.outage();
    const ctx = als.getStore();
    const asked = this.sim.now;
    const early = this.tokens(owner, mint);
    if (!plan.L) {
      if (plan.fail || down) return Promise.reject(new Error('429 Too Many Requests'));
      if (ctx) ctx.wallet = { value: early, at: asked };
      return Promise.resolve(early);
    }
    this.hooks.reading(ctx, 1);
    return new Promise<bigint>((resolve, reject) => {
      this.sim.schedule(plan.L!, () => {
        this.hooks.reading(ctx, -1);
        if (!exec.alive) return;
        if (plan.fail || down) return reject(new Error('429 Too Many Requests'));
        const value = plan.late ? this.tokens(owner, mint) : early;
        if (ctx) ctx.wallet = { value, at: plan.late ? this.sim.now : asked };
        resolve(value);
      });
    });
  }
}
