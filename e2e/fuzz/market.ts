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
  /** Chance that a status read of a sell (settleSell) is answered by a node some blocks behind the chain's confirmed
   *  tip, and how many blocks behind at most (1 to this, at most STATUS_LAG_LIMIT). Such a node sees the chain as it
   *  was then: a sale that landed after that is "not found" by it, and its answer carries the slot it has reached. */
  statusLag?: number;
  statusLagMax?: number;
  /** Chance that a status read is answered by a node on a minority fork of 1 to 3 slots: it has not seen the main
   *  fork's last 1 to 3 blocks, and the context slot of its "not found" (its own fork's newest) is at least the tip's. */
  forkRead?: number;
  /** Chance that a status node is behind on its confirmations: it has the newest blocks, but has confirmed only up to
   *  1 to `confBehindMax` blocks less. A sale in a block it has and has not confirmed: settleSell throws "seen in a
   *  block, not confirmed yet", as the executor does, until a node that has confirmed it answers. */
  confBehind?: number;
  confBehindMax?: number;
  /** Chance that a tip read (chainTip) is answered by a node 1 to 3 blocks behind the confirmed tip. */
  tipBehind?: number;
  /** Chance that a status answer "not found" carries no slot (an executor that cannot tell how far along the node
   *  that answered was). */
  noSlot?: number;
  /** Chance that a real sell that lands does so in the last blocks its blockhash allows: at a height from its last
   *  valid height − 3 to one past it (the chain takes a blockhash one block longer), about a minute after it was
   *  signed, instead of within the 30 s of `L1`. Where it is on, a sell that never lands ("expired before landing") is
   *  told so only once the chain is past the last block it could land in, as the executor tells it. */
  lateLand?: number;
}

/** A slow period of the chain: from `at` ms after the start, for `ms`, a block about every `blockMs` (whole leader
 *  windows of four slots are skipped, as when leaders are offline, besides the usual one slot in ten). */
export interface SlowPeriod { at: number; ms: number; blockMs: number }

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
  /** A real sell that lands late (`lateLand`): in the block at its last valid height plus this (−3 to +1). Replaces L1
   *  (a replay lands it in the same block of its blockhash's life, whenever it was sent). A sell that never lands
   *  ("expired before landing") is told so when the block at its last valid height plus this (+2 to +4) is produced:
   *  the chain is past the last block it could land in. (`lateAt`: in tapes before the slot clock; not used.) */
  late?: number;
  lateAt?: number;
}
export interface QPlan { fail?: boolean; L: number }
/** A balance read: fails, or answers after L ms with the balance as it is then (late) or as it was when asked. */
export interface BPlan { fail?: boolean; L?: number; late?: boolean }
/** A database write that fails (profile dbfault): 'full' = "database or disk is full", 'io' = "disk I/O error".
 *  `m`: the store method it was (for the reader; a replay goes by the write's number only). */
export interface DbPlan { err: 'full' | 'io'; m?: string }
/** A read of the chain's tip (chainTip): answered after `L` ms (from the chain as it is then), by a node `behind`
 *  blocks behind the confirmed tip. */
export interface TipPlan { L?: number; behind?: number }
/** A status read of a sell (settleSell): answered after `L` ms, from the chain as it is then, by a node `lag` blocks
 *  behind the confirmed tip, or on a minority fork that has not seen the main fork's last `fork` blocks; behind on its
 *  confirmations by `conf` blocks; its "not found" without a slot (`noSlot`). None of them: an up-to-date node, whose
 *  context slot (its processed bank's) is ahead of a confirmed tip read at the same moment. */
export interface StatusPlan { L?: number; lag?: number; fork?: number; conf?: number; noSlot?: boolean }
/** `db` (dbfault only): the database writes that fail, by their number among the writes that change something.
 *  `tip`, `status`: each read of the chain's tip and each status read of a sell, by the read's number (a hole: answered
 *  at once by an up-to-date node; a number, in tapes before reads had a latency: `lag`). */
