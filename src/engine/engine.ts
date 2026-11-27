// The copytrader. Reacts to followed wallets' trades (buys → copy buys, sells → "sell when they sell") and to the
// clock (timed sells, stop loss levels, dead coin). Every decision, copied or skipped, lands in the user's feed.
//
// Each position has one queue: its buy and all its sells run one after another, so two sells never race and each
// one sells its percent of what is left at that moment.
import type { Keypair } from '@solana/web3.js';
import { lamportsToSol } from '../config.js';
import { friendlyError, log, safeErrorMessage } from '../log.js';
import type { CopyRow, Position, Store } from '../store.js';
import { soldShare, type LeaderTrade } from '../watch/parse.js';
import type { Executor } from './executor.js';
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

/** What a sell answers when the server is shutting down (src/server.ts stops the engine, then waits and exits). */
const STOPPING = 'the server is restarting';
/** What a press of Sell now is told then: it is written down and sold after the restart. */
const STOPPING_ANSWER = 'the server is restarting: this sell goes out as soon as it is back (a few seconds)';

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

/** P % of `held`, exact for 100 %; never more than held. */
export function portion(held: bigint, percent: number): bigint {
  if (percent >= 100) return held;
  const part = (held * BigInt(Math.floor(percent * 10_000))) / 1_000_000n;
  return part > held ? held : part;
}

