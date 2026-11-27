// The copytrader. Reacts to followed wallets' trades (buys → copy buys, sells → "sell when they sell") and to the
// clock (timed sells, stop loss levels, dead coin). Every decision, copied or skipped, lands in the user's feed.
//
// Each position has one queue: its buy and all its sells run one after another, so two sells never race and each
// one sells its percent of what is left at that moment.
import type { Keypair } from '@solana/web3.js';
import { lamportsToSol } from '../config.js';
import { friendlyError, log, safeErrorMessage } from '../log.js';
import { LAST_BLOCK_PAST_VALID } from '../chain/connection.js';
import type { CopyRow, OwedSell, Position, SellOut, Store } from '../store.js';
import { soldShare, type LeaderTrade } from '../watch/parse.js';
import type { Executor, SignedInfo } from './executor.js';
import { dueSells, type SellOrder, type SellReason } from './rules.js';

export interface EngineDeps {
  store: Store;
  executor: Executor;
  /** The user's wallet keypair (decrypted in memory), or null when they have none. */
  walletFor: (userId: number) => Keypair | null;
  now?: () => number;
  /** How often an open position is re-quoted. */
  priceMs: number;
  /** The most one buy may spend; a function when the owner can change it while running. */
  maxSolPerBuy: number | (() => number);
  feeReserveSol: number;
  /** Platform fee (basis points) a user pays; omitted = none. */
  feeBpsFor?: (userId: number) => number;
  /** Leader trades older than this are not copied (e.g. caught up after downtime). */
  staleSec?: number;
  /** Pauses between tries of a bag-based timed step (the first retry is immediate). */
  fastRetryMs?: number[];
  /** After those, the pause between further tries of the LAST step, which never gives up. */
  slowRetryMs?: number;
  /** Pause before the wallet is read again when it answered "holds nothing" (default 300 ms). */
  zeroRecheckMs?: number;
  /** Longest pause between reads of a sell whose outcome was unknown (default 15 s; it starts at 1 s). */
  settleRetryMs?: number;
}

/** A step of a bag-based timed exit that fails is retried at once, then with these short pauses (about a minute in all). */
const FAST_RETRY_MS = [0, 250, 250, 500, 500, 1_000, 1_000, 2_000, 2_000, 4_000, 4_000, 8_000, 8_000, 15_000, 15_000];
/** Rent of the two token accounts a trade can open: the coin's own and a temporary wrapped-SOL one (about 0.0021 SOL each). */
const TOKEN_ACCOUNTS_RENT = 4_200_000n;
/** The last step of such an exit never gives up (the coins are still in the wallet): after the quick tries, one every 15 s. */
const SLOW_RETRY_MS = 15_000;

/** 1234567 base units at 6 decimals → "1.23" ; large amounts as K / M / B. */
export function fmtTokens(amount: bigint, decimals: number): string {
  const v = Number(amount) / 10 ** decimals;
  const short = (n: number) => String(Number(n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)));
  if (v >= 1e9) return `${short(v / 1e9)}B`;
  if (v >= 1e6) return `${short(v / 1e6)}M`;
  if (v >= 1e3) return `${short(v / 1e3)}K`;
  return short(v);
}

type OkFill = Extract<Awaited<ReturnType<Executor['sell']>>, { ok: true }>;
/** What booking a sell of the queue did: whether it closed the position, whether the market paid for only part of a
 *  full exit, and its fill. */
interface Booking { closed: boolean; partial: boolean; fillId: number }
/** What booking a timed step of the bag did: its fill, whether it closed the position, the SOL booked, and the
 *  position as it was before (for its feed line). */
interface BagBooking { fillId: number; closed: boolean; lamports: bigint; p: Position }

/** A sell written down by an earlier process and not found on chain this long after it was sent can no longer land
 *  (its blockhash lives about 60 to 90 s): it is dropped and its rule may sell again. */
const SELL_OUT_EXPIRES_MS = 180_000;

/** What a sell answers when the server is shutting down (src/server.ts stops the engine, then waits and exits). */
const STOPPING = 'the server is restarting';
/** What a press of Sell now is told then: it is written down and sold after the restart. */
const STOPPING_ANSWER = 'the server is restarting: this sell goes out as soon as it is back (a few seconds)';
/** What a press of Sell now is told when the position was closed before it could sell anything. */
const CLOSED_JUST_BEFORE = 'Nothing was left to sell: the position was closed just before (see the feed).';
/** What a press of Sell now is told when its own sale landed and its booking is written a few seconds later. */
const SOLD_BOOKED_SOON = 'Sold: it shows in the feed and History within a few seconds.';