export interface Tape { buy: OpPlan[]; sell: OpPlan[]; quote: QPlan[]; bal: (BPlan | null)[]; db?: (DbPlan | null)[]; status?: (StatusPlan | number | null)[]; tip?: (TipPlan | null)[] }

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
  /** It failed on chain (a later read of the transaction says so), at `failedAt`, in the block at `failedBlock`. */
  chainFailed?: boolean;
  failedAt?: number;
  failedBlock?: number;
  /** A real sale: the block it landed in (at `landedAt`, when that block was produced). */
  landedBlock?: number;
  /** A real sell: the last block height its blockhash is valid for (as the executor tells it when it is signed). It can
   *  land up to one block past it, never later. */
  lastValid?: number;
  /** Set by run.ts: the engine took it for a sell that never landed (dropped it, or gave up on it), when and by which
   *  rule (a sale that lands after that is never booked: M3). */
  verdict?: { at: number; rule: string };
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
  /** The engine read what became of a sell from its own transaction, and was told `answer` when it arrived (by a node
   *  that may be behind the tip, on a minority fork, or behind on its confirmations: see StatusAnswer). What the engine
   *  makes of it is observed in run.ts (its verdicts), not assumed here. */
  sellSettled(c: SellCall, answer: StatusAnswer): void;
  /** The engine was handed the chain's tip (null: the read failed), from a node `behind` blocks behind the confirmed
   *  tip, read from `sentAt` to `at`. */
  tipRead(tip: { height: number; slot: number } | null, behind: number, sentAt: number, at: number): void;
  /** A balance read for a piece of engine work started (+1) or came back (-1). */
  reading(ctx: Ctx | undefined, d: number): void;
  refined(c: BuyCall | SellCall): void;
  problem(code: string, kind: string, message: string): void;
}

/** What a status read of a sell told the engine when it arrived (`at`; sent at `sentAt`): landed, failed, not found
 *  with the context slot of the node that answered (none: an answer without a slot), or 'processed' (the node has the
 *  sale, or its failure, in a block it has not confirmed: the executor throws "seen in a block, not confirmed yet").
 *  The node: `lag` blocks behind the confirmed tip (0: up to date), on a minority fork that has not seen the main
 *  fork's last `fork` blocks, behind on its confirmations by `conf` blocks; `seen`: the newest main block it has. */
export interface StatusAnswer { state: 'landed' | 'failed' | 'not_found' | 'processed'; slot?: number; lag: number; fork?: number; conf?: number; seen: number; at: number; sentAt: number }
/** A chain tip handed to the engine (null: the read failed), and when it arrived. */
export interface TipRead { at: number; tip: { height: number; slot?: number } | null }

const NEVER = new Promise<never>(() => undefined);
const lam = (sol: number) => BigInt(Math.round(Math.max(0, sol || 0) * 1e9));

