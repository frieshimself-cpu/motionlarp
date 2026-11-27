// The fake chain. One Market per scenario holds the truth: what every wallet holds, what every coin is worth, and
// every trade that really "landed" (the ledger the engine's books are checked against). The engine talks to it
// through an Exec (the Executor interface), one per engine instance, so a "crashed" engine's calls never return.
//
// A REAL trade (the owner's Live switch on, or the sell of a position bought for real): the wallet's token balance
// is the truth. A sell lands only if the wallet holds the tokens at that moment; SOL moves; fills come back as an
// estimate first and the exact figure later (`refine`), as the real executor does. A TEST trade: nothing is held,
// fills are quotes (simulated: true).
//
// When a real trade's answer comes, as the real executor gives it (src/engine/executor.ts sendAndRead, src/tx/confirm.ts):
//  - landed, or failed on chain: once its own status polls see its block confirmed (L2 after the block; on a chain whose
//    nodes disagree, later, while the polls are answered by nodes that have not confirmed it: `seen`);
//  - "expired before landing": when one of its looks (every ten polls, every poll past the margin) finds the chain past its
//    last valid height and a status read, by a node of the model, says "not found", and the shared rule
//    (src/chain/landing.ts neverLands) believes it; never while the trade is seen in a block at "processed";
//  - "sent, outcome unknown": at its 150 s cap when none of that has happened, after one last read of its own transaction
//    that cannot tell (a read that finds it landed answers it as landed, one that finds it failed as failed); the trade
//    lands or fails on chain afterwards all the same, with nobody told;
//  - a ghost sell (it lands, reported "outcome unknown") and a trade the plan reports "outcome unknown" (`unsure`): L1 + L2
//    after it was sent (0.1 to 30.5 s; a ghost, L2 after it landed, late when it lands late, at the 150 s cap at the
//    latest), earlier than the real executor can answer "outcome unknown" (only at its cap): harsh on purpose, the engine
//    must settle such a trade while the chain is still deciding it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { BUY_BLOCKHASH_MIN_BLOCKS, LAST_BLOCK_PAST_VALID, WELL_PAST_BLOCKS } from '../../src/chain/connection.js';
import { neverLands, NOT_FOUND_MARGIN_BLOCKS } from '../../src/chain/landing.js';
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
  /** Chance that a status read (of a sell or a buy, by the engine or by the executor's own wait) is answered by a node
   *  some blocks behind the chain's confirmed tip, and how many blocks behind at most for most of them (1 to this, at most
   *  STATUS_LAG_LIMIT; one in eight further, up to FAR_LAG_MAX, when its answer carries its slot). Such a node sees the
   *  chain as it was then: a trade that landed after that is "not found" by it, and its answer carries the slot it has
   *  reached. */
  statusLag?: number;
  statusLagMax?: number;
  /** Chance that a status read is answered by a node on a minority fork of 1 to FORK_LIMIT blocks (whole leader windows
   *  of four slots weighted): it has not seen the main fork's newest blocks, and the context slot of its "not found" (its
   *  own fork's newest) is at least the tip's. */
  forkRead?: number;
  /** Chance that a status node is behind on its confirmations: it has the newest blocks, but has confirmed only up to
   *  1 to `confBehindMax` blocks less. A trade in a block it has and has not confirmed: settleSell and settleBuy throw
   *  "seen in a block, not confirmed yet", as the executor does, until a node that has confirmed it answers. */
  confBehind?: number;
  confBehindMax?: number;
  /** Chance that a tip read (chainTip, and the executor's own looks) is answered by a node 1 to 3 blocks behind the
   *  confirmed tip. */
  tipBehind?: number;
  /** Chance that a status answer "not found" carries no slot (an executor that cannot tell how far along the node
   *  that answered was). */
  noSlot?: number;
  /** Chance that a real sell that lands does so in the last blocks its blockhash allows: at a height from its last
   *  valid height − 3 to one past it (the chain takes a blockhash one block longer), about a minute after it was
   *  signed, instead of within the 30 s of `L1`. Where it is on, a real buy that lands does so in the last blocks of its
   *  short blockhash at half this rate (a buy of unknown outcome that lands: at this rate). */
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
  /** A real trade that lands late (`lateLand`): in the block at its last valid height plus this (−3 to +1). Replaces L1
   *  (a replay lands it in the same block of its blockhash's life, whenever it was sent). (A sell that never lands used
   *  to carry +2 to +4 here, the moment it was told "expired": no longer used, its own looks tell it. `lateAt`: in tapes
   *  before the slot clock; not used.) */
  late?: number;
  lateAt?: number;
  /** A real buy: how many blocks its short blockhash has left when it is signed (40 to 59: src/chain/connection.ts
   *  getShortBlockhash; a tape without it: 50). */
  left?: number;
  /** On a chain whose nodes disagree: how many of the executor's own status polls (one every 330 ms) go by after the
   *  trade's block is confirmed before one is answered by a node that has confirmed it (the others come from nodes
   *  behind, on a fork, behind on their confirmations). Its answer comes that much later. */
  seen?: number;
}
export interface QPlan { fail?: boolean; L: number }
/** A balance read: fails, or answers after L ms with the balance as it is then (late) or as it was when asked. */
export interface BPlan { fail?: boolean; L?: number; late?: boolean }
/** A database write that fails (profile dbfault): 'full' = "database or disk is full", 'io' = "disk I/O error".
 *  `m`: the store method it was (for the reader; a replay goes by the write's number only). */
export interface DbPlan { err: 'full' | 'io'; m?: string }
/** A read of the chain's tip (chainTip, or a look of the executor's own wait): answered after `L` ms (from the chain as
 *  it is then), by a node `behind` blocks behind the confirmed tip. */
export interface TipPlan { L?: number; behind?: number }
/** A status read of a trade (settleSell, settleBuy, a look or the last read of the executor's own wait): answered after
 *  `L` ms, from the chain as it is then, by a node `lag` blocks behind the confirmed tip, or on a minority fork that has
 *  not seen the main fork's last `fork` blocks; behind on its confirmations by `conf` blocks; its "not found" without a
 *  slot (`noSlot`); a trade that landed, whose transaction this node cannot return yet (`unread`: the executor throws
 *  "landed, but its transaction cannot be read yet"). None of them: an up-to-date node, whose context slot (its
 *  processed bank's) is ahead of a confirmed tip read at the same moment. */
export interface StatusPlan { L?: number; lag?: number; fork?: number; conf?: number; noSlot?: boolean; unread?: boolean }
/** `db` (dbfault only): the database writes that fail, by their number among the writes that change something.
 *  `tip`, `status`: each read of the chain's tip and each status read of a trade, by the read's number (a hole: answered
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
/** What the executor answers when the last read after its cap finds the trade failed (sendAndRead: the confirmation's own
 *  reason). */
const FAILED_AT_CAP = 'sent but did not land: confirmation unknown (RPC unreachable)';

/** How the executor's own wait ended a real trade: its polls or a look saw it in a block ('seen'), a look called it expired
 *  ('expired'), or its 150 s cap came ('cap': answered "outcome unknown", or as the last read found it). */
