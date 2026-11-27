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
  /** Chance that a real buy is handed back with the quote's coin count (the wallet and the transaction could not be
   *  read within a second of the confirmation); the exact count follows later with the exact SOL (`refine`). */
  quoted?: number;
  /** Chance that a status read of a sell (settleSell) is answered by a node some blocks behind the chain's tip, and
   *  how many blocks behind at most (1 to this, at most STATUS_LAG_LIMIT). Such a node sees the chain as it was then: a
   *  sale that landed after that is "not found" by it, and its answer carries the slot it has reached. */
  statusLag?: number;
  statusLagMax?: number;
  /** Chance that a real sell that lands does so in the last blocks its blockhash allows: at a height from its last
   *  valid height − 3 to one past it (the chain takes a blockhash one block longer), about a minute after it was
   *  signed, instead of within the 30 s of `L1`. Where it is on, a sell that never lands ("expired before landing") is
   *  told so only once the chain is past the last block it could land in, as the executor tells it. */
  lateLand?: number;
}

export interface OpPlan {
  fail?: string;
  L1: number;
  L2: number;
  L3: number;
  part?: number;
  /** A real buy handed back with the quote's coin count: the wallet really received this many times the quote
   *  (0.9: a tenth fewer coins than quoted). The exact count follows with the exact SOL, L3 after the answer. */
  quoted?: number;
  /** Sell: reported "sent, outcome unknown" although it landed. */
  ghost?: boolean;
  /** Reported "sent, outcome unknown"; in truth it landed, or it never did. (A sell: `ghost` means 'landed'.) */
  unsure?: 'landed' | 'lost';
  refineNull?: boolean;
  /** A real sell that lands late (`lateLand`): in the block at its last valid height plus this (−3 to +1), `lateAt` ms
   *  into that block. Replaces L1 (a replay lands it in the same block of its blockhash's life, whenever it was sent).
   *  A sell that never lands ("expired before landing") is told so in the block at its last valid height plus this
   *  (+2 to +4): the chain is past the last block it could land in. */
  late?: number;
  lateAt?: number;
}
export interface QPlan { fail?: boolean; L: number }
/** A balance read: fails, or answers after L ms with the balance as it is then (late) or as it was when asked. */
export interface BPlan { fail?: boolean; L?: number; late?: boolean }
/** A database write that fails (profile dbfault): 'full' = "database or disk is full", 'io' = "disk I/O error".
 *  `m`: the store method it was (for the reader; a replay goes by the write's number only). */
export interface DbPlan { err: 'full' | 'io'; m?: string }
/** `db` (dbfault only): the database writes that fail, by their number among the writes that change something.
 *  `status` (statusLag only): how many blocks behind the tip the node answering each status read of a sell is, by the
 *  read's number (a hole: up to date). */
export interface Tape { buy: OpPlan[]; sell: OpPlan[]; quote: QPlan[]; bal: (BPlan | null)[]; db?: (DbPlan | null)[]; status?: (number | null)[] }

export const emptyTape = (): Tape => ({ buy: [], sell: [], quote: [], bal: [] });
export const CALM_OP: OpPlan = { L1: 200, L2: 0, L3: 100 };

const EXPIRED = 'sent but did not land: expired before landing';
const SELL_ERRORS = [
  'boom',
  '429 Too Many Requests',
  EXPIRED,
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
  /** The buy was handed back with this, the quote's coin count, while the wallet received `tokens`. */
  quotedTokens?: bigint;
  /** Signed, then not sent: its onSigned callback threw (as the executor does since 67c9307; not with FUZZ_NO_RECORD_NO_SEND=0). */
  notSent?: boolean;
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
  /** It failed on chain (a later read of the transaction says so), at `failedAt`. */
  chainFailed?: boolean;
  failedAt?: number;
  /** A real sell: the last block height its blockhash is valid for (as the executor tells it when it is signed). It can
   *  land up to one block past it, never later. */
  lastValid?: number;
  sold?: bigint; est?: bigint; exact?: bigint; fee?: bigint; signature?: string; refined?: 'exact' | 'null';
  refineSeen?: boolean;
  /** The engine read this sell's own transaction afterwards (settleSell) and got its exact numbers. */
  settled?: boolean;
  /** Signed, then not sent: its onSigned callback threw (as the executor does since 67c9307; not with FUZZ_NO_RECORD_NO_SEND=0). */
  notSent?: boolean;
  /** Set by run.ts: its row in sells_out could not be written (the write failed when it was signed). */
  outFailed?: boolean;
  /** Set by run.ts: times the engine's booking of this sale was rolled back (a database write failed). */
  unbooked?: number;
}