export class Exec implements Executor {
  /** False once the engine it belongs to is gone: its pending and future calls never return. */
  alive = true;
  /** The last chain tip this engine was handed (when it arrived; null: the read failed), the highest it has been handed
   *  so far (the engine goes by the highest tip it has read: a read that fails, or a node a little behind, does not
   *  lower it), and the last status read of each sell it made, with the highest tip it had been handed when it sent
   *  that read (the engine reads the tip before the status: the harness pairs a verdict with the reads it acted on, to
   *  count which of the engine's rules gave it). */
  lastTip?: TipRead;
  highTip?: { height: number; slot?: number };
  readonly reads = new Map<string, StatusAnswer & { tip?: TipRead['tip']; planted?: boolean }>();
  /** A chain tip handed to the engine now (null: the read failed). */
  handTip(tip: TipRead['tip'], at: number): void {
    this.lastTip = { at, tip };
    if (tip && (!this.highTip || tip.height > this.highTip.height)) this.highTip = tip;
  }
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
 * The clock is the slot: one every 400 ms. A slot has a block or is skipped (about one in ten; in a slow period, whole
 * leader windows of four slots as well, so a block comes every 0.6 to 1.5 s for minutes); the height grows by one per
 * block, never on a skipped slot. A block is produced at the start of its slot (the newest, "processed", tip) and
 * confirmed CONFIRM_MS later (the tip a node gives at "confirmed", which the engine reads). A transaction's blockhash is
 * valid for 150 blocks after it is signed (a minute at full speed, nearly four in a slow period), and the chain takes it
 * one block longer (src/chain/connection.ts, LAST_BLOCK_PAST_VALID). A real sell lands L1 after it was signed (within
 * 30 s) in the block being built then (the next one, when that slot is skipped), or late, in the last blocks it can
 * (`lateLand`: its last valid height − 3 to one past it), or never: none ever lands after that.
 */
const SLOT_MS = 400;
export const VALID_BLOCKS = 150;
const SKIPPED_SLOTS = 0.1;
/** Slots per leader window: in a slow period a window is skipped whole. */
const LEADER_SLOTS = 4;
/** A block is confirmed (optimistically, by the cluster) this long after it is produced. */
const CONFIRM_MS = 400;
/** How far behind the confirmed tip a status node may be, in blocks: the engine's WELL_PAST_BLOCKS (30) believes "not
 *  found" from any node once the tip it read is more than 30 blocks past the last block a sell could land in, which is
 *  exactly safe for a node up to 31 blocks behind; a node further behind is that rule's documented, accepted limit. */
export const STATUS_LAG_LIMIT = 31;

/** How long a read of the chain takes (ms): mostly tens of ms; sometimes up to a second; sometimes the main link's
 *  time limit (src/config.ts rpcTimeoutMs, 4 s) and then the backup link's answer (src/chain/connection.ts
 *  boundedFetch), up to about 8.5 s. */
export function readLatency(r: Rng): number {
  const x = r.next();
  if (x < 0.86) return r.int(8, 90);
  if (x < 0.95) return r.int(90, 1_000);
  if (x < 0.99) return 4_000 + r.int(30, 700);
  return 4_000 + r.int(700, 4_500);
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
  private readonly cursor = { buy: 0, sell: 0, quote: 0, bal: 0, status: 0, tip: 0 };
  private n = 0;
  /** The moment, the slot and the height the scenario starts at (a block in that slot). */
  private readonly t0: number;
  private readonly s0: number;
  private readonly h0: number;
  /** Drawn as the chain gets there (or as a block ahead is asked for): the slot index (from s0) of every block since the
   *  start (`blockIdx[k]`: the block at height h0 + k), and the newest block at every slot index (`atIdx[i]`: its k). */
  private readonly blockIdx: number[] = [0];
  private readonly atIdx: number[] = [0];
  /** The leader window last drawn in a slow period, and whether it is skipped whole. */
  private skipWin = -1;
  private winSkipped = false;
  /** What the chain model did (reported with the run): sales that landed late; tip reads (from a node a little behind);
   *  status reads (from a node behind the tip, and those that missed a sale or failure already in a block; from a node
   *  on a minority fork, and those that missed one; from a node behind on its confirmations; answered 'processed', so
   *  the executor threw; "not found" without a slot); reads that took the main link's time limit (4 s or more); reads
   *  answered during a slow period. */
  readonly counts = {
    lateLandings: 0, tipReads: 0, tipBehind: 0, statusReads: 0, laggedReads: 0, laggedMisses: 0, forkReads: 0, forkMisses: 0,
    confBehindReads: 0, processedReads: 0, slotlessReads: 0, slowReads: 0, readsInSlow: 0,
  };
  /** Quiescence: every trade, quote and balance read succeeds promptly, whatever the tape says (a read of the chain's
   *  tip or of a sell's status never fails either, but keeps its node and the time it takes: see planTip). */
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
    /** The reads' own random stream (run.ts derives it from the seed): how long each read of the chain takes and which
     *  node answers it, recorded on the tape (`tip`, `status`). The outcomes' stream is left as it was. */
    private readonly readRng: Rng,
    /** The chain's slow periods (from the start, in ms). */
    private readonly slow: readonly SlowPeriod[],
  ) {
    this.t0 = sim.now;
    this.h0 = Math.floor(sim.now / SLOT_MS);
    // (slots run ahead of heights, as on mainnet, where every skipped slot since genesis widened the gap)
    this.s0 = this.h0 + 1_000_000;
  }