/** An automatic sell that fails is retried after these pauses, then given up (Sell now stays available). */
const RETRY_MS = [250, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const MAX_SELL_TRIES = RETRY_MS.length + 1;
/** Dead coin needs a recent successful quote: an RPC outage is not "no trades". */
const QUOTE_FRESH_MS = 15_000;
/** A position no rule needs a price for (no stop loss, no dead coin) is priced this often: only the value shown uses
 *  it, and every price check costs requests the trades need. */
const IDLE_PRICE_MS = 30_000;

export function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function fmtSol(lamports: bigint): string {
  const v = lamportsToSol(lamports);
  return `${Number(v.toFixed(v >= 1 ? 3 : 4))} SOL`;
}

function fmtPct(p: number): string {
  return `${Number(p.toFixed(p < 1 ? 2 : 1))}%`;
}

/** What a sell settled from its own transaction is booked with besides its coins and SOL: the platform fee it carried
 *  and whether the market paid for only part of it (as the executor told when it was signed). */
function carried(s: { feeLamports?: bigint; marketShort?: boolean } | undefined): { feeLamports?: bigint; marketShort?: boolean } {
  return { ...(s?.feeLamports !== undefined ? { feeLamports: s.feeLamports } : {}), ...(s?.marketShort !== undefined ? { marketShort: s.marketShort } : {}) };
}

/** How a partial sell is written down until it is done (positions.owed_sells), or null for one that is not: their
 *  partial sell by its transaction, a stop loss level by its stage. */
function owedEntry(order: SellOrder): OwedSell | null {
  if (order.percent >= 100 || order.rest) return null;
  if (order.reason === 'mirror' && order.tag) return { reason: 'mirror', percent: order.percent, tag: order.tag };
  if (order.reason === 'stop_loss' && order.stage !== undefined) return { reason: 'stop_loss', percent: order.percent, stage: order.stage };
  return null;
}
function sameOwed(o: OwedSell, order: SellOrder): boolean {
  return o.reason === order.reason && (order.reason === 'mirror' ? o.tag === order.tag : o.stage === order.stage);
}

/** "Not found" is believed only this many blocks past the last block a sell could land in (about 4 s), and only from a
 *  node at least as far along as the one that gave the chain's height: the two are separate requests, perhaps answered
 *  by two nodes (a load-balanced link, or the backup link taking over one request). Waiting a few seconds more costs
 *  little; a sale that landed taken for one that did not is never booked, and its rule sells again. */
const NOT_FOUND_MARGIN_BLOCKS = 10;
/** Without the slots of the two reads to compare, well past it (about 12 s). */
const UNSLOTTED_MARGIN_BLOCKS = 30;

/**
 * A sell not found that never can land: the chain was past the last block it could land in when its height was read
 * (one past its blockhash's last valid height), with a margin, and the status came from a node at least as far along
 * as that read (one behind may not have seen a sale that landed in its last blocks yet: it was dropped, never booked,
 * and its rule sold again). Without the slots to tell, only well past it.
 */
function neverLands(lastValid: number, tip: { height: number; slot?: number }, statusSlot: number | undefined): boolean {
  const last = lastValid + LAST_BLOCK_PAST_VALID;
  if (tip.slot !== undefined && statusSlot !== undefined) return tip.height > last + NOT_FOUND_MARGIN_BLOCKS && statusSlot >= tip.slot;
  return tip.height > last + UNSLOTTED_MARGIN_BLOCKS;
}

/** P % of `held`, exact for 100 %; never more than held. */
export function portion(held: bigint, percent: number): bigint {
  if (percent >= 100) return held;
  const part = (held * BigInt(Math.floor(percent * 10_000))) / 1_000_000n;
  return part > held ? held : part;
}

const REASON_TEXT: Record<SellReason, (o: SellOrder, p: Position) => string> = {
  timed: (o, p) => `timed sell after ${p.sell.timed[o.stage ?? 0]?.afterSec ?? '?'}s`,
  // (a sell of everything owed whose level is not known, written down by an earlier version: just "stop loss")
  stop_loss: (o, p) => (o.stage === undefined ? 'stop loss' : `stop loss at −${p.sell.stopLoss[o.stage]?.lossPct ?? '?'}%`),
  dead_coin: (_o, p) => `dead coin (no trades for ${p.sell.deadCoin.idleSec}s)`,
  mirror: (o) => `they sold ${o.percent >= 100 ? 'out' : `${fmtPct(o.percent)} of theirs`}`,
  manual: () => 'you pressed Sell now',
};

export class Engine {
  private readonly now: () => number;
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly inFlight = new Set<string>();
  private readonly retries = new Map<string, { positionId: number; order: SellOrder; tries: number; nextAt: number }>();
  private readonly lastQuoteAt = new Map<number, number>();
  private readonly quoteOkAt = new Map<number, number>();
  /** Latest slot at which each leader sold each coin: a buy that arrives after its own later sell is not copied. */
  private readonly lastSellSlot = new Map<string, number>();
  private readonly solCache = new Map<string, { lamports: bigint; at: number }>();
  /** The balance read under way per wallet (one at a time; a trade of ours that lands starts a newer one). */
  private readonly balanceReads = new Map<string, Promise<bigint>>();
  /** SOL each wallet's buys under way have counted on (released once the wallet has been read after them). */
  private readonly spending = new Map<string, bigint>();
  /** Their sells that arrived while our buy's outcome was unknown, or while a sell from before a restart was not
   *  settled yet: run once that is settled. */
  private readonly pendingMirror = new Map<number, SellOrder[]>();
  /** Full exits that went out while another of our sells was on its way: once nothing is out any more, whatever is
   *  still held is sold too (an overlapping sell the market paid only part of, or one that failed for good). */
  private readonly exitOwed = new Map<number, SellOrder>();
  /** Failures of an owed Sell now's re-runs, per order (its feed line is written on the first one only). */
  private readonly owedFails = new Map<string, { positionId: number; n: number }>();
  /** Signatures of this process's own sells that are written down (sells_out) and still in its hands. */
  private readonly sending = new Set<string>();
  /**
   * Sells written down by an earlier process (it crashed, or stopped while their outcome was unknown) and not settled
   * yet. Until restore() has read what became of them they count as on their way: their coins stay reserved (Sell now
   * takes only what is free, and the coin is not bought again: one landing later would sell the new coins), and the
   * position's rules send nothing (their own step may have sold already; a rule of what is left must see it booked).
   */
  private readonly orphans = new Map<string, SellOut>();
  private readonly settlingOrphans = new Set<string>();
  /** Those of `orphans` this process sent itself (its booking failed, or its outcome stayed unknown): not "from before
   *  a restart" in what the user is told. */
  private readonly ownLeftovers = new Set<string>();
  /** Those of them known to have landed (only their booking failed): sold, not "if it did not go through". */
  private readonly landedLeftovers = new Set<string>();
  /** Sells of this process known not to land (they failed, or were dropped) whose row could not be deleted (the
   *  database failing): never taken up as left behind (their position waited for a sell that had failed, holding its
   *  rules and Sell now); the row goes on a later pass, when the database takes the delete. */
  private readonly failedRows = new Set<string>();
  /** Real buys of this process that landed but could not be booked (the database failing), with the moment each was
   *  confirmed: booked from their own transactions by the next pass (every 5 s while there is one), their timed sells
   *  counting from that moment, not from the late booking. */
  private readonly unbookedBuys = new Map<number, number>();
  /** Their partial sells ("same share") that could not be written down as owed (the database failing): owed here
   *  until done, so they are still sold (only one written down as owed is sold: see sell()). */
  private readonly owedInMemory = new Set<string>();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    // Before the first tick: a step whose sell is still out must not go out again.
    this.adoptOrphans();
  }

  // ── leader trades ─────────────────────────────────────────────────────
  /**
   * Decides synchronously and queues the work; it does not wait for buys and sells to finish (the watcher must
   * keep reading the next transactions meanwhile).
   */
  async onLeaderTrade(t: LeaderTrade): Promise<void> {
    // Shutting down: no new copies (the buy is left unseen, so a new process may still take it within its 20 s).
    if (this.stopped && t.side === 'buy') return;
    // A copy of a fast trader's buy that is this late is a loss more often than not (the poll, the backup feed,
    // brings trades 4-5 s late; a restart can bring older ones).
    const staleSec = this.deps.staleSec ?? 20;
    // Old buys are not copied (caught up after downtime). Old sells still are: we may be holding that coin.
    if (t.side === 'buy' && t.blockTime && this.now() / 1000 - t.blockTime > staleSec) return;
    if (!this.deps.store.markSeen(`${t.signature}:${t.mint}`)) return;
    const coinKey = `${t.leader}:${t.mint}`;
    if (t.side === 'sell') this.lastSellSlot.set(coinKey, Math.max(t.slot, this.lastSellSlot.get(coinKey) ?? 0));
    else if ((this.lastSellSlot.get(coinKey) ?? -1) > t.slot) return; // they already sold after this buy
    if (this.lastSellSlot.size > 50_000) this.lastSellSlot.clear();
    const jobs: Promise<unknown>[] = [];
    if (t.side === 'buy') {
      for (const copy of this.deps.store.enabledCopiesForLeader(t.leader)) {
        // (a write of one copy that fails, the database failing, does not keep the others from copying it)
        try {
          const job = this.startCopyBuy(copy, t);
          if (job) jobs.push(job);
        } catch (err) {
          log.warn('a copy of their buy could not be started', { copy: copy.id, error: safeErrorMessage(err) });
        }
      }
    } else {
      for (const p of this.deps.store.activePositions()) {
        if (p.leader !== t.leader || p.mint !== t.mint || !p.sell.mirror.enabled) continue;
        const share = soldShare(t);
        const soldOut = share >= 0.995 || t.tokensAfter === 0n;
        // 'exit': only their full exit counts; a partial sell of theirs changes nothing for us.
        if (p.sell.mirror.mode === 'exit' && !soldOut) continue;
        const percent = p.sell.mirror.mode !== 'same' || soldOut ? 100 : share * 100;
        const order: SellOrder = { reason: 'mirror', percent, tag: t.signature };
        // Written down at once: their full exit until the position is closed, their partial sell until our share of it
        // is sold. A restart or a crash before then (it may wait behind another sell of ours) must not forget it. (A
        // write that fails, the database failing, does not keep it, or another position's, from being sold: their
        // partial sell is then owed in memory.)
        if (percent >= 100) this.quietly('their exit owed', () => this.writeExitOwed(p, order));
        else {
          try {
            this.oweSell(p, order);
          } catch (err) {
            this.owedInMemory.add(`${p.id}:${order.tag}`);
            log.warn('their sell could not be written down: owed in memory', { position: p.id, error: safeErrorMessage(err) });
          }
        }
        if (this.stopped) { this.quietly('a sell owed after the restart', () => this.oweAfterRestart(p.id, order)); continue; }
        const key = this.orderKey(p.id, order);
        this.inFlight.add(key);
        jobs.push(this.enqueue(p.id, () => this.sell(p.id, order)).finally(() => { this.inFlight.delete(key); this.closeIfEmpty(p.id); }));
      }
    }
    void Promise.all(jobs);
  }

  /** SOL balance from memory when it is under a minute old (keepBalancesFresh() renews it every few seconds, and each
   *  of our trades renews it as it lands), so a buy never waits for a read; read now otherwise. */
  private async solBalance(owner: string): Promise<bigint> {
    const hit = this.solCache.get(owner);
    if (hit && this.now() - hit.at < 60_000) return hit.lamports;
    return this.readBalance(owner);
  }

  /** The wallet's SOL as last read, when that read is under `maxAgeMs` old (renewed every 3 s and after each of our
   *  trades); null otherwise. For the dashboard: no read of its own. */
  knownBalance(owner: string, maxAgeMs = 5_000): bigint | null {
    const hit = this.solCache.get(owner);
    return hit && this.now() - hit.at < maxAgeMs ? hit.lamports : null;
  }

  /** Reads the wallet's SOL and keeps it. `fresh`: a new read even while one is out (that one may predate a trade). */
  private readBalance(owner: string, fresh = false): Promise<bigint> {
    const out = this.balanceReads.get(owner);
    if (out && !fresh) return out;
    const read: Promise<bigint> = this.deps.executor.solBalance(owner).then((lamports) => {
      // Only the newest read is kept: an older one may have been answered before our trade landed.
      if (this.balanceReads.get(owner) === read) this.solCache.set(owner, { lamports, at: this.now() });
      return lamports;
    });
    this.balanceReads.set(owner, read);
    void read.catch(() => undefined).finally(() => { if (this.balanceReads.get(owner) === read) this.balanceReads.delete(owner); });
    return read;
  }

  /**
   * One of our trades just moved this wallet's SOL: it is read again at once, in the background. Until that read is
   * in, the balance from before stays (a buy never waits for it), and `release` (the buy's reservation) waits too.
   */
  private balanceChanged(owner: string, release?: () => void): void {
    void this.readBalance(owner, true).catch(() => { this.solCache.delete(owner); }).finally(() => release?.());
  }

  /** Sets SOL aside for a buy under way, so two buys at once never count the same SOL; returns its release. */
  private reserveSol(owner: string, lamports: bigint): () => void {
    this.spending.set(owner, (this.spending.get(owner) ?? 0n) + lamports);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.spending.get(owner) ?? 0n) - lamports;
      if (left > 0n) this.spending.set(owner, left);
      else this.spending.delete(owner);
    };
  }

  /**
   * Renews the SOL balance of every wallet that may buy soon (its owner has an enabled copy), so the check in front
   * of a buy reads memory, not the network. The server calls it every few seconds; failed reads keep the old value.
   */
  async keepBalancesFresh(): Promise<void> {
    const { store } = this.deps;
    const owners = new Set<string>();
    for (const leader of store.watchedLeaders()) {
      for (const copy of store.enabledCopiesForLeader(leader)) {
        const w = this.deps.walletFor(copy.userId);
        if (w) owners.add(w.publicKey.toBase58());
      }
    }
    await Promise.all([...owners].map((owner) => this.readBalance(owner).catch(() => undefined)));
  }

  /** Synchronous checks and the 'opening' row happen before any await, so a sell right behind the buy finds it. */
  private startCopyBuy(copy: CopyRow, t: LeaderTrade): Promise<unknown> | null {
    const { store } = this.deps;
    const s = copy.settings;
    const skip = (why: string) => {
      store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'skip', message: `Skipped ${shortMint(t.mint)} (${s.name}): ${why}`, mint: t.mint, signature: t.signature });
      return null;
    };
    const minLamports = BigInt(Math.round(s.minLeaderBuySol * 1e9));
    // A buy read from pump.fun's event (the fast path) is about 1 % under what the wallet really spent (a trading
    // bot's own fee is not in the event): within 1.5 % of the minimum it counts as meeting it.
    const meets = t.solLamports >= minLamports || (t.approx === true && t.solLamports * 1000n >= minLamports * 985n);
    if (!meets) return skip(`they bought ${fmtSol(t.solLamports)}, under your ${fmtSol(minLamports)} minimum`);
    // One position per coin per user: not bought again (by this or another of their copies) until it has been exited.
    if (store.activePositionOfUser(copy.userId, t.mint)) return skip('already holding this coin');
    if (s.oncePerCoin && store.hasTraded(copy.id, t.mint)) return skip('already traded this coin (buy once per coin is on)');
    // A sell of an earlier position of this coin still on its way (stuck, re-sent until it lands) would sell the new
    // coins when it lands: not bought again until it has landed or failed.
    if (this.sellOutFor(copy.userId, t.mint)) return skip('a sell of this coin is still on its way (it would sell the new coins)');
    const maxBuy = typeof this.deps.maxSolPerBuy === 'function' ? this.deps.maxSolPerBuy() : this.deps.maxSolPerBuy;
    if (s.buySol > maxBuy) return skip(`${s.buySol} SOL is above the server limit of ${maxBuy} SOL per buy`);
    const wallet = this.deps.walletFor(copy.userId);
    if (!wallet) return skip('no wallet imported yet');

    // Written down as what it will really be: with Live trading off it is a test buy, so a crash in the middle of it
    // can never be restored as a real position (and then sell coins the wallet already held, for real).
    const mode = this.deps.executor.isLive({ live: true }) ? 'live' : 'paper';
    const id = store.insertPosition({ userId: copy.userId, copyId: copy.id, mint: t.mint, mode, leaderSig: t.signature, sell: s.sell, copyName: s.name, leader: t.leader, now: this.now(), decimals: t.decimals ?? 6 });
    return this.enqueue(id, () => this.buy(id, copy, wallet, t));
  }

  private async buy(id: number, copy: CopyRow, wallet: Keypair, t: LeaderTrade): Promise<void> {
    const { store, executor } = this.deps;
    const s = copy.settings;
    const lamports = BigInt(Math.round(s.buySol * 1e9));
    const label = `${shortMint(t.mint)} (${s.name})`;
    const owner = wallet.publicKey.toBase58();
    // The SOL this buy counts on, set aside until the wallet has been read again after it (whatever its outcome).
    let release: (() => void) | null = null;
    try {
      const feeBps = this.deps.feeBpsFor?.(copy.userId) ?? 0;
      if (executor.isLive({ live: true })) {
        const platformFee = (lamports * BigInt(Math.floor(feeBps))) / 10_000n;
        // Besides the buy itself the wallet must be able to get out again: the buy's own fees, one sell's fees (they
        // are paid before its proceeds arrive) and the rent of two token accounts (the coin's, and the temporary
        // wrapped-SOL one a PumpSwap or Jupiter trade opens). The flat reserve is the floor.
        const reserve = BigInt(Math.round(this.deps.feeReserveSol * 1e9));
        const lam = (v: number | undefined) => BigInt(Math.round(Math.max(0, v ?? 0) * 1e9));
        const costs = lam(s.priorityFeeSol) + lam(s.tipSol) + lam(s.sellPriorityFeeSol ?? s.priorityFeeSol) + lam(s.sellTipSol ?? s.tipSol) + TOKEN_ACCOUNTS_RENT;
        const need = lamports + platformFee + (costs > reserve ? costs : reserve);
        // The balance is kept fresh in the background (no read in front of the buy). The coin is looked up meanwhile,
        // unless pump.fun's own event of their trade already says everything the buy needs.
        const [have] = await Promise.all([this.solBalance(owner), t.curve ? undefined : executor.warm?.(t.mint).catch(() => undefined)]);
        // Other buys of this wallet under way have counted on part of it.
        const busy = this.spending.get(owner) ?? 0n;
        if (have - busy < need) {
          store.updatePosition(id, { status: 'failed', closedAt: this.now() });
          store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'skip', message: `Skipped ${label}: wallet has ${fmtSol(have)}${busy > 0n ? ` (${fmtSol(busy)} of it going into other buys right now)` : ''}, needs ${fmtSol(need)} (buy${platformFee > 0n ? ' + platform fee' : ''} + ${costs > reserve ? 'the fees to get in and out again' : 'fee reserve'})`, mint: t.mint, signature: t.signature });
          return;
        }
        release = this.reserveSol(owner, need);
      }
      // The buy's signature is written down the moment it is signed: if the outcome is lost (a crash, no answer from
      // the RPC), restore() reads that very transaction instead of guessing from the wallet.
      // (Signed means sent for real: the row says live from here on, even if Live was switched on while it was built.)
      // The server stopped while the wallet's balance was read: the copy is not made.
      if (this.stopped) {
        store.updatePosition(id, { status: 'failed', closedAt: this.now() });
        store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'skip', message: `Skipped ${label}: the server is restarting`, mint: t.mint, signature: t.signature });
        return;
      }
      let signedAt = 0;
      // (with the platform fee it carries: a buy settled later from its own transaction is booked with it)
      const onSigned = (sig: string, info?: SignedInfo) => { signedAt = Date.now(); store.updatePosition(id, { buySig: sig, mode: 'live', ...(info ? { buyFeeLamports: info.feeLamports } : {}) }); };
      const fill = await executor.buy({ wallet, mint: t.mint, lamports, slippagePct: s.slippagePct, priorityFeeSol: s.priorityFeeSol, tipSol: s.tipSol ?? 0, live: true, feeBps, onSigned, ...(t.curve ? { curve: t.curve } : {}), ...(t.heardAt ? { heardAt: t.heardAt } : {}) });
      // How long after their trade was heard ours went out (signed and handed to the senders).
      const copyMs = signedAt && t.heardAt ? signedAt - t.heardAt : null;
      if (!fill.ok && fill.uncertain) {
        // It went out and nobody could tell us what became of it. Not failed, not bought: the position stays
        // "opening" (so the coin is not bought twice) and restore() settles it from the wallet within a minute.
        this.quietly('a feed line', () => store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label}: sent, but its outcome is not known yet (the connection did not answer). It is settled from the wallet within a minute.`, mint: t.mint, signature: t.signature }));
        return;
      }
      if (!fill.ok) {
        store.updatePosition(id, { status: 'failed', closedAt: this.now() });
        store.insertFill({ positionId: id, userId: copy.userId, side: 'buy', reason: 'copy', tokens: 0n, lamports, signature: null, simulated: false, error: fill.error });
        store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label} failed: ${friendlyError(fill.error)}`, mint: t.mint, signature: t.signature });
        return;
      }
      // Timed sells count from the moment OUR buy was confirmed, not from when the copied wallet bought.
      const now = fill.confirmedAt ?? this.now();
      // Booked in one step: the position opens with its fill, or neither is written. A real buy whose booking cannot
      // be written (the database failing) landed all the same: the position stays "opening" with its signature, and
      // the safety pass books it from its own transaction (it used to be marked failed, and its coins were never sold).
      let fillId: number;
      try {
        fillId = store.atomic(() => {
          // The position is live only if the buy really went on-chain (a copy flipped to Live on a test server is paper).
          store.updatePosition(id, { mode: fill.simulated ? 'paper' : 'live', status: 'open', tokensBought: fill.tokens, tokensHeld: fill.tokens, costLamports: fill.lamports, openedAt: now, lastChangeAt: now, refValueLamports: fill.lamports, buySig: fill.signature });
          return store.insertFill({ positionId: id, userId: copy.userId, side: 'buy', reason: 'copy', tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n, exactPending: !!fill.refine && !fill.simulated });
        });
      } catch (err) {
        if (fill.simulated) throw err; // a test buy: nothing was bought, it failed
        log.warn('a buy that landed could not be booked yet: it is booked from its own transaction', { position: id, signature: fill.signature, error: safeErrorMessage(err) });
        this.unbookedBuys.set(id, now);
        return;
      }
      // The exact SOL spent is read from the confirmed transaction afterwards; the position does not wait for it.
      this.refineLater(fillId, fill.refine, (exact) => this.exactBuy(id, fillId, fill.tokens, exact));
      // (booked: a feed line that cannot be written must not undo it)
      this.quietly('the feed line of a buy', () => store.addEvent({
        userId: copy.userId, copyId: copy.id, kind: 'buy',
        message: `Bought ${fmtSol(fill.lamports)} of ${label} — they bought ${fmtSol(t.solLamports)}${copyMs !== null && !fill.simulated ? ` · sent ${copyMs} ms after their trade was seen` : ''}${fill.simulated ? ' (test)' : ''}`,
        mint: t.mint, signature: fill.simulated ? null : fill.signature,
      }));
    } catch (err) {
      // Nothing was bought (nothing sent, a test buy, or a real one that did not land): the position failed.
      this.quietly('a failed buy', () => store.updatePosition(id, { status: 'failed', closedAt: this.now() }));
      this.quietly('a feed line', () => store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label} failed: ${friendlyError(safeErrorMessage(err))}`, mint: t.mint }));
    } finally {
      // Whatever became of it (bought, failed after paying its fee, outcome unknown): the wallet is read again now,
      // in the background; the next buy uses the balance from before less this one's share until that read is in.
      if (release) this.balanceChanged(owner, release);
    }
  }

  // ── the clock ─────────────────────────────────────────────────────────
  async tick(): Promise<void> {
    if (this.stopped) return; // shutting down: overdue steps go out after the restart
    const now = this.now();
    for (const [key, r] of this.retries) {
      if (this.deps.store.position(r.positionId)?.status !== 'open') { this.retries.delete(key); continue; }
      if (r.nextAt <= now && !this.inFlight.has(key)) this.run(r.positionId, r.order);
    }
    for (const [key, f] of this.owedFails) if (this.deps.store.position(f.positionId)?.status !== 'open') this.owedFails.delete(key);
    const positions = this.deps.store.activePositions().filter((p) => p.status === 'open');
    for (const p of positions) if (p.tokensHeld <= 0n) this.closeIfEmpty(p.id);
    await Promise.all(positions.map((p) => this.tickOne(p)));
  }

  private readonly quoting = new Set<number>();

  /**
   * Orders due on the clock fire first, from what we already know; the price check runs after and can add a stop
   * loss or dead-coin order. A slow price check never delays a timed sell, and ticks may overlap safely (one
   * price check per position at a time).
   */
  private async tickOne(p: Position): Promise<void> {
    const now = this.now();
    this.fireDue(p, now);
    const needsPrice = p.sell.stopLoss.length > 0 || p.sell.deadCoin.enabled;
    const every = needsPrice ? this.deps.priceMs : Math.max(this.deps.priceMs, IDLE_PRICE_MS);
    if (this.quoting.has(p.id) || now - (this.lastQuoteAt.get(p.id) ?? 0) < every) return;
    this.lastQuoteAt.set(p.id, now);
    this.quoting.add(p.id);
    try {
      const value = await this.deps.executor.quoteSell(p.mint, p.tokensBought);
      // A price check that comes back after the stop starts nothing (fuzzer case 20: its dead-coin sale went out from
      // a stopped server, landed after the process had exited and was never booked). The rules are checked again
      // after the restart.
      if (this.stopped) return;
      this.quoteOkAt.set(p.id, this.now());
      const fresh = this.deps.store.position(p.id);
      if (!fresh || fresh.status !== 'open') return;
      let view = fresh;
      if (value !== fresh.refValueLamports) {
        this.deps.store.updatePosition(p.id, { refValueLamports: value, lastChangeAt: now });
        view = { ...fresh, refValueLamports: value, lastChangeAt: now };
      }
      this.fireDue(view, now);
    } catch (err) {
      log.debug('quote failed', { position: p.id, error: safeErrorMessage(err) });
    } finally {
      this.quoting.delete(p.id);
    }
  }

  private fireDue(view: Position, now: number): void {
    // (a position waiting for a sell from before a restart: what comes due meanwhile is held and goes once that is
    // settled, as it would wait behind a sell of ours that is out: see holdForOrphan; a timed step simply stays due)
    if (this.stopped) return;
    for (const order of dueSells(view, now)) {
      if (order.reason === 'dead_coin' && now - (this.quoteOkAt.get(view.id) ?? 0) > QUOTE_FRESH_MS) continue;
      if (this.retries.has(this.orderKey(view.id, order))) continue; // waiting for its retry time
      if (order.basis === 'bag') this.runBagStep(view.id, order);
      else this.run(view.id, order);
    }
  }

  // ── timed exit of the original bag: every step on its own clock ───────
  private readonly loose = new Set<Promise<void>>();
  /** Tokens of a position that a sell in flight is about to sell (so overlapping steps never sell them twice). */
  private readonly reserved = new Map<number, Map<string, bigint>>();

  /**
   * A sell whose outcome nobody could tell us (the RPC did not answer): it may have landed. Selling again could sell
   * the same coins twice and a sale that landed would never be booked, so it is settled from its own transaction
   * first: landed → its exact numbers; failed, or still not found once it can no longer land → a normal failure
   * (retried); no answer → asked again, more slowly, until there is one (its coins stay reserved meanwhile).
   */
  private async settleUnknownSell(signature: string | null, owner: string, mint: string, sentAt: number, error: string, signed?: SignedInfo): Promise<Awaited<ReturnType<Executor['sell']>>> {
    const { executor } = this.deps;
    if (!signature || !executor.settleSell) return { ok: false, error };
    const longest = this.deps.settleRetryMs ?? 15_000;
    for (let i = 0; ; i++) {
      try {
        const r = await executor.settleSell(signature, owner, mint);
        // (booked with the platform fee it carried, as one answered at once is)
        if (r.state === 'landed') return { ok: true, signature, tokens: r.tokens, lamports: r.lamports, simulated: false, confirmedAt: this.now(), note: 'outcome read from its own transaction', ...carried(signed) };
        if (r.state === 'failed') return { ok: false, error: `${error} — it did not land` };
        if (this.now() - sentAt > 120_000) return { ok: false, error: `${error} — it never landed` };
      } catch {
        // still no answer from the RPC
      }
      if (this.stopped) return { ok: false, error, uncertain: true };
      await new Promise((r) => setTimeout(r, Math.min(longest, 1_000 * 2 ** i)));
    }
  }

  /** True while a sell of this user's coin is out (sent, its outcome not known yet), whatever its position. */
  private sellOutFor(userId: number, mint: string): boolean {
    for (const [positionId, sells] of this.reserved) {
      if (!sells.size) continue;
      const p = this.deps.store.position(positionId);
      if (p && p.userId === userId && p.mint === mint) return true;
    }
    return false;
  }

  private reservedExcept(positionId: number, key: string): bigint {
    let sum = 0n;
    for (const [k, v] of this.reserved.get(positionId) ?? []) if (k !== key) sum += v;
    return sum;
  }

  /** Sent at its own time whether or not earlier steps are confirmed; never queued behind them. */
  private runBagStep(positionId: number, order: SellOrder): void {
    const key = this.orderKey(positionId, order);
    // (stopped: the step is overdue after the restart and goes then; waiting for a sell from before a restart: once it
    // is settled)
    if (this.inFlight.has(key) || this.stopped || this.waitsForOrphan(positionId)) return;
    this.inFlight.add(key);
    const job: Promise<void> = this.bagStep(positionId, order, key)
      .catch((err) => log.warn('timed step failed', { position: positionId, error: safeErrorMessage(err) }))
      .finally(() => { this.inFlight.delete(key); this.loose.delete(job); this.closeIfEmpty(positionId); });
    this.loose.add(job);
  }

  private async bagStep(positionId: number, order: SellOrder, key: string): Promise<void> {
    const { store, executor } = this.deps;
    const stage = order.stage ?? 0;
    const pauses = this.deps.fastRetryMs ?? FAST_RETRY_MS;
    const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    let failures = 0;
    for (;;) {
      // Shutting down, or waiting for a sell from before a restart: the step stays due and goes out after.
      if (this.stopped || this.waitsForOrphan(positionId)) return;
      const p = store.position(positionId);
      if (!p || p.status !== 'open' || p.firedTimed.includes(stage)) return;
      const label = `${shortMint(p.mint)} (${p.copyName})`;
      const wallet = this.deps.walletFor(p.userId);
      const live = p.mode === 'live';
      let error = '';
      let tokens = 0n;
      try {
        if (!wallet) throw new Error('no wallet');
        // The Live switch stops new real buys only: a position bought for real is always sold by its rules.
        if (live && !executor.isLive({ live: true, exit: true })) throw new Error('no connection to Solana: a live position cannot be sold right now');
        const owner = wallet.publicKey.toBase58();
        if (order.everything) {
          // The last step: whatever the wallet holds now (live), in-flight earlier steps included, as specified.
          // In test mode the books stand in for the wallet, minus what overlapping steps are already selling.
          tokens = live ? await this.walletTokens(owner, p.mint) : p.tokensHeld - this.reservedExcept(p.id, key);
          // The wallet read can take a moment (a "zero" is read again): if the position was closed meanwhile, what the
          // wallet holds now may be the next position's coins. Nothing is sold for this one then.
          const still = store.position(p.id);
          if (!still || still.status !== 'open') return;
          // Coins the wallet holds besides this position's (bought by hand, before the copy or meanwhile) are not the
          // copy's to sell: when the wallet holds clearly more than the books (over 2 %), only the books' coins are
          // sold. (Within 2 % it is the position's own remainder, a count that came in a little low: swept up.)
          if (live && tokens > still.tokensHeld + still.tokensHeld / 50n) tokens = still.tokensHeld;
          if (tokens <= 0n) {
            if (!live && this.reservedExcept(p.id, key) > 0n) { await pause(20); continue; } // overlapping steps finish first
            const fresh = store.position(p.id);
            if (fresh && fresh.status === 'open') store.updatePosition(p.id, { status: 'closed', tokensHeld: 0n, closedAt: this.now(), firedTimed: [...new Set([...fresh.firedTimed, stage])] });
            return;
          }
        } else {
          const want = portion(p.tokensBought, order.percent); // a share of the ORIGINAL bag
          const free = p.tokensHeld - this.reservedExcept(p.id, key);
          tokens = want < free ? want : free;
          if (tokens <= 0n) { store.updatePosition(p.id, { firedTimed: [...new Set([...p.firedTimed, stage])] }); return; }
        }
        // The server stopped while the wallet was read: nothing is sent (the step is overdue after the restart).
        if (this.stopped) return;
        const copy = store.copyIncludingDeleted(p.copyId);
        const sentAt = this.now();
        const mine = this.reserved.get(p.id) ?? new Map<string, bigint>();
        mine.set(key, tokens);
        this.reserved.set(p.id, mine);
        let fill: Awaited<ReturnType<Executor['sell']>>;
        let signature: string | null = null;
        let signed: SignedInfo | undefined;
        let partial = false;
        let outcome: 'booked' | 'failed' | 'unknown' = 'unknown';
        let booked: BagBooking | null = null;
        let unbooked: string | null = null;
        const asked = tokens;
        try {
          fill = await executor.sell({
            wallet, mint: p.mint, tokens, slippagePct: copy?.settings.slippagePct ?? 25,
            priorityFeeSol: copy?.settings.sellPriorityFeeSol ?? copy?.settings.priorityFeeSol ?? 0.0005,
            tipSol: copy?.settings.sellTipSol ?? copy?.settings.tipSol ?? 0, live, feeBps: this.deps.feeBpsFor?.(p.userId) ?? 0,
            exit: live, checkFirst: failures > 0, closeIfEmpty: !!order.everything, onSigned: (sig, info) => { signature = sig; signed = info; this.writeSellOut(p, order, asked, sig, sentAt, info); },
          });
          // Nobody could tell us whether it landed: settled from its own transaction first, its coins still reserved.
          if (!fill.ok && fill.uncertain) fill = await this.settleUnknownSell(signature, owner, p.mint, sentAt, fill.error, signed);
          if (fill.ok) {
            // Booked while its coins are still reserved (another sell's booking must not take them off meanwhile).
            // The wallet's balance after the last step tells whether the bag is really empty (a failed read keeps
            // our books). The last step is done only when the position is empty: it sold only part (the market
            // could not pay for all of it), or another step was out when it sold and has since failed or sold only
            // part of its share, and the last step sells what is left (at the slow pace when the market was short).
            const after = live && order.everything ? await executor.tokenBalance(owner, p.mint).catch(() => null) : null;
            partial = !!order.everything && (fill.marketShort ?? fill.tokens < tokens);
            const ok = fill;
            try {
              booked = store.atomic(() => this.settleSell(p.id, order, ok, after, !!order.everything, key));
              outcome = 'booked';
            } catch (err) {
              if (fill.simulated) throw err; // a test sell is not written down: tried again as a failure
              unbooked = safeErrorMessage(err);
            }
          } else if (!fill.uncertain) outcome = 'failed';
        } finally {
          mine.delete(key);
          if (!mine.size) this.reserved.delete(p.id);
          this.doneWithSellOut(signature, outcome);
        }
        // It sold, but its booking could not be written (an error of the database, undone whole): it is not a failure
        // and never goes out again. Its row in sells_out stays, and the settling pass books it from its own transaction
        // within seconds (the position waits for it meanwhile).
        if (unbooked !== null) {
          log.warn('a sale that landed could not be booked yet: it is booked from its own transaction', { position: p.id, signature, error: unbooked });
          if (signature && this.orphans.has(signature)) this.landedLeftovers.add(signature);
          return;
        }
        // Still unknown when the server stopped: written down for the next process, which settles it (and books it if
        // it landed); the step stays due until then.
        if (!fill.ok && fill.uncertain && this.stopped) return;
        if (fill.ok && booked) {
          const b = booked;
          const ok = fill;
          this.quietly('the feed line of a sale', () => this.afterBagSell(order, ok, b, sentAt, partial));
        }
        this.followUpExit(p.id);
        if (fill.ok) {
          if (!fill.simulated) this.balanceChanged(owner); // the wallet's SOL just changed: read again, in the background
          const now = order.everything ? store.position(p.id) : null;
          if (!now || now.status !== 'open' || now.tokensHeld <= 0n) return;
          await pause(partial ? this.deps.slowRetryMs ?? SLOW_RETRY_MS : pauses[0] ?? 0);
          failures = 0;
          continue;
        }
        error = fill.error;
      } catch (err) {
        error = safeErrorMessage(err);
      }
      // Failed: retry at once, then after short pauses. Later steps are untouched: they run on their own clocks. (What
      // is written about it may fail too, the database being what failed: it never ends the step's own pauses.)
      const why = order.everything ? 'final timed sell' : `timed sell of ${fmtPct(order.percent)} of the bag`;
      const line = (message: string) => this.quietly('a failure line', () => store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message, mint: p.mint }));
      if (failures === 0) line(`Sell of ${label} (${why}) failed: ${friendlyError(error)} — retrying`);
      if (failures >= pauses.length) {
        if (!order.everything) {
          this.quietly('a step given up', () => {
            const fresh = store.position(p.id);
            if (fresh) store.updatePosition(p.id, { firedTimed: [...new Set([...fresh.firedTimed, stage])] });
          });
          line(`Gave up on the ${why} of ${label} after ${failures + 1} failed tries: ${friendlyError(error)}. The last step sells what is left.`);
          return;
        }
        // The last step never gives up: the coins are still in the wallet and nobody may be watching. It keeps
        // trying at a slower pace until it sells, the position is closed another way (Sell now), or the server stops.
        const slow = this.deps.slowRetryMs ?? SLOW_RETRY_MS;
        if (failures === pauses.length) line(`The ${why} of ${label} has failed ${failures + 1} times (${friendlyError(error)}): still trying every ${Math.max(1, Math.round(slow / 1000))} s until it sells. Sell now works too.`);
        await pause(slow);
        failures++;
        continue;
      }
      await pause(pauses[failures]!);
      failures++;
    }
  }

  /** Books a finished sell of a timed step of the bag. Synchronous from the re-read on, so overlapping sells cannot
   *  corrupt the position. `keepOwed`: a sell of everything that left coins is not marked done (the step sells the
   *  rest). The same code books such a sell from before a restart (settleOrphans); its row in sells_out goes in the
   *  same step. Database writes only: it runs inside one transaction (store.atomic), and what must not happen unless
   *  that transaction is written (its exact SOL applied later, its feed line) is afterBagSell's, called after it. */
  private settleSell(positionId: number, order: SellOrder, fill: OkFill, walletAfter: bigint | null, keepOwed = false, key = ''): BagBooking | null {
    const { store } = this.deps;
    const p = store.position(positionId);
    if (!p) return null;
    if (!fill.simulated) store.deleteSellOut(fill.signature);
    const sold = fill.tokens > p.tokensHeld ? p.tokensHeld : fill.tokens;
    // A test fill for tokens the books no longer hold is not money: count only what was really still there.
    const lamports = fill.simulated && fill.tokens > 0n && sold < fill.tokens ? (fill.lamports * sold) / fill.tokens : fill.lamports;
    let left = p.tokensHeld - sold;
    // The wallet caps the books (coins sold elsewhere), counting what our other sells still have on their way: one
    // that has landed is gone from the wallet but not booked yet, and must not be taken off twice.
    if (walletAfter !== null) {
      const cap = walletAfter + this.reservedExcept(p.id, key);
      if (cap < left) left = cap;
    }
    const closed = left === 0n;
    store.updatePosition(p.id, {
      tokensHeld: left,
      proceedsLamports: p.proceedsLamports + lamports,
      ...(closed && p.status === 'open' ? { status: 'closed' as const, closedAt: this.now() } : {}),
      ...(keepOwed && !closed ? {} : this.markDone(p, order)),
    });
    if (sold === 0n && fill.simulated) return null; // nothing was left for this step in test mode: no fill, no feed line
    const fillId = store.insertFill({ positionId: p.id, userId: p.userId, side: 'sell', reason: order.reason, tokens: fill.tokens, lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n, exactPending: !!fill.refine && !fill.simulated });
    return { fillId, closed, lamports, p };
  }

  /** After a bag step's booking was written: its exact SOL (applied when it is read), and its line in the feed.
   *  `marketShort`: the market paid for only part of a sell of everything (the rest is sold later). */
  private afterBagSell(order: SellOrder, fill: OkFill, b: BagBooking, sentAt: number, marketShort: boolean): void {
    const { store } = this.deps;
    const p = b.p;
    this.refineLater(b.fillId, fill.refine, (exact) => this.exactSell(p.id, b.fillId, b.lamports, exact.lamports));
    this.soldSome(p.id);
    store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'sell', message: this.sellMessage(p, order, fill.tokens, b.lamports, sentAt, fill.simulated, b.closed, marketShort && !b.closed), mint: p.mint, signature: fill.simulated ? null : fill.signature });
  }

  /** Bookkeeping after a booking was written (a feed line, a balance read): an error there is logged, never taken for
   *  a failed sale (the sale is booked; a retry would sell it again). */
  private quietly(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.warn(`${what} could not be written`, { error: safeErrorMessage(err) });
    }
  }

  /** "Sold 40% of the bag of X (copy) for 0.4 SOL — +2.0s after buy · 412K tokens (test). Position closed." */
  private sellMessage(p: Position, order: SellOrder, tokens: bigint, lamports: bigint, sentAt: number, simulated: boolean, closed: boolean, partial = false): string {
    const label = `${shortMint(p.mint)} (${p.copyName})`;
    const what = order.everything ? 'the rest' : order.basis === 'bag' ? `${fmtPct(order.percent)} of the bag` : order.percent >= 100 ? 'all' : fmtPct(order.percent);
    const after = `+${((sentAt - p.openedAt) / 1000).toFixed(1)}s after buy`;
    const why = order.basis === 'bag' ? after : `${REASON_TEXT[order.reason](order, p)} · ${after}`;
    const rest = !partial ? '' : order.reason === 'manual'
      ? '. The market could pay for only part of it (the curve is short of SOL): Sell now again once it has filled up.'
      : '. The market could pay for only part of it (the curve is short of SOL): the rest is sold as soon as it can be.';
    return `Sold ${what} of ${label} for ${fmtSol(lamports)} — ${why} · ${fmtTokens(tokens, p.decimals)} tokens${simulated ? ' (test)' : ''}${closed ? '. Position closed.' : ''}${rest}`;
  }

  // ── selling ───────────────────────────────────────────────────────────
  private orderKey(positionId: number, order: SellOrder): string {
    return `${positionId}:${order.reason}:${order.stage ?? ''}:${order.tag ?? ''}`;
  }

  private run(positionId: number, order: SellOrder): void {
    if (this.stopped) { this.quietly('a sell owed after the restart', () => this.oweAfterRestart(positionId, order)); return; }
    if (this.waitsForOrphan(positionId)) { this.holdForOrphan(positionId, order); return; }
    const key = this.orderKey(positionId, order);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    // A stop loss level or the dead-coin rule that came due is written down as it goes: it is sold even if the price
    // has come back by the time it can be (its sell failed and waits for its retry, or went out and did not land, and a
    // crash or a restart came first: it was judged again at the price stored by then, and dropped). Done (sold, given
    // up, nothing left for it) takes it off.
    if ((order.reason === 'stop_loss' || order.reason === 'dead_coin') && !order.rest) this.quietly('a sell owed until it is done', () => this.oweAfterRestart(positionId, order));
    void this.enqueue(positionId, () => this.sell(positionId, order)).finally(() => { this.inFlight.delete(key); this.closeIfEmpty(positionId); });
  }

  /** True while anything of this position is queued or running (its buy, a sell, a timed step) or a sell of it is out. */
  private busy(positionId: number): boolean {
    if (this.queues.has(positionId) || this.reserved.get(positionId)?.size) return true;
    const prefix = `${positionId}:`;
    for (const key of this.inFlight) if (key.startsWith(prefix)) return true;
    return false;
  }

  /**
   * An open position whose books hold nothing, with nothing of it under way, is closed. Nothing else would close it:
   * the rules, their sells, the safety pass and Sell now all skip a position that holds nothing, so it stayed open
   * for good and its coin could never be copied again (fuzzer case 18: the exact coin count of a buy booked with the
   * quote's count took the books to nothing while a sell of the rest was out, and that sell then failed). A retry or
   * an owed exit waiting for it is not "under way": they sell what the books hold, and the books hold nothing. If the
   * buy's exact count later shows more coins, exactBuy opens it again and sells them, as for any closed position.
   */
  private closeIfEmpty(positionId: number): void {
    const { store } = this.deps;
    const p = store.position(positionId);
    if (!p || p.status !== 'open' || p.tokensHeld > 0n || this.busy(positionId)) return;
    // (called when work of the position ends: a write that fails here, the database failing, is tried on the next call)
    try {
      store.updatePosition(p.id, { status: 'closed', tokensHeld: 0n, closedAt: this.now() });
    } catch (err) {
      log.warn('an empty position could not be closed yet', { position: p.id, error: safeErrorMessage(err) });
      return;
    }
    this.quietly('a feed line', () => store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${shortMint(p.mint)} (${p.copyName}): nothing of it is left to sell — closed`, mint: p.mint }));
  }

  /** `note`: what became of the press when it sold nothing itself (everything was already on its way, or sold). */
  async sellNow(userId: number, positionId: number): Promise<{ ok: boolean; error?: string; note?: string }> {
    const { store } = this.deps;
    const p = store.position(positionId);
    if (!p || p.userId !== userId) return { ok: false, error: 'no open position with that id' };
    // Closed a moment before (the page had not caught up yet): not an error, the press found nothing left.
    if (p.status === 'closed') return { ok: true, note: CLOSED_JUST_BEFORE };
    if (p.status !== 'open') return { ok: false, error: 'no open position with that id' };
    if (this.stopped) return this.notSent(p, { reason: 'manual', percent: 100 });
    // A click deserves more than one try: when the first fails (often because one of our own timed sells landed in
    // between and the amount was stale) it is tried again at once, and once more a moment later. Only the last
    // failure is shown.
    let result: { ok: boolean; error?: string; note?: string } = { ok: false, error: 'not tried' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 2) await new Promise((r) => setTimeout(r, this.deps.zeroRecheckMs ?? 300));
      result = await this.enqueue(positionId, () => this.sell(positionId, { reason: 'manual', percent: 100 }, attempt < 2, attempt > 0));
      if (result.ok || result.error === STOPPING_ANSWER) break;
      if (result.error === 'position is not open') {
        // It waited behind another sell of ours that sold everything (their exit, a stop loss): nothing was left. The
        // press is not an error (it answered "position is not open", in red, as the coin crashed).
        const now = store.position(positionId);
        if (!now || now.status === 'closed' || now.tokensHeld <= 0n) return { ok: true, note: CLOSED_JUST_BEFORE };
        break;
      }
    }
    return result;
  }

  /**
   * A sell the stopped engine does not send (the server is shutting down: see stop()). What would not come back by
   * itself is written down (oweAfterRestart); a press of Sell now gets its answer, in the feed too.
   */
  private notSent(p: Position, order: SellOrder, sentUnknown = false): { ok: false; error: string } {
    this.quietly('a sell owed after the restart', () => this.oweAfterRestart(p.id, order));
    if (order.reason === 'manual' && !order.rest) {
      const label = `${shortMint(p.mint)} (${p.copyName})`;
      const message = sentUnknown
        ? `Sell of ${label} (you pressed Sell now): sent, but the server is restarting before its outcome is known. It is read from its own transaction as soon as the server is back, and sold then if it did not land.`
        : `Sell of ${label} (you pressed Sell now) did not go out: the server is restarting. It is sold as soon as the server is back (a few seconds).`;
      this.quietly('a feed line', () => this.deps.store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message, mint: p.mint }));
      return { ok: false, error: STOPPING_ANSWER };
    }
    return { ok: false, error: STOPPING };
  }

  /**
   * The wallet's balance of a coin, for deciding that a position is empty. A read of zero right after our own buy
   * can come from an RPC node that is one block behind: it is believed only when two more reads, a moment apart,
   * say zero too. (A failed read throws, as before: unknown is never zero.)
   */
  private async walletTokens(owner: string, mint: string): Promise<bigint> {
    let balance = await this.deps.executor.tokenBalance(owner, mint);
    for (let again = 0; balance === 0n && again < 2; again++) {
      await new Promise((r) => setTimeout(r, this.deps.zeroRecheckMs ?? 300));
      balance = await this.deps.executor.tokenBalance(owner, mint);
    }
    return balance;
  }

  private markDone(p: Position, order: SellOrder): Partial<Pick<Position, 'firedTimed' | 'firedStop' | 'deadFired' | 'owedSells'>> {
    const done: Partial<Pick<Position, 'firedTimed' | 'firedStop' | 'deadFired' | 'owedSells'>> = {};
    if (order.reason === 'timed' && order.stage !== undefined) done.firedTimed = [...new Set([...p.firedTimed, order.stage])];
    else if (order.reason === 'stop_loss' && order.stage !== undefined) done.firedStop = [...new Set([...p.firedStop, order.stage])];
    else if (order.reason === 'dead_coin') done.deadFired = true;
    // Done (sold, nothing left for it, or given up): no longer owed. (Read fresh: another may have been written down
    // since this sell began.)
    if (order.reason === 'mirror' && order.tag) this.owedInMemory.delete(`${p.id}:${order.tag}`);
    if (owedEntry(order)) {
      const owed = this.deps.store.position(p.id)?.owedSells ?? p.owedSells;
      const left = owed.filter((o) => !sameOwed(o, order));
      if (left.length !== owed.length) done.owedSells = left;
    }
    return done;
  }

  /**
   * A partial sell written down until it is done, so a restart or a crash before then cannot forget it: their partial
   * sell ("same share"), the moment it is heard (fuzzer case 19: one waiting for its retry was lost, its retry living
   * in memory only); and a stop loss level that came due but cannot go out now (the server is stopping, or the
   * position waits for a sell from before a restart): sold after the restart even if the price has come back by then,
   * as it would have been sold behind a sell of ours that was out. restore() runs it once; not while a sell of the
   * position from before the restart is still unsettled (one that went out and landed is done when it is booked).
   */
  private oweSell(p: Position, order: SellOrder): void {
    const entry = owedEntry(order);
    if (!entry) return;
    const now = this.deps.store.position(p.id)?.owedSells ?? p.owedSells;
    if (now.some((o) => sameOwed(o, order))) return;
    const owed = [...now, entry];
    this.deps.store.updatePosition(p.id, { owedSells: owed });
    p.owedSells = owed;
  }

  private async sell(positionId: number, order: SellOrder, quiet = false, retry = false): Promise<{ ok: boolean; error?: string; note?: string }> {
    const { store, executor } = this.deps;
    const p = store.position(positionId);
    if (p && p.status === 'opening' && order.reason === 'mirror') {
      // Our buy went out and its outcome is not known yet: their sell is kept and runs once the buy is settled (it
      // used to be dropped, and nothing sold the coins once the position opened).
      const kept = this.pendingMirror.get(p.id) ?? [];
      kept.push(order);
      this.pendingMirror.set(p.id, kept);
      // Their full exit is also written down: a restart before the buy is settled must not forget it.
      if (order.percent >= 100) this.quietly('their exit owed', () => this.writeExitOwed(p, order));
      if (kept.length === 1) this.quietly('a feed line', () => store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${shortMint(p.mint)} (${p.copyName}): they sold while our buy's outcome is not known yet — sold as soon as the buy is settled`, mint: p.mint }));
      return { ok: false, error: 'waiting for the buy to be settled' };
    }
    if (!p || p.status !== 'open' || p.tokensHeld <= 0n) return { ok: false, error: 'position is not open' };
    // Their partial sell is written down when it is heard and taken off when it is done: one no longer written down
    // was sold (perhaps booked from its own transaction after an error or a restart) or given up, and never sells
    // twice (a retry of one whose booking had failed sold another share once the safety pass had booked it).
    if (order.reason === 'mirror' && order.percent < 100 && order.tag && !p.owedSells.some((o) => o.reason === 'mirror' && o.tag === order.tag) && !this.owedInMemory.has(`${p.id}:${order.tag}`)) {
      this.retries.delete(this.orderKey(p.id, order));
      return { ok: true };
    }
    // Queued before the server began to shut down: not sent now (what does not come back by itself is owed).
    if (this.stopped) return this.notSent(p, order);
    // A sell of this position from before a restart is not settled yet: a rule waits for it (Sell now, the user's own
    // press, goes: it takes only what is free).
    if (order.reason !== 'manual' && this.waitsForOrphan(p.id)) {
      this.holdForOrphan(p.id, order);
      return { ok: false, error: 'waiting for a sell sent before the restart to be settled' };
    }
    const label = `${shortMint(p.mint)} (${p.copyName})`;
    const wallet = this.deps.walletFor(p.userId);
    if (!wallet) {
      this.quietly('a feed line', () => store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Cannot sell ${label}: no wallet`, mint: p.mint }));
      return { ok: false, error: 'no wallet' };
    }
    const owner = wallet.publicKey.toBase58();
    // A stage that already fired (e.g. finished while this order waited in the queue) never sells twice.
    if (!order.rest && ((order.reason === 'timed' && order.stage !== undefined && p.firedTimed.includes(order.stage))
      || (order.reason === 'stop_loss' && order.stage !== undefined && p.firedStop.includes(order.stage))
      || (order.reason === 'dead_coin' && p.deadFired))) {
      this.retries.delete(this.orderKey(p.id, order)); // (a retry of it would otherwise be run again on every tick)
      const done = this.markDone(p, order); // (and no longer owed, if it was written down)
      if (done.owedSells) this.quietly('a sell no longer owed', () => store.updatePosition(p.id, { owedSells: done.owedSells! }));
      return { ok: true };
    }
    const live = p.mode === 'live';
    // The Live switch stops new real buys only: a position bought for real is always sold by its rules.
    if (live && !executor.isLive({ live: true, exit: true })) {
      return this.sellFailed(p, order, label, 'no connection to Solana: a live position cannot be sold right now', quiet);
    }
    try {
      // Live: this position's own tokens, never more than the wallet really holds (other copies or coins the user
      // holds by hand in the same wallet are not touched).
      const onChain = live ? await this.walletTokens(owner, p.mint) : p.tokensHeld;
      // The books as they are after the wallet read (a sell may have been booked meanwhile).
      const books = store.position(p.id) ?? p;
      if (books.status !== 'open' || books.tokensHeld <= 0n) return { ok: true };
      // Tokens our other sells are selling right now are already on their way: this sell takes its share of the
      // position's own coins less those (asking for them too would fail on chain, or make that sell fail). The wallet
      // only caps it (coins sold elsewhere): a sell of ours that has landed but is not confirmed yet is gone from the
      // wallet AND still counted as on its way, and must not be taken off twice (their exit sold 20 % instead of the
      // 60 % left, and the position then closed with 40 % in the wallet).
      const inFlight = this.reservedExcept(p.id, '');
      if (onChain <= 0n && inFlight === 0n) {
        store.updatePosition(p.id, { status: 'closed', tokensHeld: 0n, closedAt: this.now(), ...this.markDone(books, order) });
        store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${label}: the wallet holds none of it any more (sold elsewhere?) — closed`, mint: p.mint });
        return { ok: true };
      }
      const own = books.tokensHeld > inFlight ? books.tokensHeld - inFlight : 0n;
      const free = onChain < own ? onChain : own;
      const tokens = portion(free, order.percent);
      if (tokens <= 0n) {
        // Everything is on its way in our other sells. A full exit stays owed: whatever they do not sell (a step
        // that fails for good, a market that pays for only part) is sold after them (it was disarmed, having sold
        // nothing).
        if (order.percent >= 100 && inFlight > 0n) this.oweExit(p.id, order);
        this.retries.delete(this.orderKey(p.id, order));
        store.updatePosition(p.id, this.markDone(books, order));
        // Sell now: the user is told what happens to their press (it used to answer "Sold" with nothing sold).
        if (order.reason === 'manual' && !order.rest && inFlight > 0n) return this.alreadyOnItsWay(books);
        return { ok: true };
      }
      // The server stopped while the wallet was read: nothing is sent.
      if (this.stopped) return this.notSent(books, order);
      const copy = store.copyIncludingDeleted(p.copyId);
      const slippagePct = copy?.settings.slippagePct ?? 25;
      // (copies saved before sell fees existed fall back to their buy fees)
      const priorityFeeSol = copy?.settings.sellPriorityFeeSol ?? copy?.settings.priorityFeeSol ?? 0.0005;
      const tipSol = copy?.settings.sellTipSol ?? copy?.settings.tipSol ?? 0;
      const sentAt = this.now();
      const key = this.orderKey(p.id, order);
      // A retry, the rest of a full exit (it follows a sell that already went out), or the safety net's exit (their exit
      // was missed or failed), is simulated first: one that cannot work then costs nothing.
      const checkFirst = retry || !!order.rest || order.tag === 'reconcile' || (this.retries.get(key)?.tries ?? 0) > 0;
      // While this sell is out, its tokens are reserved: a timed step that comes due meanwhile does not ask for them.
      const mine = this.reserved.get(p.id) ?? new Map<string, bigint>();
      mine.set(key, tokens);
      this.reserved.set(p.id, mine);
      let fill: Awaited<ReturnType<Executor['sell']>>;
      let signature: string | null = null;
      let signed: SignedInfo | undefined;
      let booking: Booking | null = null;
      let unbooked: string | null = null;
      let outcome: 'booked' | 'failed' | 'unknown' = 'unknown';
      try {
        fill = await executor.sell({ wallet, mint: p.mint, tokens, slippagePct, priorityFeeSol, tipSol, live: p.mode === 'live', feeBps: this.deps.feeBpsFor?.(p.userId) ?? 0, exit: live, checkFirst, closeIfEmpty: order.percent >= 100 && inFlight === 0n, onSigned: (sig, info) => { signature = sig; signed = info; this.writeSellOut(p, order, tokens, sig, sentAt, info); } });
        // Nobody could tell us whether it landed: settled from its own transaction first, its coins still reserved.
        if (!fill.ok && fill.uncertain) fill = await this.settleUnknownSell(signature, owner, p.mint, sentAt, fill.error, signed);
        if (fill.ok) {
          // Booked while its coins are still reserved: the wallet is read first and the position after it, and from
          // that re-read on everything is synchronous. A sell booked while the wallet was being read is never
          // overwritten (its SOL used to vanish from the profit), and this sell's coins, gone from the wallet but not
          // booked yet, are not taken off the books by another sell's booking in between.
          const after = live ? await executor.tokenBalance(owner, p.mint).catch(() => null) : null;
          const ok = fill;
          try {
            booking = store.atomic(() => this.bookSell(p, order, key, tokens, ok, after));
            outcome = 'booked';
          } catch (err) {
            if (fill.simulated) throw err; // a test sell is not written down: tried again as a failure
            unbooked = safeErrorMessage(err);
          }
        } else if (!fill.uncertain) outcome = 'failed';
      } finally {
        mine.delete(key);
        if (!mine.size) this.reserved.delete(p.id);
        this.doneWithSellOut(signature, outcome);
      }
      // It sold, but its booking could not be written (an error of the database, undone whole): not a failure, and it
      // never goes out again (no retry). Its row in sells_out stays, and the settling pass books it from its own
      // transaction within seconds; its coins stay reserved meanwhile. Sell now is told it sold (it was tried again,
      // and told "not sold yet").
      if (unbooked !== null) {
        log.warn('a sale that landed could not be booked yet: it is booked from its own transaction', { position: p.id, signature, error: unbooked });
        if (signature && this.orphans.has(signature)) this.landedLeftovers.add(signature);
        return order.reason === 'manual' && !order.rest ? { ok: true, note: SOLD_BOOKED_SOON } : { ok: true };
      }
      if (!fill.ok) {
        // Still unknown when the server stopped: it is written down (sells_out) and the next process settles it from
        // its own transaction, and books it if it landed. Not a failure (it may well have landed): no retry, no
        // failure line; whatever would not come back by itself stays owed (oweAfterRestart).
        if (fill.uncertain && this.stopped) return this.notSent(books, order, true);
        const failed = this.sellFailed(p, order, label, fill.error, quiet);
        this.followUpExit(p.id);
        return failed;
      }
      if (booking) {
        const b = booking;
        const ok = fill;
        this.quietly('the feed line of a sale', () => this.afterSell(p, order, ok, b, sentAt, owner));
      }
      return { ok: true };
    } catch (err) {
      return this.sellFailed(p, order, label, safeErrorMessage(err), quiet);
    }
  }

  /** Sell now finds every coin of the position already in sells of ours on their way: said in the feed and in the
   *  answer. Whatever those do not sell is sold right after them (the press is owed: oweExit). */
  private alreadyOnItsWay(p: Position): { ok: true; note: string } {
    const leftover = [...this.orphans.values()].filter((o) => o.positionId === p.id);
    const note = leftover.some((o) => !this.ownLeftovers.has(o.signature))
      ? 'all of it is in a sell sent just before the server restarted, whose outcome is being read: if it did not go through, the coins are sold right after (within about a minute)'
      : leftover.length && leftover.every((o) => this.landedLeftovers.has(o.signature))
        ? 'all of it was just sold by another sell of ours: it shows within a few seconds'
        : leftover.length
          ? 'all of it is in a sell of ours whose outcome is being read from the chain: if it did not go through, the coins are sold right after (within about a minute)'
          : 'all of it is already being sold by another sell of ours on its way: whatever that one does not sell is sold right after it';
    this.quietly('a feed line', () => this.deps.store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `Sell of ${shortMint(p.mint)} (${p.copyName}) (you pressed Sell now): ${note}.`, mint: p.mint }));
    return { ok: true, note: `${note[0]!.toUpperCase()}${note.slice(1)}.` };
  }

  /**
   * Books a sell of the position's queue (their sell, a rule of what is left, a stop loss, dead coin, Sell now, the rest
   * of a full exit). Synchronous, while its coins are still reserved under `key`, after the wallet was read
   * (`walletAfter`, null when it could not be read). The same code books a sell from before a restart that is settled
   * from its own transaction (settleOrphans), so the two can never drift apart. The sell's row in sells_out goes in
   * the same step.
   */
  private bookSell(p0: Position, order: SellOrder, key: string, asked: bigint, fill: OkFill, walletAfter: bigint | null): Booking {
    const { store } = this.deps;
    const cur = store.position(p0.id) ?? p0;
    let left = cur.tokensHeld - fill.tokens;
    if (walletAfter !== null) {
      // If the wallet holds less than our books say (sold elsewhere), believe the wallet, counting what our other
      // sells still have on their way (landed or not, they are booked when they confirm). A failed read keeps our
      // own figure: an RPC hiccup must not close a position.
      const cap = walletAfter + this.reservedExcept(cur.id, key);
      if (cap < left) left = cap;
    }
    if (left < 0n) left = 0n;
    const closed = left === 0n;
    // A sell of everything that the market could pay only part of (a curve short of SOL): the rest is sold on a later
    // try at the slow pace (the curve needs buyers to fill up again); the order is not done until then. Sell now says
    // so instead: the user decides when to press it again. The executor says whether the market was short; a sell that
    // took fewer coins for another reason (the wallet held fewer when it was built) is done, and what is left is the
    // rest of a full exit, sold right after (it used to be called the market's doing, and wait for the slow pace).
    const partial = order.percent >= 100 && !closed && (fill.marketShort ?? fill.tokens < asked);
    store.updatePosition(cur.id, {
      tokensHeld: left,
      proceedsLamports: cur.proceedsLamports + fill.lamports,
      ...(closed && cur.status === 'open' ? { status: 'closed' as const, closedAt: this.now() } : {}),
      ...(partial ? {} : this.markDone(cur, order)),
    });
    const retryKey = this.orderKey(cur.id, order);
    this.retries.delete(retryKey);
    if (partial && order.reason !== 'manual') this.retries.set(retryKey, { positionId: cur.id, order, tries: 1, nextAt: this.now() + (this.deps.slowRetryMs ?? SLOW_RETRY_MS) });
    // A full exit that left coins (to our other sells on their way, or to one between its retries that may yet fail
    // for good): once nothing else is out, whatever is still held is sold too.
    if (!closed && !partial && order.percent >= 100) this.oweExit(cur.id, order);
    const fillId = store.insertFill({ positionId: cur.id, userId: cur.userId, side: 'sell', reason: order.reason, tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n, exactPending: !!fill.refine && !fill.simulated });
    if (!fill.simulated) store.deleteSellOut(fill.signature);
    return { closed, partial, fillId };
  }

  /** After a sell of the queue was booked and its coins released: the wallet's SOL, its exact SOL, its line in the
   *  feed, and the rest of a full exit that is owed. */
  private afterSell(p: Position, order: SellOrder, fill: OkFill, b: Booking, sentAt: number, owner: string): void {
    try {
      if (!fill.simulated) this.balanceChanged(owner); // the wallet's SOL just changed: read again, in the background
      const booked = fill.lamports;
      this.refineLater(b.fillId, fill.refine, (exact) => this.exactSell(p.id, b.fillId, booked, exact.lamports));
      this.soldSome(p.id);
      this.deps.store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'sell', message: this.sellMessage(p, order, fill.tokens, fill.lamports, sentAt, fill.simulated, b.closed, b.partial), mint: p.mint, signature: fill.simulated ? null : fill.signature });
    } finally {
      this.followUpExit(p.id); // (even if the feed line could not be written)
    }
  }

  /** Something of this position sold: a sell of it that fails from now on says so again. */
  private soldSome(positionId: number): void {
    for (const [key, f] of this.owedFails) if (f.positionId === positionId) this.owedFails.delete(key);
  }

  /**
   * A sell that failed: its retry is set in memory first, then what is written down about it (the database may be the
   * very thing that fails: a write that fails here never leaves the order unscheduled, sent again on every tick, nor
   * escapes as an error of its own).
   */
  private sellFailed(p: Position, order: SellOrder, label: string, rawError: string, quiet = false): { ok: boolean; error: string } {
    const { store } = this.deps;
    const error = friendlyError(rawError);
    const why = REASON_TEXT[order.reason](order, p);
    const line = (message: string) => this.quietly('a failure line', () => store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message, mint: p.mint }));
    if (order.reason === 'manual') {
      // Pressed by the user: every press gets its answer. The rest of a Sell now that is owed (run again by the
      // settling pass every 30 s until it sells) says so once, not every 30 s (it filled the feed on a coin that
      // cannot be sold).
      if (order.rest) {
        // (one count per position: its first try, the rest of the coins beyond a quote and the safety pass's re-runs
        // carry other tags, but they are one sell, and said so twice)
        const key = `${p.id}:manual:rest`;
        const n = (this.owedFails.get(key)?.n ?? 0) + 1;
        this.owedFails.set(key, { positionId: p.id, n });
        if (n === 1 && !quiet) line(`Sell of ${label} (${why}) failed: ${error} — tried again every 30 s until it sells`);
        return { ok: false, error };
      }
      if (!quiet) line(`Sell of ${label} (${why}) failed: ${error}`);
      return { ok: false, error };
    }
    const key = this.orderKey(p.id, order);
    const tries = (this.retries.get(key)?.tries ?? 0) + 1;
    // A sell of EVERYTHING never gives up: the coins are still in the wallet and nobody may be watching. A sell of a
    // part does, after its quick tries: the rules that come later sell what it left.
    const fullExit = order.percent >= 100;
    if (tries >= MAX_SELL_TRIES && !fullExit) {
      this.retries.delete(key);
      this.quietly('a sell given up', () => store.updatePosition(p.id, this.markDone(p, order)));
      line(`Gave up on the ${why} of ${label} after ${tries} failed tries: ${error}. Use Sell now.`);
    } else {
      const slow = this.deps.slowRetryMs ?? SLOW_RETRY_MS;
      const wait = RETRY_MS[tries - 1] ?? slow;
      this.retries.set(key, { positionId: p.id, order, tries, nextAt: this.now() + wait });
      // A full exit that keeps failing is also written down: a restart must not forget it (its retry is in memory).
      if (fullExit) this.quietly('a full exit owed', () => this.writeExitOwed(p, order));
      // One feed line per failing sell, not one per retry; one more when it turns into the slow, endless kind.
      if (tries === 1) line(`Sell of ${label} (${why}) failed: ${error} — retrying`);
      if (tries === MAX_SELL_TRIES) line(`The sell of ${label} (${why}) has failed ${tries} times (${error}): still trying every ${Math.max(1, Math.round(slow / 1000))} s until it sells. Sell now works too.`);
    }
    return { ok: false, error };
  }

  // ── exact figures ─────────────────────────────────────────────────────
  /** Fills whose exact figures this process is reading right now (the safety pass leaves them alone). */
  private readonly refining = new Map<number, Promise<void>>();

  /**
   * A trade booked from its quote: its exact figures are read from its own transaction a moment later and applied by
   * `apply`. The fill says it is an estimate until then, so a restart in between, or a read that fails every try,
   * leaves it to the safety pass (settleEstimates), never to the quote for good.
   */
  private refineLater<T>(fillId: number, refine: Promise<T | null> | undefined, apply: (exact: T) => void): void {
    if (!refine || !fillId) return;
    const job = refine
      .then((exact) => { if (exact) apply(exact); })
      .catch((err) => log.warn('the exact figures of a trade could not be applied yet: the safety pass reads them again', { fill: fillId, error: safeErrorMessage(err) }))
      .finally(() => this.refining.delete(fillId));
    this.refining.set(fillId, job);
  }

  /**
   * Our buy's exact SOL (and coins, when the quote's count stood in) applied to its fill and position. The coins held
   * are what the buy received less what this position has sold since: never the difference taken off a second time
   * (a sell's booking may already have matched the books to the wallet). A position that was closed on the quote's
   * count although the buy received more: it is opened again and the rest is sold too.
   */
  private exactBuy(positionId: number, fillId: number, bookedTokens: bigint, exact: { lamports: bigint; tokens?: bigint }): void {
    const { store } = this.deps;
    // Every write in one step (the fill, the cost, the coins, the opening again with its exit owed): an error leaves
    // none of them, and the fill still waits for its exact figures (the safety pass reads them again). A cost written
    // without its coins, or a position opened again with nothing owed, used to stay so for good.
    const after = store.atomic((): { open: true } | { reopened: Position; held: bigint; order: SellOrder } | null => {
      store.setFillExact(fillId, exact.lamports, exact.tokens);
      store.updatePosition(positionId, { costLamports: exact.lamports });
      if (exact.tokens === undefined || exact.tokens === bookedTokens) return null;
      const p = store.position(positionId);
      if (!p || (p.status !== 'open' && p.status !== 'closed')) return null;
      const sold = store.sellsOf(positionId);
      const held = exact.tokens > sold.tokens ? exact.tokens - sold.tokens : 0n;
      if (p.status === 'open') {
        store.updatePosition(positionId, { tokensBought: exact.tokens, tokensHeld: held });
        return { open: true };
      }
      if (held <= 0n) {
        store.updatePosition(positionId, { tokensBought: exact.tokens });
        return null;
      }
      // Written down as it opens again: no rule of the clock calls for these coins any more, so a first try that fails
      // is tried again by the settling pass every 30 s, and a crash or a restart before it has sold leaves it to the
      // next process (they stayed in the wallet for good).
      const order: SellOrder = { reason: sold.lastReason ?? 'manual', percent: 100, tag: ':exact', rest: true };
      const exitOwed = p.exitOwed ?? { reason: order.reason, tag: ':exact' };
      store.updatePosition(positionId, { tokensBought: exact.tokens, status: 'open', tokensHeld: held, closedAt: null, lastChangeAt: this.now(), exitOwed });
      return { reopened: p, held, order };
    });
    if (!after) return;
    // Nothing left: closed now, or by whatever of it is still under way once that is over.
    if ('open' in after) { this.closeIfEmpty(positionId); return; }
    const { reopened: p, held, order } = after;
    this.quietly('a feed line', () => store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `Our buy of ${shortMint(p.mint)} (${p.copyName}) received ${fmtTokens(held, p.decimals)} tokens more than its quote said (the exact count came in after the position was sold): they are sold too.`, mint: p.mint }));
    this.run(positionId, order);
  }

  /** A sell's exact SOL applied to its fill and to the position's proceeds (booked: what was booked from the quote), in
   *  one step: an error leaves both as they were (the fill alone took it, for good), and the safety pass reads it again. */
  private exactSell(positionId: number, fillId: number, booked: bigint, exact: bigint): void {
    const { store } = this.deps;
    store.atomic(() => {
      store.setFillExact(fillId, exact);
      const now = store.position(positionId);
      if (now) store.updatePosition(positionId, { proceedsLamports: now.proceedsLamports + (exact - booked) });
    });
  }

  /** Real trades still booked from their quote (a restart came before their exact figures, or every read failed):
   *  read from their own transactions. Tried for a day. */
  private async settleEstimates(): Promise<void> {
    const { store, executor } = this.deps;
    if (!executor.settleBuy || !executor.settleSell) return;
    for (const f of store.fillsAwaitingExact(Date.now() - 86_400_000)) {
      if (this.refining.has(f.id) || !f.signature) continue;
      const p = store.position(f.positionId);
      const wallet = this.deps.walletFor(f.userId);
      if (!p || !wallet) { store.setFillExact(f.id, null); continue; }
      const owner = wallet.publicKey.toBase58();
      let r: Awaited<ReturnType<NonNullable<Executor['settleSell']>>>;
      try {
        r = f.side === 'buy' ? await executor.settleBuy(f.signature, owner, p.mint) : await executor.settleSell(f.signature, owner, p.mint);
      } catch {
        continue; // not readable yet: the next pass
      }
      if (r.state === 'not_found') continue;
      if (r.state !== 'landed') { store.setFillExact(f.id, null); continue; } // nothing exact to take from it
      if (this.refining.has(f.id) || !store.fillsAwaitingExact(f.createdAt).some((x) => x.id === f.id)) continue; // applied meanwhile
      // (one that cannot be written now is read again on the next pass; the others of this pass go on)
      try {
        if (f.side === 'buy') this.exactBuy(p.id, f.id, f.tokens, { lamports: r.lamports, tokens: r.tokens });
        else this.exactSell(p.id, f.id, f.lamports, r.lamports);
      } catch (err) {
        log.warn('the exact figures of a trade could not be applied yet', { fill: f.id, error: safeErrorMessage(err) });
      }
    }
  }

  // ── sells written down before they go out ────────────────────────────
  /**
   * A sell of a position bought for real is written down the moment it is signed, before it goes out (sells_out), as a
   * buy's signature is (buy_sig): if this process never learns what became of it (a crash, a restart while its outcome
   * is unknown), the next one reads it from its own transaction (settleOrphans) instead of forgetting it: its SOL was
   * never booked, its step was asked again with an empty wallet, and it could land later on the next position's coins.
   */
  private writeSellOut(p: Position, order: SellOrder, tokens: bigint, signature: string, sentAt: number, info?: SignedInfo): void {
    if (p.mode !== 'live') return; // a test sell is never sent
    // (a write that fails throws: the executor then does not send it)
    this.deps.store.insertSellOut({
      signature, positionId: p.id, userId: p.userId, mint: p.mint, order, tokens, sentAt,
      ...(info ? { lastValid: info.lastValidBlockHeight, feeLamports: info.feeLamports } : {}),
      ...(info?.marketShort !== undefined ? { marketShort: info.marketShort } : {}),
    });
    this.sending.add(signature);
  }

  /** This process is done with one of its sells. Booked: its row went with the booking. Failed: it goes now. Outcome
   *  still unknown (the server stopped), or an error in between: it stays, and is settled like any other left behind
   *  (while the engine runs, at once: the position waits for it, it may have sold). */
  private doneWithSellOut(signature: string | null, outcome: 'booked' | 'failed' | 'unknown'): void {
    if (!signature) return;
    this.sending.delete(signature);
    if (outcome === 'failed') this.forgetRow(signature);
    if (outcome === 'unknown' && !this.stopped) {
      // (one of this process's own, not from before a restart: what the user is told about it says so)
      if (this.deps.store.hasSellOut(signature)) this.ownLeftovers.add(signature);
      this.adoptOrphans();
    }
  }

  /** True while a sell of this position written down by an earlier process is not settled yet (see `orphans`). */
  private waitsForOrphan(positionId: number): boolean {
    for (const o of this.orphans.values()) if (o.positionId === positionId) return true;
    return false;
  }

  /**
   * An order of a rule that comes while the position waits for a sell from before a restart: not sent now. A timed
   * step is still due afterwards (the clock fires it). Their sell, a stop loss level and the dead-coin rule are kept
   * and run once the position is settled, as they would wait behind a sell of ours that is out: a level that came due
   * is sold even if the price has come back by then (it used to be judged again at that later price, and dropped).
   * A full exit is also written down.
   */
  private holdForOrphan(positionId: number, order: SellOrder): void {
    if ((order.reason === 'mirror' || order.reason === 'stop_loss' || order.reason === 'dead_coin') && !order.rest) {
      const kept = this.pendingMirror.get(positionId) ?? [];
      if (!kept.some((o) => this.orderKey(positionId, o) === this.orderKey(positionId, order))) kept.push(order);
      this.pendingMirror.set(positionId, kept);
    }
    // (kept in memory above whatever the database does: a write that fails is logged, never thrown into the clock)
    this.quietly('a held sell owed', () => this.oweAfterRestart(positionId, order));
  }

  /** The row of a sell known not to land goes; one that cannot be deleted now (the database failing) is never taken
   *  for a sell on its way, and goes on a later pass (see failedRows). */
  private forgetRow(signature: string): void {
    try {
      this.deps.store.deleteSellOut(signature);
      this.failedRows.delete(signature);
    } catch (err) {
      this.failedRows.add(signature);
      log.warn('the row of a sell that did not land could not be deleted yet', { signature, error: safeErrorMessage(err) });
    }
  }

  /** Takes up the sells written down that no process is handling (see `orphans`). */
  private adoptOrphans(): void {
    for (const s of this.deps.store.sellsOut()) {
      if (this.failedRows.has(s.signature)) { this.forgetRow(s.signature); continue; }
      if (this.sending.has(s.signature) || this.orphans.has(s.signature)) continue;
      this.orphans.set(s.signature, s);
      const mine = this.reserved.get(s.positionId) ?? new Map<string, bigint>();
      mine.set(`out:${s.signature}`, s.tokens);
      this.reserved.set(s.positionId, mine);
    }
  }

  /** A sell from before a restart is settled: its coins are released, and once the position waits for none of them
   *  any more, what was held back goes (their sells kept meanwhile, the rest of a full exit; the clock does the rest). */
  private releaseOrphan(s: SellOut): void {
    if (!this.orphans.delete(s.signature)) return;
    this.ownLeftovers.delete(s.signature);
    this.landedLeftovers.delete(s.signature);
    const mine = this.reserved.get(s.positionId);
    mine?.delete(`out:${s.signature}`);
    if (mine && !mine.size) this.reserved.delete(s.positionId);
    if (this.waitsForOrphan(s.positionId)) return;
    this.firePending(s.positionId);
    this.followUpExit(s.positionId);
    // What is written down as owed goes now too, not on the next 30 s pass.
    const p = this.deps.store.position(s.positionId);
    if (p && !this.stopped) this.runOwed(p);
  }

  /**
   * Sells written down by an earlier process, settled from their own transactions: landed → booked by the same code
   * that books this process's own sells (the step is done, the books and the proceeds move, the position closes if it
   * is empty, the rest of a full exit stays owed); failed → dropped, and whatever its rule still calls for sells
   * again; not found → kept while it can still land, then dropped; no answer → asked again on the next pass.
   */
  private async settleOrphans(): Promise<void> {
    const { store, executor } = this.deps;
    for (const o of [...this.orphans.values()]) {
      if (this.stopped) return;
      if (this.settlingOrphans.has(o.signature) || !this.orphans.has(o.signature)) continue;
      // Its row is gone (it was booked or dropped): nothing more to learn about it.
      if (!store.hasSellOut(o.signature)) { this.releaseOrphan(o); continue; }
      const p = store.position(o.positionId);
      const wallet = p ? this.deps.walletFor(p.userId) : null;
      if (!p || !wallet || !executor.settleSell) { this.dropOrphan(o); continue; } // nothing can be learnt about it
      if (!executor.isLive({ live: true, exit: true })) continue; // no connection to read it now: a later pass
      const owner = wallet.publicKey.toBase58();
      this.settlingOrphans.add(o.signature);
      try {
        // The chain's tip is read BEFORE the sell's status: if the chain was past the last block it could land in then,
        // "not found" means it never can (any block that could hold it came before that read), provided the status came
        // from a node at least as far along (see neverLands). It is dropped then instead of three minutes after it was
        // sent: the position's rules and Sell now wait for it meanwhile.
        const tip = o.lastValid !== undefined ? await this.chainTip() : null;
        let r: Awaited<ReturnType<NonNullable<Executor['settleSell']>>>;
        try {
          r = await executor.settleSell(o.signature, owner, o.mint);
        } catch {
          continue; // the RPC did not answer: the next pass
        }
        if (this.stopped || !this.orphans.has(o.signature)) continue;
        if (r.state === 'landed') {
          // (an error while booking it is undone whole and leaves it for the next pass; the other sells of the pass
          // and the rest of restore() go on)
          await this.bookOrphan(o, owner, r).catch((err) => log.warn('a sale from before a restart could not be booked yet', { signature: o.signature, error: safeErrorMessage(err) }));
        } else if (r.state === 'failed' || (tip !== null && o.lastValid !== undefined && neverLands(o.lastValid, tip, r.slot)) || this.now() - o.sentAt > SELL_OUT_EXPIRES_MS) {
          this.dropOrphan(o, true);
        }
      } finally {
        this.settlingOrphans.delete(o.signature);
      }
    }
  }

  /** The chain's height now, with the slot it was read at when the executor tells it; null when it cannot be read. */
  private async chainTip(): Promise<{ height: number; slot?: number } | null> {
    const { executor } = this.deps;
    if (executor.chainTip) return executor.chainTip().catch(() => null);
    if (executor.blockHeight) return executor.blockHeight().then((height) => ({ height })).catch(() => null);
    return null;
  }

  /** A sell from before a restart that landed: booked as this process books its own (with the platform fee it
   *  carried, and whether the market paid for only part of it), its coins reserved until then. */
  private async bookOrphan(o: SellOut, owner: string, r: { tokens: bigint; lamports: bigint }): Promise<void> {
    const { store, executor } = this.deps;
    const key = `out:${o.signature}`;
    const fill: OkFill = { ok: true, signature: o.signature, tokens: r.tokens, lamports: r.lamports, simulated: false, confirmedAt: this.now(), note: 'settled from its own transaction after a restart', ...carried(o) };
    const bag = o.order.basis === 'bag';
    // The wallet after it, read where the normal path reads it (a sell of the queue, the last step of a ladder).
    const after = !bag || o.order.everything ? await executor.tokenBalance(owner, o.mint).catch(() => null) : null;
    if (this.stopped || !this.orphans.has(o.signature)) return;
    const p = store.position(o.positionId);
    if (!p) { this.dropOrphan(o); return; }
    try {
      if (bag) {
        const partial = !!o.order.everything && (fill.marketShort ?? r.tokens < o.tokens);
        const b = store.atomic(() => this.settleSell(p.id, o.order, fill, after, !!o.order.everything, key));
        this.balanceChanged(owner);
        if (b) this.quietly('the feed line of a sale', () => this.afterBagSell(o.order, fill, b, o.sentAt, partial));
      } else {
        const booking = store.atomic(() => this.bookSell(p, o.order, key, o.tokens, fill, after));
        this.quietly('the feed line of a sale', () => this.afterSell(p, o.order, fill, booking, o.sentAt, owner));
      }
    } finally {
      // Booked (its row went with the booking): released now, whatever happens after, so it is never booked again (an
      // error after the booking used to leave it here, and the next pass booked it a second time). Not booked (the
      // booking failed and was undone): it stays for the next pass. Released after its feed line: what was held back
      // for it goes now.
      if (!store.hasSellOut(o.signature)) {
        this.releaseOrphan(o);
        this.closeIfEmpty(p.id);
      }
    }
  }

  /** A sell from before a restart that did not land (or can no longer land): forgotten; its rule may sell again. */
  private dropOrphan(o: SellOut, didNotLand = false): void {
    const { store } = this.deps;
    const own = this.ownLeftovers.has(o.signature);
    this.forgetRow(o.signature);
    this.releaseOrphan(o);
    const p = store.position(o.positionId);
    if (p && didNotLand && o.order.reason === 'manual' && !o.order.rest && p.status === 'open' && !p.exitOwed) {
      const when = own ? 'its outcome could not be read when it was sent, and it' : 'it was sent just before the server restarted and';
      this.quietly('a feed line', () => store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${shortMint(p.mint)} (${p.copyName}) (you pressed Sell now) did not go through: ${when} did not land. Press Sell now again.`, mint: p.mint }));
    }
    this.closeIfEmpty(o.positionId);
  }

  // ── after a restart, and as a safety net ─────────────────────────────
  /**
   * Buys that were in flight when the server stopped. Test fills are dropped; a live one is settled by the wallet:
   * if it holds the coin, the position opens with those tokens (so its sell rules run), otherwise it failed.
   */
  restore(): Promise<void> {
    // One pass at a time: a second call while one runs (the 30 s pass while the start's pass still waits on a slow
    // RPC) is that same pass (two at once settled one buy twice: two buy fills, two "confirmed late" lines).
    if (this.restoring) return this.restoring;
    const pass: Promise<void> = this.restorePass().finally(() => { if (this.restoring === pass) this.restoring = null; });
    this.restoring = pass;
    return pass;
  }
  private restoring: Promise<void> | null = null;

  private async restorePass(): Promise<void> {
    const { store } = this.deps;
    if (this.stopped) return;
    // Sells written down that no process is handling (an earlier process crashed, or stopped while their outcome was
    // unknown): settled first, so what follows sees them booked or gone.
    this.adoptOrphans();
    await this.settleOrphans();
    await this.settleOpening();
    await this.settleEstimates().catch(() => undefined);
    for (const p of store.activePositions()) this.runOwed(p);
  }

  /** True while a sell left by an earlier process is not settled yet (its position waits for it): the server reads it
   *  again every few seconds (settleLeftovers), not only on the 30 s pass. */
  awaitingLeftovers(): boolean {
    return this.orphans.size > 0 || this.unbookedBuys.size > 0;
  }

  /** Reads again the sells left by an earlier process that are not settled yet, and books a buy of this one that landed
   *  but could not be booked (see awaitingLeftovers). */
  async settleLeftovers(): Promise<void> {
    if (this.stopped) return;
    // (a buy to book: the whole pass, which runs one at a time, so a buy is never booked twice by two passes at once)
    for (const id of this.unbookedBuys.keys()) if (this.deps.store.position(id)?.status !== 'opening') this.unbookedBuys.delete(id);
    if (this.unbookedBuys.size) { await this.restore(); return; }
    if (this.orphans.size) await this.settleOrphans();
  }

  /**
   * Full exits owed (written down when they were heard, failed, left coins, or came while the buy was unsettled) and
   * their partial sells not sold yet: after a restart nothing in memory remembers them. One that this process is
   * already retrying or waiting on is left to that. A partial sell runs with its own tag, so it is the same order
   * (done once it is booked); a full exit owed sells everything, theirs included. Run by restore(), and as soon as a
   * position stops waiting for a sell from before a restart.
   */
  private runOwed(p: Position): void {
    if (p.status !== 'open' || (!p.exitOwed && !p.owedSells.length) || this.queues.has(p.id) || this.exitOwed.has(p.id) || this.pendingMirror.has(p.id)) return;
    if ([...this.retries.values()].some((r) => r.positionId === p.id) || this.waitsForOrphan(p.id)) return;
    if (p.exitOwed) { this.run(p.id, { reason: p.exitOwed.reason, percent: 100, ...(p.exitOwed.stage !== undefined ? { stage: p.exitOwed.stage } : {}), tag: `${p.exitOwed.tag ?? ''}:owed`, rest: true }); return; }
    // (their partial sells in the order they were heard, then stop loss levels in the order the clock fires them)
    const level = (o: OwedSell) => (o.reason === 'stop_loss' ? p.sell.stopLoss[o.stage ?? 0]?.lossPct ?? 0 : -1);
    for (const o of [...p.owedSells].sort((a, b) => level(a) - level(b))) {
      this.run(p.id, { reason: o.reason, percent: o.percent, ...(o.stage !== undefined ? { stage: o.stage } : {}), ...(o.tag ? { tag: o.tag } : {}) });
    }
  }

  /** Buys that were in flight when the server stopped, or whose outcome was unknown: settled from their own transaction. */
  private async settleOpening(): Promise<void> {
    const { store, executor } = this.deps;
    for (const p of store.openingPositions()) {
      if (this.queues.has(p.id)) continue; // still running in this process
      const label = `${shortMint(p.mint)} (${p.copyName})`;
      const wallet = this.deps.walletFor(p.userId);
      // A buy's signature is written down before it is sent, and only when it is sent for real: one without it was
      // never sent (a test buy, or a crash before signing). It failed, and the wallet's own coins of that mint
      // (bought by hand, or by another tool) are never taken for it.
      // (a write that fails, the database failing, is tried again on the next pass; the other buys of this one go on)
      if (!p.buySig || !wallet) {
        this.pendingMirror.delete(p.id);
        this.quietly('a buy that was never sent', () => store.updatePosition(p.id, { status: 'failed', closedAt: this.now() }));
        continue;
      }
      // Signed means sent for real, whatever the row said when it was written (Live switched on meanwhile).
      if (p.mode !== 'live') this.quietly('a buy signed for real', () => store.updatePosition(p.id, { mode: 'live' }));
      if (!executor.isLive({ live: true, exit: true })) continue; // no connection to read it now: settled later
      try {
        if (executor.settleBuy) {
          // Its own transaction says what happened: exact coins and cost, or that it failed.
          const r = await executor.settleBuy(p.buySig, wallet.publicKey.toBase58(), p.mint);
          if (r.state === 'landed') {
            // (one of this process whose booking failed: from its own confirmation, so its timed sells keep their times)
            const ours = this.unbookedBuys.get(p.id);
            const now = ours ?? this.now();
            const sig = p.buySig;
            // (in one step, as a buy booked at once: an error leaves it "opening" for the next pass)
            store.atomic(() => {
              store.updatePosition(p.id, { status: 'open', tokensBought: r.tokens, tokensHeld: r.tokens, costLamports: r.lamports, refValueLamports: r.lamports, openedAt: now, lastChangeAt: now });
              store.insertFill({ positionId: p.id, userId: p.userId, side: 'buy', reason: 'copy', tokens: r.tokens, lamports: r.lamports, signature: sig, simulated: false, error: null, feeLamports: p.buyFeeLamports ?? 0n });
            });
            this.unbookedBuys.delete(p.id);
            const late = ours !== undefined ? 'written down a few seconds late (the server could not save it at once); its timed sells count from the buy' : 'confirmed late (its exit starts now)';
            this.quietly('the feed line of a buy', () => store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'buy', message: `Bought ${fmtSol(r.lamports)} of ${label} — ${late}`, mint: p.mint, signature: sig }));
            this.firePending(p.id);
          } else if (r.state === 'failed' || this.now() - p.openedAt > 90_000) {
            // Failed on chain, or not found long after its blockhash ran out: it never landed.
            this.unbookedBuys.delete(p.id);
            this.pendingMirror.delete(p.id);
            store.updatePosition(p.id, { status: 'failed', closedAt: this.now() });
            store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${label}: the buy whose outcome was unknown did not land — nothing bought`, mint: p.mint });
          }
          continue;
        }
        const held = await executor.tokenBalance(wallet.publicKey.toBase58(), p.mint);
        if (held > 0n) {
          const cost = BigInt(Math.round((store.copy(p.copyId)?.settings.buySol ?? 0) * 1e9));
          const now = this.now();
          store.updatePosition(p.id, { status: 'open', tokensBought: held, tokensHeld: held, costLamports: cost, refValueLamports: cost, openedAt: now, lastChangeAt: now });
          store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${label}: a buy interrupted by a restart did land — position recovered (cost estimated)`, mint: p.mint });
          this.firePending(p.id);
        } else {
          this.pendingMirror.delete(p.id);
          store.updatePosition(p.id, { status: 'failed', closedAt: this.now() });
        }
      } catch (err) {
        log.warn('could not settle an interrupted buy yet', { position: p.id, error: safeErrorMessage(err) });
      }
    }
  }

  /**
   * "Sell when they sell" safety net: if a followed wallet holds none of a coin we still hold (its sell was missed,
   * e.g. while the server was down, or it moved the coins away), sell everything.
   */
  async reconcile(): Promise<void> {
    const { store, executor } = this.deps;
    if (this.stopped) return;
    const open = store.activePositions().filter((p) => p.status === 'open' && p.sell.mirror.enabled);
    const byCoin = new Map<string, Position[]>();
    for (const p of open) byCoin.set(`${p.leader}:${p.mint}`, [...(byCoin.get(`${p.leader}:${p.mint}`) ?? []), p]);
    for (const [, group] of byCoin) {
      const first = group[0]!;
      let leaderHolds: bigint;
      try {
        leaderHolds = await executor.tokenBalance(first.leader, first.mint);
      } catch {
        continue; // unknown is not zero
      }
      if (leaderHolds > 0n) continue;
      for (const p of group) {
        if (this.now() - p.openedAt < 30_000) continue; // their balance may lag our own buy's view
        if (this.waitsForOrphan(p.id)) continue; // a sell of it from before a restart is settled first
        this.run(p.id, { reason: 'mirror', percent: 100, tag: 'reconcile' });
      }
    }
  }

  /** A full exit is owed to this position: remembered in memory (to run when nothing else is out) and in the database
   *  (a restart must not forget it: its retry used to be held in memory only). */
  private oweExit(positionId: number, order: SellOrder): void {
    this.exitOwed.set(positionId, order);
    const p = this.deps.store.position(positionId);
    if (p) this.writeExitOwed(p, order);
  }

  /** Writes a full exit down on the position (positions.exit_owed) unless one is already owed: restore() sells it after
   *  a restart, whatever was held in memory. It stays until the position is closed. */
  private writeExitOwed(p: Position, order: SellOrder): void {
    if (p.exitOwed || (p.status !== 'open' && p.status !== 'opening')) return;
    // (with the stop loss level that called for it: the sale is named after it, and marks it done)
    const owed = { reason: order.reason, ...(order.tag ? { tag: order.tag } : {}), ...(order.stage !== undefined ? { stage: order.stage } : {}) };
    this.deps.store.updatePosition(p.id, { exitOwed: owed });
    p.exitOwed = owed;
  }

  /**
   * The stopped engine sends nothing: the server is shutting down (src/server.ts), and a sale sent now could land after
   * the process has exited, never to be booked (fuzzer cases 20 and 21). What would not come back by itself after the
   * restart is written down instead: a full exit (their exit, Sell now, the rest of a full exit, a stop loss level or
   * the dead-coin rule that sells everything) is owed and restore() sells it after the start; a partial stop loss
   * level, and their partial sell, are owed until they are sold (oweSell). A stop loss level that came due is sold even
   * if the price has come back by the time it can go (it would have been sold behind the sell it waited for; judged
   * again, it was dropped). A timed step is overdue after the restart and the clock fires it. (The same for an order
   * held back while the position waits for a sell from before a restart: see holdForOrphan.)
   */
  private oweAfterRestart(positionId: number, order: SellOrder): void {
    if (order.reason === 'timed' && !order.rest) return;
    const p = this.deps.store.position(positionId);
    if (!p) return;
    if (order.percent >= 100) this.writeExitOwed(p, order);
    else this.oweSell(p, order);
  }

  /** A full exit owed to this position (see exitOwed): sold now if nothing else of ours is on its way. */
  private followUpExit(positionId: number): void {
    if (this.stopped) return; // (it is written down: sold after the restart)
    const order = this.exitOwed.get(positionId);
    if (!order) return;
    const p = this.deps.store.position(positionId);
    if (!p || p.status !== 'open' || p.tokensHeld <= 0n) { this.exitOwed.delete(positionId); return; }
    if (this.reservedExcept(positionId, '') > 0n) return;
    this.exitOwed.delete(positionId);
    this.run(positionId, { reason: order.reason, percent: 100, ...(order.stage !== undefined ? { stage: order.stage } : {}), tag: `${order.tag ?? order.stage ?? ''}:rest`, rest: true });
  }

  /** Runs their sells that were kept while this position's buy was unsettled (it has just opened), or while a sell of it
   *  from before a restart was not settled yet. */
  private firePending(positionId: number): void {
    const orders = this.pendingMirror.get(positionId);
    if (!orders || this.waitsForOrphan(positionId)) return;
    this.pendingMirror.delete(positionId);
    for (const order of orders) this.run(positionId, order);
  }

  // ── plumbing ──────────────────────────────────────────────────────────
  private enqueue<T>(positionId: number, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(positionId) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => undefined);
    this.queues.set(positionId, tail);
    void tail.then(() => {
      if (this.queues.get(positionId) !== tail) return;
      this.queues.delete(positionId);
      this.closeIfEmpty(positionId);
    });
    return next;
  }

  /** Resolves when every queued buy and sell has finished (tests, shutdown). */
  /**
   * True while a buy is in flight or an open position owes a timed step within `withinMs`: a short exit is in
   * progress. The server finishes it before it restarts for an update.
   */
  exitsDueWithin(withinMs: number): boolean {
    const now = this.now();
    return this.deps.store.activePositions().some((p) =>
      p.status === 'opening' || (p.status === 'open' && p.sell.timed.some((t, i) => !p.firedTimed.includes(i) && p.openedAt + t.afterSec * 1000 - now <= withinMs)));
  }

  /**
   * How busy the engine is, for the updater (deploy/update.sh restarts the app at a quiet moment): 'trading' while a
   * buy or sell is under way; 'due' when a timed sell, a retry or the settling of a buy comes up within `withinMs`;
   * 'calm' when positions are open with nothing due that soon; 'idle' when nothing is open.
   */
  quietness(withinMs = 30_000): 'idle' | 'calm' | 'due' | 'trading' {
    if (this.queues.size > 0 || this.loose.size > 0 || this.orphans.size > 0) return 'trading';
    const now = this.now();
    if (this.exitsDueWithin(withinMs) || [...this.retries.values()].some((r) => r.nextAt - now <= withinMs)) return 'due';
    return this.deps.store.activePositions().length ? 'calm' : 'idle';
  }

  private stopped = false;
  /**
   * Shutdown: nothing new is sent from here on, whatever starts it (the clock, a price check coming back, a retry,
   * their trade, Sell now, the exact count of a buy). Retry loops end; sells already out are waited for by the server.
   * Timed steps stay owed and are picked up after the restart; full exits are written down (oweAfterRestart).
   */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves once the exact figures being read for trades already booked are in (or given up on). */
  async refined(): Promise<void> {
    while (this.refining.size > 0) await Promise.all([...this.refining.values()]);
  }

  async idle(): Promise<void> {
    while (this.queues.size > 0 || this.loose.size > 0) await Promise.all([...this.queues.values(), ...this.loose]);
  }
}