export interface Hooks {
  buyAsk(c: BuyCall): void;
  buyDone(c: BuyCall): void;
  sellAsk(c: SellCall): void;
  /** The moment the wallet changed (before the engine is told). */
  sellLanded(c: SellCall): void;
  sellDone(c: SellCall): void;
  /** The engine read what became of a sell from its own transaction, and was told `answer` (by a node `answer.lag`
   *  blocks behind the tip: what landed after the block it has reached is "not found" to it). `final`: the engine takes
   *  the answer as the end of a sell of unknown outcome (landed, failed, or not found 120 s after it was sent). */
  sellSettled(c: SellCall, answer: StatusAnswer, final: boolean): void;
  /** A balance read for a piece of engine work started (+1) or came back (-1). */
  reading(ctx: Ctx | undefined, d: number): void;
  refined(c: BuyCall | SellCall): void;
  problem(code: string, kind: string, message: string): void;
}

/** What a status read of a sell told the engine: landed, failed, or not found with the slot the answering node had
 *  reached; `lag`: how many blocks behind the tip that node was (0: up to date); `at`: when. */
export interface StatusAnswer { state: 'landed' | 'failed' | 'not_found'; slot?: number; lag: number; at: number }
/** A chain tip handed to the engine (null: the read failed), and when. */
export interface TipRead { at: number; tip: { height: number; slot: number } | null }

const NEVER = new Promise<never>(() => undefined);
const lam = (sol: number) => BigInt(Math.round(Math.max(0, sol || 0) * 1e9));

export class Exec implements Executor {
  /** False once the engine it belongs to is gone: its pending and future calls never return. */
  alive = true;
  /** The last chain tip this engine was handed, and the last status read of each sell it made with the tip it had read
   *  at that same moment (the harness counts which of the engine's rules dropped a sell left behind). */
  lastTip?: TipRead;
  readonly reads = new Map<string, StatusAnswer & { tip?: TipRead['tip'] }>();
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
  blockHeight() { return this.m.blockHeight(this); }
  chainTip() { return this.m.chainTip(this); }
}

/**
 * One block every 400 ms; a transaction's blockhash is valid for 150 blocks after it is signed (about a minute), and
 * the chain takes it one block longer (src/chain/connection.ts, LAST_BLOCK_PAST_VALID). A sell lands within 30 s of
 * being signed (planOp's L1), or late, in the last blocks it can (`lateLand`: from its last valid height − 3 to one
 * past it), or never: none ever lands after that. Every block has a slot, strictly increasing with the height, about
 * one slot in ten skipped (no block in it).
 */
const BLOCK_MS = 400;
export const VALID_BLOCKS = 150;
const SKIPPED_SLOTS = 0.1;
/** How far behind the tip a status node may be, in blocks: under the engine's WELL_PAST_BLOCKS (30), beyond which it
 *  believes "not found" from any node (a node more than 30 blocks behind is that rule's documented, accepted limit). */
export const STATUS_LAG_LIMIT = 25;
/** The engine takes a sell of unknown outcome that is still not found this long after it was sent for one that never
 *  landed (Engine.settleUnknownSell). */