  // ── the chain: slots, blocks, heights ─────────────────────────────────
  /** The slot index (from the start) of a moment. */
  private idx(at: number): number {
    return Math.floor((at - this.t0) / SLOT_MS);
  }
  /** The slow period a moment falls in, if any. */
  slowAt(at: number): SlowPeriod | undefined {
    const ms = at - this.t0;
    return this.slow.find((w) => ms >= w.at && ms < w.at + w.ms);
  }
  /** Draws the chain's slots up to slot index i (each is skipped or has the next block). */
  private grow(i: number): void {
    while (this.atIdx.length <= i) {
      const j = this.atIdx.length;
      const k = this.atIdx[j - 1]!;
      if (this.skipped(j)) this.atIdx.push(k);
      else { this.blockIdx.push(j); this.atIdx.push(k + 1); }
    }
  }
  private skipped(j: number): boolean {
    const w = this.slowAt(this.t0 + j * SLOT_MS);
    if (w) {
      // A slow period: whole leader windows are skipped, so that a block comes about every blockMs on average.
      const win = Math.floor((this.s0 + j) / LEADER_SLOTS);
      if (win !== this.skipWin) {
        this.skipWin = win;
        this.winSkipped = this.slotRng.chance(Math.min(0.95, Math.max(0, 1 - SLOT_MS / ((1 - SKIPPED_SLOTS) * w.blockMs))));
      }
      if (this.winSkipped) return true;
    }
    return this.slotRng.chance(SKIPPED_SLOTS);
  }
  /** Draws the chain until the block k (from the start) exists. */
  private growToBlock(k: number): void {
    while (this.blockIdx.length <= k) this.grow(this.atIdx.length + 64);
  }
  /** The newest block at a moment (now by default): the "processed" tip. */
  processedHeight(at = this.sim.now): number {
    const i = this.idx(at);
    if (i < 0) return this.h0 + i; // (before the scenario: nothing skipped)
    this.grow(i);
    return this.h0 + this.atIdx[i]!;
  }
  /** The chain's confirmed height at a moment (now by default): the newest block produced CONFIRM_MS before. This is
   *  the tip the executor reads (getEpochInfo('confirmed')), and the height a blockhash's life is counted from. */
  height(at = this.sim.now): number {
    return this.processedHeight(at - CONFIRM_MS);
  }
  /** The slot of the block at height h: strictly increasing with the height. */
  slotAt(h: number): number {
    const k = h - this.h0;
    if (k < 0) return this.s0 + k;
    this.growToBlock(k);
    return this.s0 + this.blockIdx[k]!;
  }
  /** The slot at a moment (now by default), whether it has a block or not. */
  slotNow(at = this.sim.now): number {
    return this.s0 + this.idx(at);
  }
  /** When the block at height h is produced (the start of its slot). */
  timeOf(h: number): number {
    const k = h - this.h0;
    if (k < 0) return this.t0 + k * SLOT_MS;
    this.growToBlock(k);
    return this.t0 + this.blockIdx[k]! * SLOT_MS;
  }
  /** The height of the first block produced at or after a moment. */
  nextBlock(at: number): number {
    const i = Math.max(0, Math.ceil((at - this.t0) / SLOT_MS));
    this.grow(i);
    let k = this.atIdx[i]!;
    if (this.blockIdx[k]! < i) k++;
    this.growToBlock(k);
    return this.h0 + k;
  }
  /** When a transaction that reaches the leader at a moment goes into a block: then, into the block being built in that
   *  slot; or, when that slot is skipped, at the start of the next block. */
  landingAt(at: number): number {
    const i = Math.max(0, this.idx(at));
    this.grow(i);
    return this.blockIdx[this.atIdx[i]!] === i ? at : this.timeOf(this.nextBlock(at));
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
      if ((f.lateLand ?? 0) > 0 && (!plan.fail || plan.ghost) && r.chance(f.lateLand!)) plan.late = r.int(-3, 1);
      else if ((f.lateLand ?? 0) > 0 && plan.fail === EXPIRED && !plan.ghost && !plan.unsure) plan.late = r.int(2, 4);
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
  /** How long this read of the chain's tip takes, and whether its node is a little behind (from the reads' stream). The
   *  chain's nodes stay what they are in the quiet phase (a read never fails there): a sell left behind whose last blocks
   *  come after the scenario's steps is read as any other. */
  private planTip(): TipPlan {
    const i = this.cursor.tip++;
    const hit = this.tape.tip?.[i];
    if (hit) return hit;
    if (this.replay) return {};
    const f = this.faults;
    const r = this.readRng;
    const plan: TipPlan = {};
    if (!f.instant) plan.L = readLatency(r);
    if ((f.tipBehind ?? 0) > 0 && r.chance(f.tipBehind!)) plan.behind = r.int(1, 3);
    if (plan.L || plan.behind) (this.tape.tip ??= [])[i] = plan;
    return plan;
  }
  /** How long this status read of a sell takes, and which node answers it (from the reads' stream; in the quiet phase
   *  too, see planTip). */
  private planStatus(): StatusPlan {
    const i = this.cursor.status++;
    const hit = this.tape.status?.[i];
    if (typeof hit === 'number') return { lag: Math.min(hit, STATUS_LAG_LIMIT) };
    if (hit) return { ...hit, ...(hit.lag ? { lag: Math.min(hit.lag, STATUS_LAG_LIMIT) } : {}) };
    if (this.replay) return {};
    const f = this.faults;
    const r = this.readRng;
    const plan: StatusPlan = {};
    if (!f.instant) plan.L = readLatency(r);
    if ((f.statusLag ?? 0) > 0 && r.chance(f.statusLag!)) plan.lag = r.int(1, Math.max(1, Math.min(f.statusLagMax ?? STATUS_LAG_LIMIT, STATUS_LAG_LIMIT)));
    else if ((f.forkRead ?? 0) > 0 && r.chance(f.forkRead!)) plan.fork = r.int(1, 3);
    if ((f.confBehind ?? 0) > 0 && r.chance(f.confBehind!)) plan.conf = r.int(1, Math.max(1, f.confBehindMax ?? 40));
    if ((f.noSlot ?? 0) > 0 && r.chance(f.noSlot!)) plan.noSlot = true;
    if (Object.keys(plan).length) (this.tape.status ??= [])[i] = plan;
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
   *  getEpochInfo('confirmed')), as the chain is when the answer arrives (`tip` plan: after L ms; from a node a little
   *  behind); it can be read only when the RPC answers. */
  chainTip(exec: Exec): Promise<{ height: number; slot: number }> {
    if (!exec.alive) return NEVER;
    this.counts.tipReads++;
    const down = this.planBal().fail || this.outage();
    const plan = this.planTip();
    const sentAt = this.sim.now;
    return new Promise((resolve, reject) => {
      this.after(plan.L ?? 0, () => {
        if (!exec.alive) return; // (the engine is gone: nobody is waiting)
        if ((plan.L ?? 0) >= 4_000) this.counts.slowReads++;
        if (this.slowAt(this.sim.now)) this.counts.readsInSlow++;
        if (down) {
          exec.handTip(null, this.sim.now);
          this.hooks.tipRead(null, 0, sentAt, this.sim.now);
          return reject(new Error('429 Too Many Requests'));
        }
        if (plan.behind) this.counts.tipBehind++;
        const height = this.height() - (plan.behind ?? 0);
        const tip = { height, slot: this.slotAt(height) };
        exec.handTip(tip, this.sim.now);
        this.hooks.tipRead(tip, plan.behind ?? 0, sentAt, this.sim.now);
        resolve({ ...tip });
      });
    });
  }

  /**
   * What became of a sell, from its own transaction (the engine asks about a sell of unknown outcome before it sells
   * again, about a sell left behind by a restart, and for the exact SOL of a sale). The answer is worked out from the
   * chain as it is when it arrives (`status` plan: after L ms), by the node that answers it:
   *  - up to date: it has every block produced (its context slot, its processed bank's, is ahead of a confirmed tip read
   *    at the same moment) and has confirmed those the cluster has (less `conf` blocks, when it is behind on them);
   *  - `lag` blocks behind the confirmed tip: it sees the chain as it was at the block it has reached;
   *  - on a minority fork of 1 to 3 slots: it has not seen the main fork's last `fork` blocks, and the context slot of
   *    its "not found" is its own fork's, at least the tip's.
   * A sale (or a failure) in a block the node has confirmed: landed (failed). In a block it has and has not confirmed:
   * the executor throws "seen in a block, not confirmed yet" (the engine asks again). In a block it has not seen: "not
   * found", with the node's context slot (none, `noSlot`: an executor that cannot tell how far along the node was).
   */
  settleSell(exec: Exec, signature: string, _owner: string, _mint: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' } | { state: 'not_found'; slot?: number }> {
    if (!exec.alive) return NEVER;
    const down = this.planBal().fail || this.outage();
    const c = this.signedSells.get(signature);
    const plan: StatusPlan = c ? this.planStatus() : {};
    const sentAt = this.sim.now;
    // The highest tip the engine had been handed when it sent this read (it reads the tip first, then the status).
    const tip = exec.highTip ?? null;
    return new Promise((resolve, reject) => {
      this.after(plan.L ?? 0, () => {
        if (!exec.alive) return; // (the engine is gone: nobody is waiting)
        if ((plan.L ?? 0) >= 4_000) this.counts.slowReads++;
        if (down) return reject(new Error('429 Too Many Requests'));
        if (!c) return resolve({ state: 'not_found', slot: this.slotAt(this.processedHeight()) });
        const answer = this.statusAnswer(c, plan, sentAt);
        exec.reads.set(signature, { ...answer, tip });
        this.hooks.sellSettled(c, answer);
        if (answer.state === 'processed') return reject(new Error('seen in a block, not confirmed yet'));
        if (answer.state === 'landed') { c.settled = true; return resolve({ state: 'landed', tokens: c.sold!, lamports: c.exact! }); }
        if (answer.state === 'failed') return resolve({ state: 'failed' });
        return resolve(answer.slot === undefined ? { state: 'not_found' } : { state: 'not_found', slot: answer.slot });
      });
    });
  }

  /** The answer to a status read of a sell arriving now, from the node its plan names (see settleSell). */
  private statusAnswer(c: SellCall, plan: StatusPlan, sentAt: number): StatusAnswer {
    const now = this.sim.now;
    const main = this.processedHeight(now);
    const conf = this.height(now);
    const lag = plan.lag ?? 0;
    const fork = !lag && plan.fork ? plan.fork : 0;
    // The newest main block the node has, its context slot, and the newest block it has confirmed.
    const seen = lag ? conf - lag : main - fork;
    // (a node on a minority fork: its own newest block is in the slot of now, at or past the main fork's newest)
    const ctxSlot = lag ? this.slotAt(seen) : fork ? this.slotNow(now) : this.slotAt(main);
    const confirmed = Math.min(seen, conf - (plan.conf ?? 0));
    // The block the sale (or its failure) is in, if it has happened by now.
    const landed = c.landedAt !== undefined && c.landedAt <= now;
    const h = landed ? c.landedBlock : c.chainFailed && c.failedAt !== undefined && c.failedAt <= now ? c.failedBlock : undefined;
    const state: StatusAnswer['state'] = h !== undefined && h <= confirmed ? (landed ? 'landed' : 'failed') : h !== undefined && h <= seen ? 'processed' : 'not_found';
    const slot = state === 'not_found' && !plan.noSlot ? ctxSlot : undefined;
    this.counts.statusReads++;
    if (this.slowAt(now)) this.counts.readsInSlow++;
    if (lag) { this.counts.laggedReads++; if (state === 'not_found' && h !== undefined) this.counts.laggedMisses++; }
    if (fork) { this.counts.forkReads++; if (state === 'not_found' && h !== undefined) this.counts.forkMisses++; }
    if (plan.conf) this.counts.confBehindReads++;
    if (state === 'processed') this.counts.processedReads++;
    if (state === 'not_found' && plan.noSlot) this.counts.slotlessReads++;
    // The model's own promise, which the engine's slot check relies on: a node that is not on a minority fork and says
    // "not found" at a slot has seen every block up to that slot.
    if (state === 'not_found' && !fork && h !== undefined && slot !== undefined && slot >= this.slotAt(h)) {
      this.hooks.problem('E4', 'fake-chain-not-found-from-a-node-past-the-sale', `sell#${c.id}: "not found" at slot ${slot} from a node ${lag} blocks behind, while it is in the block at height ${h} (slot ${this.slotAt(h)})`);
    }
    return { state, ...(slot !== undefined ? { slot } : {}), lag, ...(fork ? { fork } : {}), ...(plan.conf ? { conf: plan.conf } : {}), seen, at: now, sentAt };
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
      // was signed, nearly four in a slow period); one that never lands is told "expired before landing" once the chain
      // is past the last block it could land in (when the block +2 to +4 is produced), as the executor tells it.
      const lands = !unknownLost && (!plan.fail || !!plan.ghost);
      const errored = !lands && !unknownLost && !!plan.fail && /errored/.test(plan.fail);
      const expires = !lands && !unknownLost && plan.fail === EXPIRED;
      const late = live && (lands || expires) && plan.late !== undefined && call.lastValid !== undefined ? (lands ? Math.min(Math.max(plan.late, -3), 1) : Math.max(plan.late, 2)) : undefined;
      // A real sell that goes into a block (it lands, or fails on chain) does so L1 after it was sent, in the block being
      // built then (when that slot is skipped, the next one: on a slow chain it waits), or in the block its plan names.
      const at = late !== undefined ? this.timeOf(call.lastValid! + late)
        : live && (lands || errored) && !this.faults.instant ? this.landingAt(this.sim.now + plan.L1)
          : this.sim.now + plan.L1;
      this.after(Math.max(0, at - this.sim.now), () => {
        if (unknownLost) return this.after(plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
        if (plan.fail && !plan.ghost) {
          call.chainFailed = /errored/.test(plan.fail);
          if (call.chainFailed) { call.failedAt = this.sim.now; call.failedBlock = this.processedHeight(); }
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
        const failsHere = () => { call.chainFailed = true; call.failedAt = this.sim.now; call.failedBlock = this.processedHeight(); };
        if (tokens > heldNow) { failsHere(); return deliver({ ok: false, error: 'sent but did not land: transaction errored: {"InstructionError":[2,{"Custom":1}]}' }); }
        const have = this.sol.get(owner) ?? 0n;
        if (have < txc) { failsHere(); return deliver({ ok: false, error: 'sent but did not land: transaction errored: Transfer: insufficient lamports (cannot pay the fee)' }); }
        const sold = part(tokens);
        const gross = this.value(mint, sold);
        const fee = (gross * bps) / 10_000n;
        let net = gross - fee - txc;
        // (a market that can pay for only part is known when the sell is built: such a sell does not close the account)
        if (closing && heldNow === sold) { net += ATA_RENT; this.hasAccount.delete(`${owner}|${mint}`); }
        this.setTokens(owner, mint, heldNow - sold);
        this.sol.set(owner, have + net);
        const est = sold === tokens ? est0 : (est0 * sold) / tokens;
        const block = this.processedHeight();
        Object.assign(call, { sold, est, exact: net, fee, landedAt: this.sim.now, landedBlock: block });
        if (call.lastValid !== undefined && block > call.lastValid + 1) this.hooks.problem('E4', 'fake-chain-sale-landed-after-its-blockhash', `sell#${call.id} landed in the block at height ${block}, past ${call.lastValid + 1}, the last block its blockhash allows`);
        if (call.lastValid !== undefined && block >= call.lastValid - 3) this.counts.lateLandings++;
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