export type Settled = 'seen' | 'expired' | 'cap';

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
  /** The engine read this buy's own transaction afterwards (settleBuy, or the executor's last read at its cap) and got
   *  its exact numbers. */
  settled?: boolean;
  /** The buy was handed back with this, the quote's coin count, while the wallet received `tokens`. */
  quotedTokens?: bigint;
  /** Signed, then not sent: its onSigned callback threw (as the executor does since 67c9307; not with FUZZ_NO_RECORD_NO_SEND=0). */
  notSent?: boolean;
  /** A real buy: the last block height its short blockhash is valid for (told with its signature, as the executor tells
   *  it). It can land up to one block past it, never later. */
  lastValid?: number;
  /** A real buy: the block it landed in (at `landedAt`), or failed on chain in (at `failedAt`). */
  landedBlock?: number;
  failedAt?: number;
  failedBlock?: number;
  /** When, and at which height, it goes into a block (lands or fails on chain), as planned when it was sent. */
  goesAt?: number;
  goesTo?: number;
  /** How the executor's own wait ended it (see Settled); `capped`: it was answered "outcome unknown" at the cap. */
  settledBy?: Settled;
  capped?: boolean;
  /** Set by run.ts: the engine (or the executor) took it for a buy that never landed, when and by which rule (a buy that
   *  lands after that leaves its coins unsold). */
  verdict?: { at: number; rule: string };
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
  /** When, and at which height, it goes into a block (lands or fails on chain), as planned when it was sent. */
  goesAt?: number;
  goesTo?: number;
  /** How the executor's own wait ended it (see Settled); `capped`: it was answered "outcome unknown" at the cap. */
  settledBy?: Settled;
  capped?: boolean;
  /** Set by run.ts: the engine took it for a sell that never landed (dropped it, or gave up on it), or the executor called
   *  it expired, when and by which rule (a sale that lands after that is never booked: M3). */
  verdict?: { at: number; rule: string };
  sold?: bigint; est?: bigint; exact?: bigint; fee?: bigint; signature?: string; refined?: 'exact' | 'null';
  refineSeen?: boolean;
  /** The engine read this sell's own transaction afterwards (settleSell, or the executor's last read at its cap) and got
   *  its exact numbers. */
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
  /** A real buy has just gone into a block and changed the wallet (before the engine is told). */
  buyLanded(c: BuyCall): void;
  sellAsk(c: SellCall): void;
  /** The moment the wallet changed (before the engine is told). */
  sellLanded(c: SellCall): void;
  sellDone(c: SellCall): void;
  /** The engine read what became of a sell, or of a buy, from its own transaction, and was told `answer` when it arrived
   *  (by a node that may be behind the tip, on a minority fork, or behind on its confirmations: see StatusAnswer). What
   *  the engine makes of it is observed in run.ts (its verdicts), not assumed here. */
  sellSettled(c: SellCall, answer: StatusAnswer): void;
  buySettled(c: BuyCall, answer: StatusAnswer): void;
  /** The engine was handed the chain's tip (null: the read failed), from a node `behind` blocks behind the confirmed
   *  tip, read from `sentAt` to `at`. */
  tipRead(tip: { height: number; slot: number } | null, behind: number, sentAt: number, at: number): void;
  /** The executor's own wait called a real trade expired, from the status read of one of its looks and the tip it read
   *  before it, by `rule` ('slotted', 'wellPast'; 'planted': the self-test's): judged by the chain in run.ts. */
  expired(c: BuyCall | SellCall, rule: string, text: string): void;
  /** A line for the transcript about the executor's own wait (a look that read a status, the last read at its cap). */
  execLine(text: string): void;
  /** A balance read for a piece of engine work started (+1) or came back (-1). */
  reading(ctx: Ctx | undefined, d: number): void;
  refined(c: BuyCall | SellCall): void;
  problem(code: string, kind: string, message: string): void;
}

/** What a status read of a trade told the engine when it arrived (`at`; sent at `sentAt`): landed, failed, not found
 *  with the context slot of the node that answered (none: an answer without a slot), or 'processed' (the node has the
 *  trade, or its failure, in a block it has not confirmed: the executor throws "seen in a block, not confirmed yet").
 *  The node: `lag` blocks behind the confirmed tip (0: up to date), on a minority fork that has not seen the main
 *  fork's last `fork` blocks, behind on its confirmations by `conf` blocks; `seen`: the newest main block it has. */
export interface StatusAnswer { state: 'landed' | 'failed' | 'not_found' | 'processed'; slot?: number; lag: number; fork?: number; conf?: number; seen: number; at: number; sentAt: number; unread?: boolean }
/** A chain tip handed to the engine (null: the read failed), and when it arrived. */
export interface TipRead { at: number; tip: { height: number; slot?: number } | null }
/** The rule by which the executor's own wait calls a trade expired, from a look's tip and status read: the name of the
 *  branch that believed it ('slotted', 'wellPast', or the self-test's 'planted'), or null. The real one is the shared rule
 *  (src/chain/landing.ts, as src/tx/confirm.ts applies it): only a "not found" counts, never a trade seen at "processed". */
export type ExpiryRule = (lastValid: number, tip: { height: number; slot: number }, answer: StatusAnswer) => string | null;
export const EXPIRY_RULE: ExpiryRule = (lastValid, tip, a) => (a.state === 'not_found' && neverLands(lastValid, tip, a.slot) ? (a.slot !== undefined ? 'slotted' : 'wellPast') : null);

const NEVER = new Promise<never>(() => undefined);
const lam = (sol: number) => BigInt(Math.round(Math.max(0, sol || 0) * 1e9));