const UNKNOWN_GIVES_UP_MS = 120_000;

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
  private readonly cursor = { buy: 0, sell: 0, quote: 0, bal: 0, status: 0 };
  private n = 0;
  /** The height the scenario starts at, its slot, and the slots of the blocks since (drawn as the chain gets there). */
  private readonly h0: number;
  private readonly slots: number[];
  /** What the chain model did (reported with the run): sales that landed late, status reads from a node behind, and
   *  those of them that did not see a sale (or a failure) that was already in a block. */
  readonly counts = { lateLandings: 0, statusReads: 0, laggedReads: 0, laggedMisses: 0, tipReads: 0 };
  /** Quiescence: every call succeeds promptly, whatever the tape says. */
  calm = false;
  /** Until this moment every trade, quote and balance read fails (an RPC outage). */
  outageUntil = 0;
  /**
   * As the executor does (since 67c9307): a trade whose onSigned callback throws (the engine could not write the trade
   * down before it goes out) is not sent; it answers { ok: false } at once and never reaches the chain. Off
   * (FUZZ_NO_RECORD_NO_SEND=0): as the executor did before, it ignores the throw and sends the trade anyway. A saved
   * scenario that says `noRecordNoSend` sets it (run.ts).
   */
  noRecordNoSend = process.env.FUZZ_NO_RECORD_NO_SEND !== '0';
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
    /** The slots' own random stream (run.ts derives it from the seed): the chain's slots replay with the seed, and the
     *  outcomes' stream is left as it was. */
    private readonly slotRng: Rng,
  ) {
    this.h0 = this.height();
    // (slots run ahead of heights, as on mainnet, where every skipped slot since genesis widened the gap)
    this.slots = [this.h0 + 1_000_000];
  }

  // ── the chain's height and slots ──────────────────────────────────────
  /** The chain's (confirmed) block height at a moment (now by default). */
  height(at = this.sim.now): number {
    return Math.floor(at / BLOCK_MS);
  }
  /** The slot of the block at height h: strictly increasing with the height, about one slot in ten skipped. */
  slotAt(h: number): number {
    const i = h - this.h0;
    if (i < 0) return this.slots[0]! + i; // (before the scenario: nothing skipped)
    while (this.slots.length <= i) {
      let gap = 1;
      while (this.slotRng.chance(SKIPPED_SLOTS)) gap++;
      this.slots.push(this.slots[this.slots.length - 1]! + gap);
    }
    return this.slots[i]!;
  }

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
      else if ((f.quoted ?? 0) > 0 && r.chance(f.quoted!)) plan.quoted = r.pick([0.7, 0.9, 0.97, 1.03, 1.1, 1.3]);
    } else {
      const left = this.streaks.get(key) ?? 0;
      if (left > 0) {
        this.streaks.set(key, left - 1);
        plan.fail = 'boom (again)';
      } else if (r.chance(f.sellFail)) {
        // (where sells land late, the chain is congested: half the failures are sells that never landed and expired)
        plan.fail = (f.lateLand ?? 0) > 0 && r.chance(0.5) ? EXPIRED : r.pick(SELL_ERRORS);
        if (r.chance(f.streak)) this.streaks.set(key, r.int(1, f.streakMax));
      }
      if (!plan.fail && f.partial > 0 && r.chance(f.partial)) plan.part = r.pick([0.1, 0.25, 0.5, 0.75, 0.9]);
      if (plan.fail && f.ghost > 0 && r.chance(f.ghost)) { if (r.chance(0.7)) plan.ghost = true; else plan.unsure = 'lost'; }
      // (only a sell that lands can land late; and where sells land late, one that never lands is told "expired before
      // landing" as the executor tells it, once the chain is past the last block it could land in: on its way until then)
      if ((f.lateLand ?? 0) > 0 && (!plan.fail || plan.ghost) && r.chance(f.lateLand!)) { plan.late = r.int(-3, 1); plan.lateAt = r.int(0, BLOCK_MS - 1); }
      else if ((f.lateLand ?? 0) > 0 && plan.fail === EXPIRED && !plan.ghost && !plan.unsure) { plan.late = r.int(2, 4); plan.lateAt = r.int(0, BLOCK_MS - 1); }
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
  /** How many blocks behind the tip the node answering this status read of a sell is (0: up to date). */
  private planStatus(): number {
    if (this.calm) return 0;
    const i = this.cursor.status++;
    const hit = this.tape.status?.[i];
    if (hit) return Math.min(hit, STATUS_LAG_LIMIT);
    if (this.replay) return 0;
    const f = this.faults;
    if (!((f.statusLag ?? 0) > 0) || !this.rng.chance(f.statusLag!)) return 0;
    const lag = this.rng.int(1, Math.max(1, Math.min(f.statusLagMax ?? STATUS_LAG_LIMIT, STATUS_LAG_LIMIT)));
    (this.tape.status ??= [])[i] = lag;
    return lag;
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
        try {
          req.onSigned?.(call.signature);
        } catch (err) {
          // Today's executor ignores it and sends the buy anyway; the fixed one does not send it.
          if (this.noRecordNoSend) {
            call.sentAt = undefined;
            call.notSent = true;
            return deliver({ ok: false, error: `could not be written down before sending it: ${(err as Error)?.message ?? String(err)}` });
          }
        }
        this.after(plan.L1 - signAt, () => {
          if (plan.unsure === 'lost') return this.after(plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
          if (plan.fail) { call.chainFailed = /errored/.test(plan.fail); return deliver({ ok: false, error: plan.fail }); }
          // What the quote said, and what the wallet really receives (the price moved before the buy landed).
          const quote = this.tokensFor(mint, req.lamports);
          const tokens = plan.quoted ? (quote * BigInt(Math.round(plan.quoted * 1000))) / 1000n : quote;
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
          // As the real executor: when neither the wallet nor the transaction could be read within a second, the buy
          // is handed back with the quote's coin count and the exact count follows with the exact SOL.
          if (plan.quoted) call.quotedTokens = quote;
          const refine = new Promise<{ lamports: bigint; tokens?: bigint } | null>((res) => {
            this.after(plan.L2 + plan.L3 + 1, () => {
              call.refined = plan.refineNull ? 'null' : 'exact';
              call.refineSeen = exec.alive;
              this.hooks.refined(call);
              if (exec.alive) res(plan.refineNull ? null : { lamports: exact, ...(plan.quoted ? { tokens } : {}) });
            });
          });
          this.after(plan.L2, () => deliver({ ok: true, signature: call.signature!, tokens: plan.quoted ? quote : tokens, lamports: est, simulated: false, feeLamports: fee, confirmedAt: landedAt, refine }));
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
      // (the exact figures, coins included, have reached the engine from here on)
      if (!c.settled && c.delivered && c.ok && exec.alive) { c.refined = 'exact'; c.refineSeen = true; this.hooks.refined(c); }
      c.settled = true;
      return Promise.resolve({ state: 'landed', tokens: c.tokens!, lamports: c.exact! });
    }
    return Promise.resolve({ state: c.chainFailed ? 'failed' : 'not_found' });
  }

  /** The chain's block height (it can be read only when the RPC answers). */
  blockHeight(exec: Exec): Promise<number> {
    if (!exec.alive) return NEVER;
    if (this.planBal().fail || this.outage()) return Promise.reject(new Error('429 Too Many Requests'));
    return Promise.resolve(this.height());
  }

  /** The chain's confirmed tip: its height and that block's slot, from one node (as the executor reads it with
   *  getEpochInfo('confirmed')); it can be read only when the RPC answers. */
  chainTip(exec: Exec): Promise<{ height: number; slot: number }> {
    if (!exec.alive) return NEVER;
    this.counts.tipReads++;
    if (this.planBal().fail || this.outage()) {
      exec.lastTip = { at: this.sim.now, tip: null };
      return Promise.reject(new Error('429 Too Many Requests'));
    }
    const height = this.height();
    const tip = { height, slot: this.slotAt(height) };
    exec.lastTip = { at: this.sim.now, tip };
    return Promise.resolve({ ...tip });
  }

  /**
   * What became of a sell, from its own transaction (the engine asks about a sell of unknown outcome before it sells
   * again, about a sell left behind by a restart, and for the exact SOL of a sale). The answer comes from a node that
   * may be some blocks behind the tip (`statusLag`): it sees the chain as it was at the block it has reached, so a
   * sale (or a failure) put in a block after that is "not found" to it. A "not found" carries the slot of the block
   * the node has reached (an up-to-date node's is the tip's), as the executor passes on the answer's context slot.
   */
  settleSell(exec: Exec, signature: string, _owner: string, _mint: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' } | { state: 'not_found'; slot: number }> {
    if (!exec.alive) return NEVER;
    if (this.planBal().fail || this.outage()) return Promise.reject(new Error('429 Too Many Requests'));
    const tip = this.height();
    const c = this.signedSells.get(signature);
    if (!c) return Promise.resolve({ state: 'not_found', slot: this.slotAt(tip) });
    const lag = this.planStatus();
    // The newest block the answering node has.
    const seen = tip - lag;
    const landed = c.landedAt !== undefined && this.height(c.landedAt) <= seen;
    const failed = !landed && !!c.chainFailed && c.failedAt !== undefined && this.height(c.failedAt) <= seen;
    this.counts.statusReads++;
    if (lag) {
      this.counts.laggedReads++;
      if (!landed && !failed && (c.landedAt !== undefined || c.chainFailed)) this.counts.laggedMisses++;
    }
    const answer: StatusAnswer = { state: landed ? 'landed' : failed ? 'failed' : 'not_found', ...(landed || failed ? {} : { slot: this.slotAt(seen) }), lag, at: this.sim.now };
    exec.reads.set(signature, { ...answer, ...(exec.lastTip?.at === this.sim.now ? { tip: exec.lastTip.tip } : {}) });
    if (landed) c.settled = true;
    // (the engine gives up on a sell of unknown outcome that is still not found 120 s after it was sent)
    this.hooks.sellSettled(c, answer, answer.state !== 'not_found' || this.sim.now - c.t0 > UNKNOWN_GIVES_UP_MS);
    if (landed) return Promise.resolve({ state: 'landed', tokens: c.sold!, lamports: c.exact! });
    if (failed) return Promise.resolve({ state: 'failed' });
    return Promise.resolve({ state: 'not_found', slot: answer.slot! });
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
        // As the real executor: told with its blockhash's last valid height, the fee it carries (from the quote) and
        // whether the market can pay for only part of it.
        const info = { lastValidBlockHeight: this.height() + VALID_BLOCKS, feeLamports: fee0, marketShort: !!plan.part };
        call.lastValid = info.lastValidBlockHeight;
        try {
          req.onSigned?.(call.signature, info);
        } catch (err) {
          // Today's executor ignores it and sends the sell anyway; the fixed one does not send it (nothing lands).
          if (this.noRecordNoSend) {
            call.sentAt = undefined;
            call.notSent = true;
            return deliver({ ok: false, error: `could not be written down before sending it: ${(err as Error)?.message ?? String(err)}` });
          }
        }
      }
      const unknownLost = live && plan.unsure === 'lost';
      // A real sell whose plan says `late` has its fate decided near the end of its blockhash's life, instead of after
      // L1: one that lands goes into the block its plan names (its last valid height −3 to +1, about a minute after it
      // was signed); one that never lands is told "expired before landing" once the chain is past the last block it
      // could land in (+2 to +4), as the executor tells it.
      const lands = !unknownLost && (!plan.fail || !!plan.ghost);
      const expires = !lands && !unknownLost && plan.fail === EXPIRED;
      const late = live && (lands || expires) && plan.late !== undefined && call.lastValid !== undefined ? (lands ? Math.min(Math.max(plan.late, -3), 1) : Math.max(plan.late, 2)) : undefined;
      const landIn = late !== undefined ? Math.max(0, (call.lastValid! + late) * BLOCK_MS + Math.min(Math.max(plan.lateAt ?? 0, 0), BLOCK_MS - 1) - this.sim.now) : plan.L1;
      this.after(landIn, () => {
        if (unknownLost) return this.after(plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
        if (plan.fail && !plan.ghost) {
          call.chainFailed = /errored/.test(plan.fail);
          if (call.chainFailed) call.failedAt = this.sim.now;
          return deliver({ ok: false, error: plan.fail });
        }
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
        if (tokens > heldNow) { call.chainFailed = true; call.failedAt = this.sim.now; return deliver({ ok: false, error: 'sent but did not land: transaction errored: {"InstructionError":[2,{"Custom":1}]}' }); }
        const have = this.sol.get(owner) ?? 0n;
        if (have < txc) { call.chainFailed = true; call.failedAt = this.sim.now; return deliver({ ok: false, error: 'sent but did not land: transaction errored: Transfer: insufficient lamports (cannot pay the fee)' }); }
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
        if (call.lastValid !== undefined && this.height() > call.lastValid + 1) this.hooks.problem('E4', 'fake-chain-sale-landed-after-its-blockhash', `sell#${call.id} landed at height ${this.height()}, past ${call.lastValid + 1}, the last block its blockhash allows`);
        if (call.lastValid !== undefined && this.height() >= call.lastValid - 3) this.counts.lateLandings++;
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
        this.after(plan.L2, () => deliver({ ok: true, signature: call.signature!, tokens: sold, lamports: est, simulated: false, feeLamports: fee, confirmedAt: landedAt, refine, marketShort: !!plan.part }));
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