const REASON_TEXT: Record<SellReason, (o: SellOrder, p: Position) => string> = {
  timed: (o, p) => `timed sell after ${p.sell.timed[o.stage ?? 0]?.afterSec ?? '?'}s`,
  stop_loss: (o, p) => `stop loss at −${p.sell.stopLoss[o.stage ?? 0]?.lossPct ?? '?'}%`,
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
  /** Their sells that arrived while our buy's outcome was unknown: run once the buy is settled. */
  private readonly pendingMirror = new Map<number, SellOrder[]>();
  /** Full exits that went out while another of our sells was on its way: once nothing is out any more, whatever is
   *  still held is sold too (an overlapping sell the market paid only part of, or one that failed for good). */
  private readonly exitOwed = new Map<number, SellOrder>();
  /** Failures of an owed Sell now's re-runs, per order (its feed line is written on the first one only). */
  private readonly owedFails = new Map<string, { positionId: number; n: number }>();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
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
        const job = this.startCopyBuy(copy, t);
        if (job) jobs.push(job);
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
        // Their full exit is written down at once: until the position is closed it is owed, and a restart or a crash
        // before it has sold (it may wait behind another sell of ours) must not forget it.
        if (percent >= 100) this.writeExitOwed(p, order);
        if (this.stopped) { this.oweAfterRestart(p.id, order); continue; }
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
      const onSigned = (sig: string) => { signedAt = Date.now(); store.updatePosition(id, { buySig: sig, mode: 'live' }); };
      const fill = await executor.buy({ wallet, mint: t.mint, lamports, slippagePct: s.slippagePct, priorityFeeSol: s.priorityFeeSol, tipSol: s.tipSol ?? 0, live: true, feeBps, onSigned, ...(t.curve ? { curve: t.curve } : {}), ...(t.heardAt ? { heardAt: t.heardAt } : {}) });
      // How long after their trade was heard ours went out (signed and handed to the senders).
      const copyMs = signedAt && t.heardAt ? signedAt - t.heardAt : null;
      if (!fill.ok && fill.uncertain) {
        // It went out and nobody could tell us what became of it. Not failed, not bought: the position stays
        // "opening" (so the coin is not bought twice) and restore() settles it from the wallet within a minute.
        store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label}: sent, but its outcome is not known yet (the connection did not answer). It is settled from the wallet within a minute.`, mint: t.mint, signature: t.signature });
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
      // The position is live only if the buy really went on-chain (a copy flipped to Live on a test server is paper).
      store.updatePosition(id, { mode: fill.simulated ? 'paper' : 'live', status: 'open', tokensBought: fill.tokens, tokensHeld: fill.tokens, costLamports: fill.lamports, openedAt: now, lastChangeAt: now, refValueLamports: fill.lamports, buySig: fill.signature });
      const fillId = store.insertFill({ positionId: id, userId: copy.userId, side: 'buy', reason: 'copy', tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n, exactPending: !!fill.refine && !fill.simulated });
      // The exact SOL spent is read from the confirmed transaction afterwards; the position does not wait for it.
      this.refineLater(fillId, fill.refine, (exact) => this.exactBuy(id, fillId, fill.tokens, exact));
      store.addEvent({
        userId: copy.userId, copyId: copy.id, kind: 'buy',
        message: `Bought ${fmtSol(fill.lamports)} of ${label} — they bought ${fmtSol(t.solLamports)}${copyMs !== null && !fill.simulated ? ` · sent ${copyMs} ms after their trade was seen` : ''}${fill.simulated ? ' (test)' : ''}`,
        mint: t.mint, signature: fill.simulated ? null : fill.signature,
      });
    } catch (err) {
      store.updatePosition(id, { status: 'failed', closedAt: this.now() });
      store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label} failed: ${friendlyError(safeErrorMessage(err))}`, mint: t.mint });
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
  private async settleUnknownSell(signature: string | null, owner: string, mint: string, sentAt: number, error: string): Promise<Awaited<ReturnType<Executor['sell']>>> {
    const { executor } = this.deps;
    if (!signature || !executor.settleSell) return { ok: false, error };
    const longest = this.deps.settleRetryMs ?? 15_000;
    for (let i = 0; ; i++) {
      try {
        const r = await executor.settleSell(signature, owner, mint);
        if (r.state === 'landed') return { ok: true, signature, tokens: r.tokens, lamports: r.lamports, simulated: false, confirmedAt: this.now(), note: 'outcome read from its own transaction' };
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
    if (this.inFlight.has(key) || this.stopped) return; // (stopped: the step is overdue after the restart and goes then)
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
      if (this.stopped) return; // shutting down: the step stays owed and goes out after the restart
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
        let partial = false;
        try {
          fill = await executor.sell({
            wallet, mint: p.mint, tokens, slippagePct: copy?.settings.slippagePct ?? 25,
            priorityFeeSol: copy?.settings.sellPriorityFeeSol ?? copy?.settings.priorityFeeSol ?? 0.0005,
            tipSol: copy?.settings.sellTipSol ?? copy?.settings.tipSol ?? 0, live, feeBps: this.deps.feeBpsFor?.(p.userId) ?? 0,
            exit: live, checkFirst: failures > 0, closeIfEmpty: !!order.everything, onSigned: (sig) => { signature = sig; },
          });
          // Nobody could tell us whether it landed: settled from its own transaction first, its coins still reserved.
          if (!fill.ok && fill.uncertain) fill = await this.settleUnknownSell(signature, owner, p.mint, sentAt, fill.error);
          if (fill.ok) {
            // Booked while its coins are still reserved (another sell's booking must not take them off meanwhile).
            // The wallet's balance after the last step tells whether the bag is really empty (a failed read keeps
            // our books). The last step is done only when the position is empty: it sold only part (the market
            // could not pay for all of it), or another step was out when it sold and has since failed or sold only
            // part of its share, and the last step sells what is left (at the slow pace when the market was short).
            const after = live && order.everything ? await executor.tokenBalance(owner, p.mint).catch(() => null) : null;
            partial = !!order.everything && fill.tokens < tokens;
            this.settleSell(p.id, order, fill, sentAt, after, !!order.everything, partial, key);
          }
        } finally {
          mine.delete(key);
          if (!mine.size) this.reserved.delete(p.id);
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
      // Failed: retry at once, then after short pauses. Later steps are untouched: they run on their own clocks.
      const why = order.everything ? 'final timed sell' : `timed sell of ${fmtPct(order.percent)} of the bag`;
      if (failures === 0) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed: ${friendlyError(error)} — retrying`, mint: p.mint });
      if (failures >= pauses.length) {
        if (!order.everything) {
          const fresh = store.position(p.id);
          if (fresh) store.updatePosition(p.id, { firedTimed: [...new Set([...fresh.firedTimed, stage])] });
          store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Gave up on the ${why} of ${label} after ${failures + 1} failed tries: ${friendlyError(error)}. The last step sells what is left.`, mint: p.mint });
          return;
        }
        // The last step never gives up: the coins are still in the wallet and nobody may be watching. It keeps
        // trying at a slower pace until it sells, the position is closed another way (Sell now), or the server stops.
        const slow = this.deps.slowRetryMs ?? SLOW_RETRY_MS;
        if (failures === pauses.length) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `The ${why} of ${label} has failed ${failures + 1} times (${friendlyError(error)}): still trying every ${Math.max(1, Math.round(slow / 1000))} s until it sells. Sell now works too.`, mint: p.mint });
        await pause(slow);
        failures++;
        continue;
      }
      await pause(pauses[failures]!);
      failures++;
    }
  }

  /** Books a finished sell. Synchronous from the re-read on, so overlapping sells cannot corrupt the position.
   *  `partial`: the market paid for only part of a sell of everything; the order stays owed (not marked done). */
  private settleSell(positionId: number, order: SellOrder, fill: Extract<Awaited<ReturnType<Executor['sell']>>, { ok: true }>, sentAt: number, walletAfter: bigint | null, keepOwed = false, marketShort = false, key = ''): void {
    const { store } = this.deps;
    const p = store.position(positionId);
    if (!p) return;
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
    if (sold === 0n && fill.simulated) return; // nothing was left for this step in test mode: no fill, no feed line
    const fillId = store.insertFill({ positionId: p.id, userId: p.userId, side: 'sell', reason: order.reason, tokens: fill.tokens, lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n, exactPending: !!fill.refine && !fill.simulated });
    this.refineLater(fillId, fill.refine, (exact) => this.exactSell(p.id, fillId, lamports, exact.lamports));
    this.soldSome(p.id);
    store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'sell', message: this.sellMessage(p, order, fill.tokens, lamports, sentAt, fill.simulated, closed, marketShort && !closed), mint: p.mint, signature: fill.simulated ? null : fill.signature });
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
    if (this.stopped) { this.oweAfterRestart(positionId, order); return; }
    const key = this.orderKey(positionId, order);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
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
    store.updatePosition(p.id, { status: 'closed', tokensHeld: 0n, closedAt: this.now() });
    store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${shortMint(p.mint)} (${p.copyName}): nothing of it is left to sell — closed`, mint: p.mint });
  }

  async sellNow(userId: number, positionId: number): Promise<{ ok: boolean; error?: string }> {
    const p = this.deps.store.position(positionId);
    if (!p || p.userId !== userId || p.status !== 'open') return { ok: false, error: 'no open position with that id' };
    if (this.stopped) return this.notSent(p, { reason: 'manual', percent: 100 });
    // A click deserves more than one try: when the first fails (often because one of our own timed sells landed in
    // between and the amount was stale) it is tried again at once, and once more a moment later. Only the last
    // failure is shown.
    let result: { ok: boolean; error?: string } = { ok: false, error: 'not tried' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 2) await new Promise((r) => setTimeout(r, this.deps.zeroRecheckMs ?? 300));
      result = await this.enqueue(positionId, () => this.sell(positionId, { reason: 'manual', percent: 100 }, attempt < 2, attempt > 0));
      if (result.ok || result.error === 'position is not open' || result.error === STOPPING_ANSWER) break;
    }
    return result;
  }

  /**
   * A sell the stopped engine does not send (the server is shutting down: see stop()). What would not come back by
   * itself is written down (oweAfterRestart); a press of Sell now gets its answer, in the feed too.
   */
  private notSent(p: Position, order: SellOrder): { ok: false; error: string } {
    this.oweAfterRestart(p.id, order);
    if (order.reason === 'manual' && !order.rest) {
      this.deps.store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${shortMint(p.mint)} (${p.copyName}) (you pressed Sell now) did not go out: the server is restarting. It is sold as soon as the server is back (a few seconds).`, mint: p.mint });
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

  private markDone(p: Position, order: SellOrder): Partial<Pick<Position, 'firedTimed' | 'firedStop' | 'deadFired'>> {
    if (order.reason === 'timed' && order.stage !== undefined) return { firedTimed: [...new Set([...p.firedTimed, order.stage])] };
    if (order.reason === 'stop_loss' && order.stage !== undefined) return { firedStop: [...new Set([...p.firedStop, order.stage])] };
    if (order.reason === 'dead_coin') return { deadFired: true };
    return {};
  }

  private async sell(positionId: number, order: SellOrder, quiet = false, retry = false): Promise<{ ok: boolean; error?: string }> {
    const { store, executor } = this.deps;
    const p = store.position(positionId);
    if (p && p.status === 'opening' && order.reason === 'mirror') {
      // Our buy went out and its outcome is not known yet: their sell is kept and runs once the buy is settled (it
      // used to be dropped, and nothing sold the coins once the position opened).
      const kept = this.pendingMirror.get(p.id) ?? [];
      kept.push(order);
      this.pendingMirror.set(p.id, kept);
      // Their full exit is also written down: a restart before the buy is settled must not forget it.
      if (order.percent >= 100) this.writeExitOwed(p, order);
      if (kept.length === 1) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${shortMint(p.mint)} (${p.copyName}): they sold while our buy's outcome is not known yet — sold as soon as the buy is settled`, mint: p.mint });
      return { ok: false, error: 'waiting for the buy to be settled' };
    }
    if (!p || p.status !== 'open' || p.tokensHeld <= 0n) return { ok: false, error: 'position is not open' };
    // Queued before the server began to shut down: not sent now (what does not come back by itself is owed).
    if (this.stopped) return this.notSent(p, order);
    const label = `${shortMint(p.mint)} (${p.copyName})`;
    const wallet = this.deps.walletFor(p.userId);
    if (!wallet) {
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Cannot sell ${label}: no wallet`, mint: p.mint });
      return { ok: false, error: 'no wallet' };
    }
    const owner = wallet.publicKey.toBase58();
    // A stage that already fired (e.g. finished while this order waited in the queue) never sells twice.
    if (!order.rest && ((order.reason === 'timed' && order.stage !== undefined && p.firedTimed.includes(order.stage))
      || (order.reason === 'stop_loss' && order.stage !== undefined && p.firedStop.includes(order.stage))
      || (order.reason === 'dead_coin' && p.deadFired))) {
      this.retries.delete(this.orderKey(p.id, order)); // (a retry of it would otherwise be run again on every tick)
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
      let closed = false;
      let partial = false;
      let fillId = 0;
      try {
        fill = await executor.sell({ wallet, mint: p.mint, tokens, slippagePct, priorityFeeSol, tipSol, live: p.mode === 'live', feeBps: this.deps.feeBpsFor?.(p.userId) ?? 0, exit: live, checkFirst, closeIfEmpty: order.percent >= 100 && inFlight === 0n, onSigned: (sig) => { signature = sig; } });
        // Nobody could tell us whether it landed: settled from its own transaction first, its coins still reserved.
        if (!fill.ok && fill.uncertain) fill = await this.settleUnknownSell(signature, owner, p.mint, sentAt, fill.error);
        if (fill.ok) {
          // Booked while its coins are still reserved: the wallet is read first and the position after it, and from
          // that re-read on everything is synchronous. A sell booked while the wallet was being read is never
          // overwritten (its SOL used to vanish from the profit), and this sell's coins, gone from the wallet but not
          // booked yet, are not taken off the books by another sell's booking in between.
          const after = live ? await executor.tokenBalance(owner, p.mint).catch(() => null) : null;
          const cur = store.position(p.id) ?? p;
          let left = cur.tokensHeld - fill.tokens;
          if (after !== null) {
            // If the wallet holds less than our books say (sold elsewhere), believe the wallet, counting what our
            // other sells still have on their way (landed or not, they are booked when they confirm). A failed read
            // keeps our own figure: an RPC hiccup must not close a position.
            const cap = after + this.reservedExcept(p.id, key);
            if (cap < left) left = cap;
          }
          if (left < 0n) left = 0n;
          closed = left === 0n;
          // A sell of everything that the market could pay only part of (a curve short of SOL): the rest is sold on
          // a later try at the slow pace (the curve needs buyers to fill up again); the order is not done until then.
          // Sell now says so instead: the user decides when to press it again.
          partial = order.percent >= 100 && fill.tokens < tokens && !closed;
          store.updatePosition(p.id, {
            tokensHeld: left,
            proceedsLamports: cur.proceedsLamports + fill.lamports,
            ...(closed && cur.status === 'open' ? { status: 'closed' as const, closedAt: this.now() } : {}),
            ...(partial ? {} : this.markDone(cur, order)),
          });
          this.retries.delete(key);
          if (partial && order.reason !== 'manual') this.retries.set(key, { positionId: p.id, order, tries: 1, nextAt: this.now() + (this.deps.slowRetryMs ?? SLOW_RETRY_MS) });
          // A full exit that left coins (to our other sells on their way, or to one between its retries that may yet
          // fail for good): once nothing else is out, whatever is still held is sold too.
          if (!closed && !partial && order.percent >= 100) this.oweExit(p.id, order);
          fillId = store.insertFill({ positionId: p.id, userId: p.userId, side: 'sell', reason: order.reason, tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n, exactPending: !!fill.refine && !fill.simulated });
        }
      } finally {
        mine.delete(key);
        if (!mine.size) this.reserved.delete(p.id);
      }
      if (!fill.ok) {
        const failed = this.sellFailed(p, order, label, fill.error, quiet);
        this.followUpExit(p.id);
        return failed;
      }
      if (!fill.simulated) this.balanceChanged(owner); // the wallet's SOL just changed: read again, in the background
      const booked = fill.lamports;
      this.refineLater(fillId, fill.refine, (exact) => this.exactSell(p.id, fillId, booked, exact.lamports));
      this.soldSome(p.id);
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'sell', message: this.sellMessage(p, order, fill.tokens, fill.lamports, sentAt, fill.simulated, closed, partial), mint: p.mint, signature: fill.simulated ? null : fill.signature });
      this.followUpExit(p.id);
      return { ok: true };
    } catch (err) {
      return this.sellFailed(p, order, label, safeErrorMessage(err), quiet);
    }
  }

  /** Something of this position sold: a sell of it that fails from now on says so again. */
  private soldSome(positionId: number): void {
    for (const [key, f] of this.owedFails) if (f.positionId === positionId) this.owedFails.delete(key);
  }

  private sellFailed(p: Position, order: SellOrder, label: string, rawError: string, quiet = false): { ok: boolean; error: string } {
    const { store } = this.deps;
    const error = friendlyError(rawError);
    const why = REASON_TEXT[order.reason](order, p);
    if (order.reason === 'manual') {
      // Pressed by the user: every press gets its answer. The rest of a Sell now that is owed (run again by the
      // settling pass every 30 s until it sells) says so once, not every 30 s (it filled the feed on a coin that
      // cannot be sold).
      if (order.rest) {
        const key = this.orderKey(p.id, order);
        const n = (this.owedFails.get(key)?.n ?? 0) + 1;
        this.owedFails.set(key, { positionId: p.id, n });
        if (n === 1 && !quiet) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed: ${error} — tried again every 30 s until it sells`, mint: p.mint });
        return { ok: false, error };
      }
      if (!quiet) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed: ${error}`, mint: p.mint });
      return { ok: false, error };
    }
    const key = this.orderKey(p.id, order);
    const tries = (this.retries.get(key)?.tries ?? 0) + 1;
    // A sell of EVERYTHING never gives up: the coins are still in the wallet and nobody may be watching. A sell of a
    // part does, after its quick tries: the rules that come later sell what it left.
    const fullExit = order.percent >= 100;
    if (tries >= MAX_SELL_TRIES && !fullExit) {
      this.retries.delete(key);
      store.updatePosition(p.id, this.markDone(p, order));
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Gave up on the ${why} of ${label} after ${tries} failed tries: ${error}. Use Sell now.`, mint: p.mint });
    } else {
      const slow = this.deps.slowRetryMs ?? SLOW_RETRY_MS;
      const wait = RETRY_MS[tries - 1] ?? slow;
      this.retries.set(key, { positionId: p.id, order, tries, nextAt: this.now() + wait });
      // A full exit that keeps failing is also written down: a restart must not forget it (its retry is in memory).
      if (fullExit) this.writeExitOwed(p, order);
      // One feed line per failing sell, not one per retry; one more when it turns into the slow, endless kind.
      if (tries === 1) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed: ${error} — retrying`, mint: p.mint });
      if (tries === MAX_SELL_TRIES) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `The sell of ${label} (${why}) has failed ${tries} times (${error}): still trying every ${Math.max(1, Math.round(slow / 1000))} s until it sells. Sell now works too.`, mint: p.mint });
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
    const job = refine.then((exact) => { if (exact) apply(exact); }).catch(() => undefined).finally(() => this.refining.delete(fillId));
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
    store.setFillExact(fillId, exact.lamports, exact.tokens);
    store.updatePosition(positionId, { costLamports: exact.lamports });
    if (exact.tokens === undefined || exact.tokens === bookedTokens) return;
    const p = store.position(positionId);
    if (!p || (p.status !== 'open' && p.status !== 'closed')) return;
    const sold = store.sellsOf(positionId);
    const held = exact.tokens > sold.tokens ? exact.tokens - sold.tokens : 0n;
    if (p.status === 'open') {
      store.updatePosition(positionId, { tokensBought: exact.tokens, tokensHeld: held });
      // Nothing left: closed now, or by whatever of it is still under way once that is over.
      this.closeIfEmpty(positionId);
      return;
    }
    store.updatePosition(positionId, { tokensBought: exact.tokens });
    if (held <= 0n) return;
    store.updatePosition(positionId, { status: 'open', tokensHeld: held, closedAt: null, lastChangeAt: this.now() });
    store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `Our buy of ${shortMint(p.mint)} (${p.copyName}) received ${fmtTokens(held, p.decimals)} tokens more than its quote said (the exact count came in after the position was sold): they are sold too.`, mint: p.mint });
    this.run(positionId, { reason: sold.lastReason ?? 'manual', percent: 100, tag: ':exact', rest: true });
  }

  /** A sell's exact SOL applied to its fill and to the position's proceeds (booked: what was booked from the quote). */
  private exactSell(positionId: number, fillId: number, booked: bigint, exact: bigint): void {
    const { store } = this.deps;
    store.setFillExact(fillId, exact);
    const now = store.position(positionId);
    if (now) store.updatePosition(positionId, { proceedsLamports: now.proceedsLamports + (exact - booked) });
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
      if (f.side === 'buy') this.exactBuy(p.id, f.id, f.tokens, { lamports: r.lamports, tokens: r.tokens });
      else this.exactSell(p.id, f.id, f.lamports, r.lamports);
    }
  }

  // ── after a restart, and as a safety net ─────────────────────────────
  /**
   * Buys that were in flight when the server stopped. Test fills are dropped; a live one is settled by the wallet:
   * if it holds the coin, the position opens with those tokens (so its sell rules run), otherwise it failed.
   */
  async restore(): Promise<void> {
    const { store } = this.deps;
    if (this.stopped) return;
    await this.settleOpening();
    await this.settleEstimates().catch(() => undefined);
    // Full exits owed (written down when they failed, left coins, or came while the buy was unsettled): after a restart
    // nothing in memory remembers them. One that this process is already retrying or waiting on is left to that.
    for (const p of store.activePositions()) {
      if (p.status !== 'open' || !p.exitOwed || this.queues.has(p.id) || this.exitOwed.has(p.id) || this.pendingMirror.has(p.id)) continue;
      if ([...this.retries.values()].some((r) => r.positionId === p.id)) continue;
      this.run(p.id, { reason: p.exitOwed.reason, percent: 100, tag: `${p.exitOwed.tag ?? ''}:owed`, rest: true });
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
      if (!p.buySig || !wallet) {
        this.pendingMirror.delete(p.id);
        store.updatePosition(p.id, { status: 'failed', closedAt: this.now() });
        continue;
      }
      // Signed means sent for real, whatever the row said when it was written (Live switched on meanwhile).
      if (p.mode !== 'live') store.updatePosition(p.id, { mode: 'live' });
      if (!executor.isLive({ live: true, exit: true })) continue; // no connection to read it now: settled later
      try {
        if (executor.settleBuy) {
          // Its own transaction says what happened: exact coins and cost, or that it failed.
          const r = await executor.settleBuy(p.buySig, wallet.publicKey.toBase58(), p.mint);
          if (r.state === 'landed') {
            const now = this.now();
            store.updatePosition(p.id, { status: 'open', tokensBought: r.tokens, tokensHeld: r.tokens, costLamports: r.lamports, refValueLamports: r.lamports, openedAt: now, lastChangeAt: now });
            store.insertFill({ positionId: p.id, userId: p.userId, side: 'buy', reason: 'copy', tokens: r.tokens, lamports: r.lamports, signature: p.buySig, simulated: false, error: null, feeLamports: 0n });
            store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'buy', message: `Bought ${fmtSol(r.lamports)} of ${label} — confirmed late (its exit starts now)`, mint: p.mint, signature: p.buySig });
            this.firePending(p.id);
          } else if (r.state === 'failed' || this.now() - p.openedAt > 90_000) {
            // Failed on chain, or not found long after its blockhash ran out: it never landed.
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
    const owed = { reason: order.reason, ...(order.tag ? { tag: order.tag } : {}) };
    this.deps.store.updatePosition(p.id, { exitOwed: owed });
    p.exitOwed = owed;
  }

  /**
   * The stopped engine sends nothing: the server is shutting down (src/server.ts), and a sale sent now could land after
   * the process has exited, never to be booked (fuzzer cases 20 and 21). What would not come back by itself after the
   * restart is written down instead: a full exit that is not a rule of the clock (their exit, Sell now, the rest of a
   * full exit) is owed and restore() sells it after the start. A timed step is overdue then and the clock fires it; a
   * stop loss level and the dead-coin rule are checked again.
   */
  private oweAfterRestart(positionId: number, order: SellOrder): void {
    if (order.percent < 100 || (!order.rest && (order.reason === 'timed' || order.reason === 'stop_loss' || order.reason === 'dead_coin'))) return;
    const p = this.deps.store.position(positionId);
    if (p) this.writeExitOwed(p, order);
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
    this.run(positionId, { reason: order.reason, percent: 100, tag: `${order.tag ?? order.stage ?? ''}:rest`, rest: true });
  }

  /** Runs their sells that were kept while this position's buy was unsettled (it has just opened). */
  private firePending(positionId: number): void {
    const orders = this.pendingMirror.get(positionId);
    if (!orders) return;
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
    if (this.queues.size > 0 || this.loose.size > 0) return 'trading';
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