export class Exec implements Executor {
  /** False once the engine it belongs to is gone: its pending and future calls never return. */
  alive = true;
  /** The last chain tip this engine was handed (when it arrived; null: the read failed), the highest it has been handed
   *  so far (the engine goes by the highest tip it has read: a read that fails, or a node a little behind, does not
   *  lower it), every height that highest tip has had (a settling pass acts on the one it read at its start), how many
   *  tip reads it made and how many failed, and the last status read of each trade it made, with the highest tip it had
   *  been handed when it sent that read (the engine reads the tip before the status: the harness pairs a verdict with
   *  the reads it acted on, to count which of the engine's rules gave it). */
  lastTip?: TipRead;
  highTip?: { height: number; slot?: number };
  readonly tipHistory: { height: number; slot?: number }[] = [];
  tipReads = 0;
  tipFails = 0;
  readonly reads = new Map<string, StatusAnswer & { tip?: TipRead['tip']; planted?: boolean; tipReads?: number; tipFails?: number }>();
  /** A chain tip handed to the engine now (null: the read failed). */
  handTip(tip: TipRead['tip'], at: number): void {
    this.lastTip = { at, tip };
    this.tipReads++;
    if (!tip) this.tipFails++;
    if (tip && (!this.highTip || tip.height > this.highTip.height)) { this.highTip = tip; this.tipHistory.push(tip); }
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
 * valid for 150 blocks after it is signed (a minute at full speed, nearly four in a slow period; a buy's short one, 40 to
 * 59), and the chain takes it one block longer (src/chain/connection.ts, LAST_BLOCK_PAST_VALID). A real trade goes into a
 * block L1 after it was signed (within 30 s), the block being built then (the next one, when that slot is skipped), or
 * late, in the last blocks it can (`lateLand`: its last valid height − 3 to one past it), or never: none ever lands after
 * one past its last valid height.
 */
const SLOT_MS = 400;
export const VALID_BLOCKS = 150;
const SKIPPED_SLOTS = 0.1;
/** Slots per leader window: in a slow period a window is skipped whole. */
const LEADER_SLOTS = 4;
/** A block is confirmed (optimistically, by the cluster) this long after it is produced. */
const CONFIRM_MS = 400;
/** How far behind the confirmed tip a status node whose "not found" carries no slot may be, in blocks: the engine's
 *  WELL_PAST_BLOCKS (30) believes such a "not found" from any node once the tip it read is more than 30 blocks past the
 *  last block a trade could land in, which is exactly safe for a node up to 31 blocks behind; a node further behind is
 *  that rule's documented, accepted limit. An answer that carries its slot may come from further (FAR_LAG_MAX). */
export const STATUS_LAG_LIMIT = 31;
/** The farthest behind a status node is whose answer carries its slot: the slot check holds at any distance (the case
 *  of 63fc09c: a node 100 slots behind, the backup link say). */
export const FAR_LAG_MAX = 150;
/** The deepest minority fork a status node is on, in blocks: the shared rule (src/chain/landing.ts) believes a "not
 *  found" whose slot shows its node has reached the last block a trade could land in once the tip is more than
 *  NOT_FOUND_MARGIN_BLOCKS (10) past that block, which is exactly safe for a node that has not seen up to 11 of the main
 *  fork's newest blocks; a deeper fork is that margin's documented, accepted limit (as STATUS_LAG_LIMIT is the 30-block
 *  rule's). */
export const FORK_LIMIT = 11;
/** Fork depths (the main fork's newest blocks a node on a minority fork has not seen) and their weights: a leader's whole
 *  window of four slots lost to the next leader (4), two of them (8), and parts of windows around them. */
const FORK_DEPTHS: readonly (readonly [number, number])[] = [[14, 1], [12, 2], [10, 3], [26, 4], [4, 5], [4, 6], [4, 7], [14, 8], [4, 9], [4, 10], [4, 11]];
/** A real buy is signed with a short blockhash (src/chain/connection.ts getShortBlockhash): the oldest kept that has at
 *  least BUY_BLOCKHASH_MIN_BLOCKS (40) left, and as few more as the half-minute of kept blockhashes allows (59 at most
 *  here); a saved tape without it, BUY_LEFT_DEFAULT. */
const BUY_LEFT_MAX = 59;
const BUY_LEFT_DEFAULT = 50;
/** src/tx/confirm.ts: the wait for a confirmation gives up this long after the trade was sent (HARD_CAP_MS); the executor
 *  then reads the trade's own transaction once and, when that cannot tell, answers "sent, outcome unknown". */
export const HARD_CAP_MS = 150_000;
/** src/tx/confirm.ts: a status poll every 300 ms (POLL_MS), each answered after a few tens of ms; every ten polls a look
 *  at whether the trade has run out (the tip, then its status from any node), at every poll once the chain is past the
 *  margin. */
const POLL_STEP_MS = 330;
const LOOK_MS = 10 * POLL_STEP_MS;
/** A read of the tip takes at most about 8.5 s (readLatency): a look sent while the chain is this many blocks short of a
 *  trade's last valid height cannot find it past it (a block a slot at most), and reads nothing more than the tip. */
const READ_REACH_BLOCKS = Math.ceil(8_700 / SLOT_MS) + 1;
/** At most this many of the executor's own polls go by (about 30 s) before one is answered by a node that has confirmed
 *  the trade's block (`seen`). */
const MAX_SEEN_POLLS = 90;
/** On a chain whose nodes disagree, the share of status reads of a trade that landed whose node cannot return its
 *  transaction yet (`unread`). */
const UNREAD_SHARE = 0.05;

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

/** How many of the main fork's newest blocks a node on a minority fork has not seen (one draw): 1 to FORK_LIMIT. */
export function forkDepth(r: Rng): number {
  return r.weighted(FORK_DEPTHS);
}

/** How far behind the confirmed tip a status node is (one draw): mostly 1 to `max`, one read in eight from further, up to
 *  FAR_LAG_MAX (an answer without a slot is then held to STATUS_LAG_LIMIT: see planStatus). */
function lagDepth(r: Rng, max: number): number {
  const x = r.next();
  return x < 0.875 ? 1 + Math.floor((x / 0.875) * max) : max + 1 + Math.floor(((x - 0.875) / 0.125) * (FAR_LAG_MAX - max));
}

/** The executor's own wait for one real trade (see the top of the file). */
interface Watch {
  exec: Exec;
  c: BuyCall | SellCall;
  sentAt: number;
  lastValid: number;
  /** Its 150 s cap. */
  cap: number;
  /** When its polls see it in a block a polled node has confirmed (undefined: it never goes into one). */
  seenAt?: number;
  done: boolean;
  /** A look is in flight (the cap waits for it, as the real loop finishes the poll it is in). */
  looking: boolean;
  capDue: boolean;
  /** How it ended (told first). */
  settled(how: Settled): void;
  /** Its outcome in its block, seen by its polls or a look: landed, or failed on chain. */
  outcome(): void;
  /** A look called it expired. */
  expired(): void;
  /** Its cap: the last read found it landed or failed, or could not tell ('unknown': nobody was waiting, or the read
   *  failed, found nothing, saw it only at "processed", or could not read its transaction). */
  capped(state: 'landed' | 'failed' | 'unknown'): void;
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
  /** What the chain model did (reported with the run): sales that landed late, buys that landed late; tip reads (from a
   *  node a little behind); status reads (by the engine and by the executor's own wait: from a node behind the tip, and
   *  those that missed a trade or failure already in a block; from a node far behind, with its slot; from a node on a
   *  minority fork, and those that missed one, by the fork's depth; from a node behind on its confirmations; answered
   *  'processed', so the executor threw; "not found" without a slot; a landed trade whose transaction could not be read);
   *  status reads of buys by the engine; the executor's own wait: its looks that read a status, the trades it called
   *  expired (by the rule's branch), the answers "outcome unknown" at its cap, and those of them that landed afterwards,
   *  and its last reads at the cap that found the trade landed; answers its polls saw late (from nodes behind); reads
   *  that took the main link's time limit (4 s or more); reads answered during a slow period. */
  readonly counts = {
    lateLandings: 0, lateBuys: 0, tipReads: 0, tipBehind: 0, statusReads: 0, laggedReads: 0, laggedMisses: 0, farLagReads: 0,
    forkReads: 0, forkMisses: 0, forkReads1to3: 0, forkReads4: 0, forkReads5to7: 0, forkReads8: 0, forkReads9to11: 0, forkMissesDeep: 0,
    confBehindReads: 0, processedReads: 0, slotlessReads: 0, unreadReads: 0, buyStatusReads: 0,
    execLooks: 0, execStatusReads: 0, execExpired: 0, execExpiredSlotted: 0, execExpiredWellPast: 0, execExpiredBuys: 0,
    capped: 0, cappedBuys: 0, cappedThenLanded: 0, capReadLanded: 0, seenLate: 0,
    slowReads: 0, readsInSlow: 0,
  };
  /** Quiescence: every trade, quote and balance read succeeds promptly, whatever the tape says (a read of the chain's
   *  tip or of a trade's status never fails either, but keeps its node and the time it takes: see planTip). */
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
  /** The rule the executor's own wait calls a trade expired by (the self-test plants another: run.ts). */
  expiryRule: ExpiryRule = EXPIRY_RULE;
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
    /** Two more streams of their own (run.ts derives them from the seed), so that every other draw stays as it was: a
     *  buy's short blockhash and whether it lands late (`buys`, recorded on the buy's plan), and how many of the executor's
     *  own polls go by before one sees a trade's block (`seen`) and whether a status node cannot return a transaction yet
     *  (`unread`) (`polls`, recorded on the plans). */
    private readonly more: { buys: Rng; polls: Rng },
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
  /** When a real trade signed with this last valid height goes into a block if it reaches the leader at `at` (or, `late`,
   *  in the block at its last valid height plus that): never past one past its last valid height (a buy's short
   *  blockhash can run out before a slow confirmation's L1 is over: it then goes into its last block). */
  private goesAt(at: number, lastValid: number, late: number | undefined): number {
    if (late !== undefined) return this.timeOf(lastValid + late);
    const t = this.landingAt(at);
    return this.processedHeight(t) > lastValid + LAST_BLOCK_PAST_VALID ? this.timeOf(lastValid + LAST_BLOCK_PAST_VALID) : t;
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
  /** The chain's nodes disagree in this scenario (lag and slow): status reads from nodes behind, on a fork, behind on
   *  their confirmations. */
  private nodesDisagree(): boolean {
    const f = this.faults;
    return (f.statusLag ?? 0) > 0 || (f.forkRead ?? 0) > 0 || (f.confBehind ?? 0) > 0;
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
      // (from the buys' own stream: the outcomes' stream stays as it was) Its short blockhash's blocks left; and, where
      // sells land late, a buy that lands may land in the last blocks of it too (one of unknown outcome, more often).
      const b = this.more.buys;
      plan.left = b.int(BUY_BLOCKHASH_MIN_BLOCKS, BUY_LEFT_MAX);
      if ((f.lateLand ?? 0) > 0 && !plan.fail && plan.unsure !== 'lost' && b.chance(plan.unsure === 'landed' ? f.lateLand! : f.lateLand! / 2)) plan.late = b.int(-3, 1);
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
      // (only a sell that lands can land late) A sell that never lands used to be told "expired" here, +2 to +4 past its
      // last valid height: its own looks tell it now (the draw stays, so that every draw after it is as it was).
      if ((f.lateLand ?? 0) > 0 && (!plan.fail || plan.ghost) && r.chance(f.lateLand!)) plan.late = r.int(-3, 1);
      else if ((f.lateLand ?? 0) > 0 && plan.fail === EXPIRED && !plan.ghost && !plan.unsure) r.int(2, 4);
    }
    if (f.refineNull > 0 && r.chance(f.refineNull)) plan.refineNull = true;
    // (from the polls' own stream) Where the nodes disagree, how many of the executor's polls go by before one is
    // answered by a node that has confirmed the trade's block.
    if (this.nodesDisagree()) { const k = this.seenPolls(); if (k > 0) plan.seen = k; }
    this.tape[kind][i] = plan;
    return plan;
  }
  /** The executor's polls after a trade's block is confirmed (one every 330 ms, a block every slot or so meanwhile): how
   *  many go by before one is answered by a node that has confirmed it. A node `d` blocks short of the newest confirmed
   *  block (behind the tip, on a fork that has not seen the main fork's last d, behind on its confirmations by d) has it
   *  once d blocks have gone by. */
  private seenPolls(): number {
    const f = this.faults;
    const r = this.more.polls;
    for (let k = 0; k < MAX_SEEN_POLLS; k++) {
      const blocks = Math.floor((k * POLL_STEP_MS) / SLOT_MS);
      const d = (f.statusLag ?? 0) > 0 && r.chance(f.statusLag!) ? lagDepth(r, Math.min(f.statusLagMax ?? STATUS_LAG_LIMIT, STATUS_LAG_LIMIT))
        : (f.forkRead ?? 0) > 0 && r.chance(f.forkRead!) ? forkDepth(r)
          : (f.confBehind ?? 0) > 0 && r.chance(f.confBehind!) ? r.int(1, Math.max(1, f.confBehindMax ?? 40)) : 0;
      if (d <= blocks) return k;
    }
    return MAX_SEEN_POLLS;
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
  /** How long this status read of a trade takes, and which node answers it (from the reads' stream; in the quiet phase
   *  too, see planTip). */
  private planStatus(): StatusPlan {
    const i = this.cursor.status++;
    const hit = this.tape.status?.[i];
    if (typeof hit === 'number') return { lag: Math.min(hit, STATUS_LAG_LIMIT) };
    if (hit) return hit.lag && hit.noSlot ? { ...hit, lag: Math.min(hit.lag, STATUS_LAG_LIMIT) } : hit;
    if (this.replay) return {};
    const f = this.faults;
    const r = this.readRng;
    const plan: StatusPlan = {};
    if (!f.instant) plan.L = readLatency(r);
    if ((f.statusLag ?? 0) > 0 && r.chance(f.statusLag!)) plan.lag = lagDepth(r, Math.max(1, Math.min(f.statusLagMax ?? STATUS_LAG_LIMIT, STATUS_LAG_LIMIT)));
    else if ((f.forkRead ?? 0) > 0 && r.chance(f.forkRead!)) plan.fork = forkDepth(r);
    if ((f.confBehind ?? 0) > 0 && r.chance(f.confBehind!)) plan.conf = r.int(1, Math.max(1, f.confBehindMax ?? 40));
    if ((f.noSlot ?? 0) > 0 && r.chance(f.noSlot!)) plan.noSlot = true;
    // (an answer without a slot comes from a node at most STATUS_LAG_LIMIT blocks behind: the 30-block rule's tolerance)
    if (plan.lag && plan.noSlot) plan.lag = Math.min(plan.lag, STATUS_LAG_LIMIT);
    // (from the polls' own stream: the reads' stream stays as it was)
    if (this.nodesDisagree() && this.more.polls.chance(UNREAD_SHARE)) plan.unread = true;
    if (Object.keys(plan).length) (this.tape.status ??= [])[i] = plan;
    return plan;
  }

  // ── the executor's own wait (src/tx/confirm.ts, src/engine/executor.ts sendAndRead) ──
  /**
   * Runs the executor's wait for a real trade that has been sent: its polls (`seenAt`), its looks at whether it has run out
   * (each a tip read and, once the chain is past its last valid height, a status read by a node of the model, judged by
   * `expiryRule`), its 150 s cap and the last read after it. Exactly one of outcome, expired and capped is called.
   */
  private watch(w: Watch): void {
    if (this.faults.instant) { this.after(Math.max(0, (w.seenAt ?? w.sentAt) - this.sim.now), () => { if (!w.done) { w.done = true; w.settled('seen'); w.outcome(); } }); return; }
    if (w.seenAt !== undefined && w.seenAt < w.cap) {
      this.after(w.seenAt - this.sim.now, () => { if (w.done) return; w.done = true; w.settled('seen'); w.outcome(); });
    } else {
      this.after(w.cap - this.sim.now, () => { if (w.done) return; if (w.looking) w.capDue = true; else this.lastLook(w); });
    }
    const first = this.firstLook(w);
    if (first !== undefined) this.after(first - this.sim.now, () => this.look(w));
  }
  /** The first look (every LOOK_MS from the send) that could find the chain past the trade's last valid height; none when
   *  its polls see it first or its cap comes first. */
  private firstLook(w: Watch): number | undefined {
    for (let t = w.sentAt + LOOK_MS; t < w.cap; t += LOOK_MS) {
      if (w.seenAt !== undefined && t >= w.seenAt) return undefined;
      if (this.height(t) + READ_REACH_BLOCKS > w.lastValid) return t;
    }
    return undefined;
  }
  /** One look: the tip (by a node of the model, after its latency); past the trade's last valid height, its status (by a
   *  node of the model, after its latency) with the shared rule. A read that fails (an outage) is a look that told nothing. */
  private look(w: Watch): void {
    if (w.done || !w.exec.alive) return;
    w.looking = true;
    // (the process is gone while a look was in flight: no more looks; a cap that came meanwhile is answered, to nobody, so
    // that every trade has its answer)
    const gone = () => { w.looking = false; if (w.capDue && !w.done) { w.capDue = false; this.lastLook(w); } };
    const tp = this.planTip();
    const tipDown = this.outage();
    this.after(tp.L ?? 0, () => {
      if (w.done) { w.looking = false; return; }
      if (!w.exec.alive) { gone(); return; }
      const height = this.height() - (tp.behind ?? 0);
      const tip = { height, slot: this.slotAt(height) };
      if (tipDown || tip.height <= w.lastValid) { w.looking = false; this.nextLook(w, false); return; }
      const sp = this.planStatus();
      const down = this.outage();
      const askedAt = this.sim.now;
      this.after(sp.L ?? 0, () => {
        if (w.done) { w.looking = false; return; }
        if (!w.exec.alive) { gone(); return; }
        w.looking = false;
        const past = tip.height > w.lastValid + LAST_BLOCK_PAST_VALID + NOT_FOUND_MARGIN_BLOCKS;
        // (a read that failed: the next look ten polls on, as the real loop's error path leaves it)
        if (down) { this.nextLook(w, false); return; }
        const a = this.statusAnswer(w.c, sp, askedAt, true);
        this.counts.execLooks++;
        const said = this.answerText(a);
        const node = `tip read at height ${tip.height}${tp.behind ? ` (from a node ${tp.behind} behind)` : ''}, its last block ${w.lastValid + LAST_BLOCK_PAST_VALID}, status from ${this.nodeText(a)}`;
        if (a.state === 'landed' || a.state === 'failed') {
          w.done = true;
          w.settled('seen');
          this.hooks.execLine(`exec ${w.c.kind}#${w.c.id}: its wait looks (${node}): ${said}`);
          w.outcome();
          return;
        }
        const rule = this.expiryRule(w.lastValid, tip, a);
        if (rule) {
          w.done = true;
          w.settled('expired');
          this.counts.execExpired++;
          if (w.c.kind === 'buy') this.counts.execExpiredBuys++;
          if (rule === 'slotted') this.counts.execExpiredSlotted++;
          if (rule === 'wellPast') this.counts.execExpiredWellPast++;
          this.hooks.expired(w.c, rule, `${node}: ${said}; the chain at ${this.height()} confirmed, ${this.processedHeight()} produced`);
          w.expired();
          return;
        }
        this.hooks.execLine(`exec ${w.c.kind}#${w.c.id}: its wait looks (${node}): ${said}, not believed${past ? ' (looked at again at the next poll)' : ''}`);
        this.nextLook(w, past);
      });
    });
  }
  /** The next look: ten polls on, or at the next poll once the chain is past the margin; at the cap, the last read. */
  private nextLook(w: Watch, past: boolean): void {
    if (w.done) return;
    if (w.capDue || this.sim.now >= w.cap) { w.capDue = false; this.lastLook(w); return; }
    const t = this.sim.now + (past ? POLL_STEP_MS : LOOK_MS);
    if (t >= w.cap) return; // (the cap's own event takes it from there)
    if (w.seenAt !== undefined && t >= w.seenAt) return; // (its polls see it first)
    this.after(t - this.sim.now, () => this.look(w));
  }
  /** The cap: the executor reads the trade's own transaction once (src/engine/executor.ts sendAndRead, settled()). */
  private lastLook(w: Watch): void {
    if (w.done) return;
    if (!w.exec.alive) { w.done = true; w.settled('cap'); w.capped('unknown'); return; }
    const sp = this.planStatus();
    const down = this.outage();
    const askedAt = this.sim.now;
    this.after(sp.L ?? 0, () => {
      if (w.done) return;
      w.done = true;
      w.settled('cap');
      if (!w.exec.alive || down) { w.capped('unknown'); return; }
      const a = this.statusAnswer(w.c, sp, askedAt, true);
      const state = a.state === 'landed' && !sp.unread ? 'landed' : a.state === 'failed' ? 'failed' : 'unknown';
      if (state === 'landed') this.counts.capReadLanded++;
      this.hooks.execLine(`exec ${w.c.kind}#${w.c.id}: its wait gave up at its 150 s cap; one last read (status from ${this.nodeText(a)}): ${this.answerText(a)}${a.state === 'landed' && sp.unread ? ', but its transaction cannot be read yet' : ''} → ${state === 'unknown' ? '"sent, outcome unknown"' : state}`);
      w.capped(state);
    });
  }
  private nodeText(a: StatusAnswer): string {
    const node = a.fork ? `a node on a minority fork (the main fork's last ${a.fork} block${a.fork === 1 ? '' : 's'} unseen)` : a.lag ? `a node ${a.lag} blocks behind` : 'an up-to-date node';
    return `${node}${a.conf ? `, ${a.conf} behind on its confirmations` : ''}`;
  }
  private answerText(a: StatusAnswer): string {
    return a.state === 'landed' ? 'landed' : a.state === 'failed' ? 'failed on chain' : a.state === 'processed' ? 'seen in a block not confirmed yet ("processed")' : `not found (${a.slot !== undefined ? `slot ${a.slot}` : 'no slot'})`;
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
        if (call.doneAt !== undefined) return;
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
      // A real buy: built and signed first (the engine is told the signature, with its short blockhash's last valid height
      // and the fee it carries, as the executor tells them), then it is out of our hands.
      const signAt = Math.min(40, plan.L1);
      this.after(signAt, () => {
        if (!exec.alive) { call.severed = true; this.bump(owner, mint, -1); this.hooks.buyDone(call); return; }
        call.signature = `B${call.id}`;
        call.sentAt = this.sim.now;
        const lastValid = this.height() + (plan.left ?? BUY_LEFT_DEFAULT);
        call.lastValid = lastValid;
        this.signed.set(call.signature, call);
        try {
          req.onSigned?.(call.signature, { lastValidBlockHeight: lastValid, feeLamports: fee });
        } catch (err) {
          // Today's executor ignores it and sends the buy anyway; the fixed one does not send it.
          if (this.noRecordNoSend) {
            call.sentAt = undefined;
            call.notSent = true;
            return deliver({ ok: false, error: `could not be written down before sending it: ${(err as Error)?.message ?? String(err)}` });
          }
        }
        const sentAt = this.sim.now;
        const rest = plan.L1 - signAt;
        // Reported "outcome unknown", and in truth it never lands.
        if (plan.unsure === 'lost') return this.after(rest + plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
        // Refused before it went out (the RPC): it never lands.
        const errored = !!plan.fail && /errored/.test(plan.fail);
        const expires = plan.fail === EXPIRED;
        if (plan.fail && !errored && !expires) return this.after(rest, () => deliver({ ok: false, error: plan.fail! }));
        // It goes into a block (it lands, or fails on chain there) L1 after the call, in the block being built then, or late
        // in the last blocks of its short blockhash; never after the last one. One that expires never does.
        const late = !errored && !expires && plan.late !== undefined ? Math.min(Math.max(plan.late, -3), 1) : undefined;
        const goes = expires ? undefined : this.faults.instant ? sentAt + rest : this.goesAt(sentAt + rest, lastValid, late);
        let failError = '';
        if (goes !== undefined) {
          call.goesAt = goes;
          call.goesTo = this.processedHeight(goes);
          this.after(goes - this.sim.now, () => {
            const block = this.processedHeight();
            const failsHere = (why: string) => { call.chainFailed = true; call.failedAt = this.sim.now; call.failedBlock = block; failError = why; };
            if (errored) return failsHere(plan.fail!);
            // What the quote said, and what the wallet really receives (the price moved before the buy landed).
            const quote = this.tokensFor(mint, req.lamports);
            const tokens = plan.quoted ? (quote * BigInt(Math.round(plan.quoted * 1000))) / 1000n : quote;
            if (tokens <= 0n) return failsHere('sent but did not land: transaction errored: zero tokens out');
            const acct = `${owner}|${mint}`;
            const exact = est + (this.hasAccount.has(acct) ? 0n : ATA_RENT);
            const have = this.sol.get(owner) ?? 0n;
            if (have < exact) return failsHere('sent but did not land: transaction errored: Transfer: insufficient lamports');
            this.hasAccount.add(acct);
            this.sol.set(owner, have - exact);
            this.setTokens(owner, mint, this.tokens(owner, mint) + tokens);
            // (handed back with the quote's coin count when neither the wallet nor the transaction could be read in time)
            if (plan.quoted) call.quotedTokens = quote;
            Object.assign(call, { tokens, fee, est, exact, landedAt: this.sim.now, landedBlock: block });
            if (block > lastValid + LAST_BLOCK_PAST_VALID) this.hooks.problem('E4', 'fake-chain-buy-landed-after-its-blockhash', `buy#${call.id} landed in the block at height ${block}, past ${lastValid + LAST_BLOCK_PAST_VALID}, the last block its short blockhash allows`);
            if (block >= lastValid - 3) this.counts.lateBuys++;
            if (call.capped) this.counts.cappedThenLanded++;
            this.bySig.set(call.signature!, call);
            this.hooks.buyLanded(call);
          });
        }
        // Reported "outcome unknown" although it lands: at L1 + L2 after the call (before it lands, when it lands late).
        if (plan.unsure === 'landed') return this.after(Math.min(rest + plan.L2, HARD_CAP_MS), () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
        const answer = () => {
          if (call.landedAt === undefined) return deliver({ ok: false, error: failError || 'sent but did not land: transaction errored' });
          // As the real executor: when neither the wallet nor the transaction could be read within a second, the buy is
          // handed back with the quote's coin count and the exact count follows with the exact SOL.
          const refine = new Promise<{ lamports: bigint; tokens?: bigint } | null>((res) => {
            this.after(plan.L3 + 1, () => {
              call.refined = plan.refineNull ? 'null' : 'exact';
              call.refineSeen = exec.alive;
              this.hooks.refined(call);
              if (exec.alive) res(plan.refineNull ? null : { lamports: call.exact!, ...(plan.quoted ? { tokens: call.tokens! } : {}) });
            });
          });
          deliver({ ok: true, signature: call.signature!, tokens: call.quotedTokens ?? call.tokens!, lamports: est, simulated: false, feeLamports: fee, confirmedAt: call.landedAt, refine });
        };
        const seen = goes === undefined ? undefined : goes + (errored ? 0 : plan.L2) + (plan.seen ?? 0) * POLL_STEP_MS;
        if (seen !== undefined && plan.seen) this.counts.seenLate++;
        this.watch({
          exec, c: call, sentAt, lastValid, cap: sentAt + HARD_CAP_MS, ...(seen !== undefined ? { seenAt: seen } : {}), done: false, looking: false, capDue: false,
          settled: (how) => { call.settledBy = how; },
          outcome: answer,
          expired: () => deliver({ ok: false, error: EXPIRED }),
          capped: (state) => {
            if (state === 'landed') {
              // (read from its own transaction: its exact coins and SOL)
              call.settled = true;
              return deliver({ ok: true, signature: call.signature!, tokens: call.tokens!, lamports: call.exact!, simulated: false, feeLamports: fee, confirmedAt: this.sim.now, note: 'landed late; read from its own transaction' });
            }
            if (state === 'failed') return deliver({ ok: false, error: FAILED_AT_CAP });
            // (an answer only for an engine still waiting: one that is gone is told nothing)
            if (exec.alive) { call.capped = true; this.counts.capped++; this.counts.cappedBuys++; }
            deliver({ ok: false, error: UNKNOWN, uncertain: true });
          },
        });
      });
    });
  }

  /** What became of a buy, from its own transaction (the engine's restore() asks): answered after the read's latency,
   *  from the chain as it is then, by the node its plan names, as settleSell is. */
  settleBuy(exec: Exec, signature: string, _owner: string, _mint: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' } | { state: 'not_found'; slot?: number }> {
    if (!exec.alive) return NEVER;
    const down = this.planBal().fail || this.outage();
    const c = this.signed.get(signature);
    const plan: StatusPlan = c ? this.planStatus() : {};
    const sentAt = this.sim.now;
    // The highest tip the engine had been handed when it sent this read (it reads the tip first, then the status), and how
    // many tip reads it had made by then, and how many failed.
    const tip = exec.highTip ?? null;
    const tips = { tipReads: exec.tipReads, tipFails: exec.tipFails };
    return new Promise((resolve, reject) => {
      this.after(plan.L ?? 0, () => {
        if (!exec.alive) return; // (the engine is gone: nobody is waiting)
        if ((plan.L ?? 0) >= 4_000) this.counts.slowReads++;
        if (down) return reject(new Error('429 Too Many Requests'));
        if (!c) return resolve({ state: 'not_found', slot: this.slotAt(this.processedHeight()) });
        const answer = this.statusAnswer(c, plan, sentAt);
        if (answer.state === 'landed' && plan.unread) answer.unread = true;
        this.counts.buyStatusReads++;
        exec.reads.set(signature, { ...answer, tip, ...tips });
        this.hooks.buySettled(c, answer);
        if (answer.state === 'processed') return reject(new Error('seen in a block, not confirmed yet'));
        if (answer.unread) { this.counts.unreadReads++; return reject(new Error('landed, but its transaction cannot be read yet')); }
        if (answer.state === 'landed') {
          // (the exact figures, coins included, have reached the engine from here on)
          if (!c.settled && c.delivered && c.ok && exec.alive) { c.refined = 'exact'; c.refineSeen = true; this.hooks.refined(c); }
          c.settled = true;
          return resolve({ state: 'landed', tokens: c.tokens!, lamports: c.exact! });
        }
        if (answer.state === 'failed') return resolve({ state: 'failed' });
        return resolve(answer.slot === undefined ? { state: 'not_found' } : { state: 'not_found', slot: answer.slot });
      });
    });
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
   *  - on a minority fork of 1 to FORK_LIMIT blocks: it has not seen the main fork's last `fork` blocks, and the context
   *    slot of its "not found" is its own fork's, at least the tip's.
   * A sale (or a failure) in a block the node has confirmed: landed (failed); landed, but its transaction cannot be read
   * by this node yet (`unread`): the executor throws (the engine asks again). In a block it has and has not confirmed:
   * the executor throws "seen in a block, not confirmed yet" (the engine asks again). In a block it has not seen: "not
   * found", with the node's context slot (none, `noSlot`: an executor that cannot tell how far along the node was).
   */
  settleSell(exec: Exec, signature: string, _owner: string, _mint: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' } | { state: 'not_found'; slot?: number }> {
    if (!exec.alive) return NEVER;
    const down = this.planBal().fail || this.outage();
    const c = this.signedSells.get(signature);
    const plan: StatusPlan = c ? this.planStatus() : {};
    const sentAt = this.sim.now;
    // The highest tip the engine had been handed when it sent this read (it reads the tip first, then the status), and how
    // many tip reads it had made by then, and how many failed.
    const tip = exec.highTip ?? null;
    const tips = { tipReads: exec.tipReads, tipFails: exec.tipFails };
    return new Promise((resolve, reject) => {
      this.after(plan.L ?? 0, () => {
        if (!exec.alive) return; // (the engine is gone: nobody is waiting)
        if ((plan.L ?? 0) >= 4_000) this.counts.slowReads++;
        if (down) return reject(new Error('429 Too Many Requests'));
        if (!c) return resolve({ state: 'not_found', slot: this.slotAt(this.processedHeight()) });
        const answer = this.statusAnswer(c, plan, sentAt);
        if (answer.state === 'landed' && plan.unread) answer.unread = true;
        exec.reads.set(signature, { ...answer, tip, ...tips });
        this.hooks.sellSettled(c, answer);
        if (answer.state === 'processed') return reject(new Error('seen in a block, not confirmed yet'));
        if (answer.unread) { this.counts.unreadReads++; return reject(new Error('landed, but its transaction cannot be read yet')); }
        if (answer.state === 'landed') { c.settled = true; return resolve({ state: 'landed', tokens: c.sold!, lamports: c.exact! }); }
        if (answer.state === 'failed') return resolve({ state: 'failed' });
        return resolve(answer.slot === undefined ? { state: 'not_found' } : { state: 'not_found', slot: answer.slot });
      });
    });
  }

  /** The answer to a status read of a trade arriving now, from the node its plan names (see settleSell); `own`: a read of
   *  the executor's own wait (a look, the last read at its cap). */
  private statusAnswer(c: BuyCall | SellCall, plan: StatusPlan, sentAt: number, own = false): StatusAnswer {
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
    // The block the trade (or its failure) is in, if it has happened by now.
    const landed = c.landedAt !== undefined && c.landedAt <= now;
    const h = landed ? c.landedBlock : c.chainFailed && c.failedAt !== undefined && c.failedAt <= now ? c.failedBlock : undefined;
    const state: StatusAnswer['state'] = h !== undefined && h <= confirmed ? (landed ? 'landed' : 'failed') : h !== undefined && h <= seen ? 'processed' : 'not_found';
    const slot = state === 'not_found' && !plan.noSlot ? ctxSlot : undefined;
    this.counts.statusReads++;
    if (own) this.counts.execStatusReads++;
    if (this.slowAt(now)) this.counts.readsInSlow++;
    if (lag) { this.counts.laggedReads++; if (lag > STATUS_LAG_LIMIT) this.counts.farLagReads++; if (state === 'not_found' && h !== undefined) this.counts.laggedMisses++; }
    if (fork) {
      this.counts.forkReads++;
      this.counts[fork <= 3 ? 'forkReads1to3' : fork === 4 ? 'forkReads4' : fork <= 7 ? 'forkReads5to7' : fork === 8 ? 'forkReads8' : 'forkReads9to11']++;
      if (state === 'not_found' && h !== undefined) { this.counts.forkMisses++; if (fork >= 4) this.counts.forkMissesDeep++; }
    }
    if (plan.conf) this.counts.confBehindReads++;
    if (state === 'processed') this.counts.processedReads++;
    if (state === 'not_found' && plan.noSlot) this.counts.slotlessReads++;
    // The model's own promise, which the engine's slot check relies on: a node that is not on a minority fork and says
    // "not found" at a slot has seen every block up to that slot.
    if (state === 'not_found' && !fork && h !== undefined && slot !== undefined && slot >= this.slotAt(h)) {
      this.hooks.problem('E4', 'fake-chain-not-found-from-a-node-past-the-sale', `${c.kind}#${c.id}: "not found" at slot ${slot} from a node ${lag} blocks behind, while it is in the block at height ${h} (slot ${this.slotAt(h)})`);
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
        if (call.doneAt !== undefined) return;
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
      const part = (t: bigint) => {
        if (!plan.part) return t;
        const p = (t * BigInt(Math.round(plan.part * 1000))) / 1000n;
        return p > 0n ? p : 1n;
      };
      if (!live) {
        // A test sell: filled from the quote, nothing sent, nothing held.
        return this.after(plan.L1, () => {
          if (plan.fail) {
            call.chainFailed = !plan.ghost && /errored/.test(plan.fail);
            if (call.chainFailed) { call.failedAt = this.sim.now; call.failedBlock = this.processedHeight(); }
            return deliver({ ok: false, error: plan.fail });
          }
          const sold = part(tokens);
          const gross = this.value(mint, sold);
          const fee = (gross * bps) / 10_000n;
          const net = gross - fee - txc;
          Object.assign(call, { sold, est: net, exact: net, fee, signature: `PAPER_S${call.id}`, landedAt: this.sim.now });
          this.bySig.set(call.signature!, call);
          deliver({ ok: true, signature: call.signature!, tokens: sold, lamports: net, simulated: true, feeLamports: fee, note: 'test fill' });
        });
      }
      // As the real executor: the token account is closed (its rent returns) when the sell was built for all of it.
      const closing = !!req.closeIfEmpty && !req.checkFirst && tokens === wallet;
      // Built and signed: the engine is told the signature before the transaction goes out, with its blockhash's last
      // valid height, the fee it carries (from the quote) and whether the market can pay for only part of it.
      call.signature = `S${call.id}`;
      call.sentAt = this.sim.now;
      this.signedSells.set(call.signature, call);
      const lastValid = this.height() + VALID_BLOCKS;
      const info = { lastValidBlockHeight: lastValid, feeLamports: fee0, marketShort: !!plan.part };
      call.lastValid = lastValid;
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
      const sentAt = this.sim.now;
      // Reported "outcome unknown", and in truth it never lands.
      if (plan.unsure === 'lost') return this.after(plan.L1 + plan.L2, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
      const lands = !plan.fail || !!plan.ghost;
      const errored = !lands && /errored/.test(plan.fail!);
      const expires = !lands && plan.fail === EXPIRED;
      // Refused before it went out ('boom', the RPC): it never lands.
      if (!lands && !errored && !expires) return this.after(plan.L1, () => deliver({ ok: false, error: plan.fail! }));
      // A real sell that goes into a block (it lands, or fails on chain) does so L1 after it was sent, in the block being
      // built then (when that slot is skipped, the next one: on a slow chain it waits), or in the block its plan names
      // (`late`: its last valid height −3 to +1, about a minute after it was signed, nearly four in a slow period). One
      // that expires never goes into one: its own looks tell the engine so, once the chain is past it (see watch).
      const late = lands && plan.late !== undefined ? Math.min(Math.max(plan.late, -3), 1) : undefined;
      const goes = expires ? undefined : this.faults.instant ? sentAt + plan.L1 : this.goesAt(sentAt + plan.L1, lastValid, late);
      let failError = '';
      if (goes !== undefined) {
        call.goesAt = goes;
        call.goesTo = this.processedHeight(goes);
        this.after(goes - this.sim.now, () => {
          const block = this.processedHeight();
          const failsHere = (why: string) => { call.chainFailed = true; call.failedAt = this.sim.now; call.failedBlock = block; failError = why; };
          if (errored) return failsHere(plan.fail!);
          const heldNow = this.tokens(owner, mint);
          if (tokens > heldNow) return failsHere('sent but did not land: transaction errored: {"InstructionError":[2,{"Custom":1}]}');
          const have = this.sol.get(owner) ?? 0n;
          if (have < txc) return failsHere('sent but did not land: transaction errored: Transfer: insufficient lamports (cannot pay the fee)');
          const sold = part(tokens);
          const gross = this.value(mint, sold);
          const fee = (gross * bps) / 10_000n;
          let net = gross - fee - txc;
          // (a market that can pay for only part is known when the sell is built: such a sell does not close the account)
          if (closing && heldNow === sold) { net += ATA_RENT; this.hasAccount.delete(`${owner}|${mint}`); }
          this.setTokens(owner, mint, heldNow - sold);
          this.sol.set(owner, have + net);
          const est = sold === tokens ? est0 : (est0 * sold) / tokens;
          Object.assign(call, { sold, est, exact: net, fee, landedAt: this.sim.now, landedBlock: block });
          if (block > lastValid + LAST_BLOCK_PAST_VALID) this.hooks.problem('E4', 'fake-chain-sale-landed-after-its-blockhash', `sell#${call.id} landed in the block at height ${block}, past ${lastValid + LAST_BLOCK_PAST_VALID}, the last block its blockhash allows`);
          if (block >= lastValid - 3) this.counts.lateLandings++;
          if (call.capped) this.counts.cappedThenLanded++;
          this.bySig.set(call.signature!, call);
          if (plan.ghost) call.ghost = true;
          this.hooks.sellLanded(call);
        });
      }
      // A ghost: it lands and is reported "outcome unknown", L2 after it landed (the executor could read nothing: no look
      // tells it otherwise), at the cap at the latest.
      if (plan.ghost) return this.after(Math.min(goes! + plan.L2, sentAt + HARD_CAP_MS) - this.sim.now, () => deliver({ ok: false, error: UNKNOWN, uncertain: true }));
      const answer = () => {
        if (call.landedAt === undefined) return deliver({ ok: false, error: failError || plan.fail || 'sent but did not land: transaction errored' });
        const refine = new Promise<{ lamports: bigint } | null>((res) => {
          this.after(plan.L3 + 1, () => {
            call.refined = plan.refineNull ? 'null' : 'exact';
            call.refineSeen = exec.alive;
            this.hooks.refined(call);
            if (exec.alive) res(plan.refineNull ? null : { lamports: call.exact! });
          });
        });
        deliver({ ok: true, signature: call.signature!, tokens: call.sold!, lamports: call.est!, simulated: false, feeLamports: call.fee!, confirmedAt: call.landedAt, refine, marketShort: !!plan.part });
      };
      // What its polls see: L2 after its block (a failure on chain at once), later where they are answered by nodes that
      // have not confirmed it (`seen`).
      const seen = goes === undefined ? undefined : goes + (errored ? 0 : plan.L2) + (plan.seen ?? 0) * POLL_STEP_MS;
      if (seen !== undefined && plan.seen) this.counts.seenLate++;
      this.watch({
        exec, c: call, sentAt, lastValid, cap: sentAt + HARD_CAP_MS, ...(seen !== undefined ? { seenAt: seen } : {}), done: false, looking: false, capDue: false,
        settled: (how) => { call.settledBy = how; },
        outcome: answer,
        expired: () => deliver({ ok: false, error: EXPIRED }),
        capped: (state) => {
          if (state === 'landed') {
            // (read from its own transaction: its exact SOL, nothing to refine)
            call.settled = true;
            return deliver({ ok: true, signature: call.signature!, tokens: call.sold!, lamports: call.exact!, simulated: false, feeLamports: call.fee!, confirmedAt: this.sim.now, note: 'landed late; read from its own transaction', marketShort: !!plan.part });
          }
          if (state === 'failed') return deliver({ ok: false, error: FAILED_AT_CAP });
          // (an answer only for an engine still waiting: one that is gone is told nothing)
          if (exec.alive) { call.capped = true; this.counts.capped++; }
          deliver({ ok: false, error: UNKNOWN, uncertain: true });
        },
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
