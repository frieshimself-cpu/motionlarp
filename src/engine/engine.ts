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

/** An automatic sell that fails is retried after these pauses, then given up (Sell now stays available). */
const RETRY_MS = [250, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const MAX_SELL_TRIES = RETRY_MS.length + 1;
/** Dead coin needs a recent successful quote: an RPC outage is not "no trades". */
const QUOTE_FRESH_MS = 15_000;

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

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── leader trades ─────────────────────────────────────────────────────
  /**
   * Decides synchronously and queues the work; it does not wait for buys and sells to finish (the watcher must
   * keep reading the next transactions meanwhile).
   */
  async onLeaderTrade(t: LeaderTrade): Promise<void> {
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
        const key = this.orderKey(p.id, order);
        this.inFlight.add(key);
        jobs.push(this.enqueue(p.id, () => this.sell(p.id, order)).finally(() => this.inFlight.delete(key)));
      }
    }
    void Promise.all(jobs);
  }

  /** SOL balance, cached for 15 s (a fresh RPC round trip before every buy costs time). */
  private async solBalance(owner: string): Promise<bigint> {
    const hit = this.solCache.get(owner);
    if (hit && this.now() - hit.at < 15_000) return hit.lamports;
    const lamports = await this.deps.executor.solBalance(owner);
    this.solCache.set(owner, { lamports, at: this.now() });
    return lamports;
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
    const maxBuy = typeof this.deps.maxSolPerBuy === 'function' ? this.deps.maxSolPerBuy() : this.deps.maxSolPerBuy;
    if (s.buySol > maxBuy) return skip(`${s.buySol} SOL is above the server limit of ${maxBuy} SOL per buy`);
    const wallet = this.deps.walletFor(copy.userId);
    if (!wallet) return skip('no wallet imported yet');

    const id = store.insertPosition({ userId: copy.userId, copyId: copy.id, mint: t.mint, mode: 'live', leaderSig: t.signature, sell: s.sell, copyName: s.name, leader: t.leader, now: this.now(), decimals: t.decimals ?? 6 });
    return this.enqueue(id, () => this.buy(id, copy, wallet, t));
  }

  private async buy(id: number, copy: CopyRow, wallet: Keypair, t: LeaderTrade): Promise<void> {
    const { store, executor } = this.deps;
    const s = copy.settings;
    const lamports = BigInt(Math.round(s.buySol * 1e9));
    const label = `${shortMint(t.mint)} (${s.name})`;
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
        // The coin is looked up while the balance is read (one round trip less in front of the buy).
        const [have] = await Promise.all([this.solBalance(wallet.publicKey.toBase58()), executor.warm?.(t.mint).catch(() => undefined)]);
        if (have < need) {
          store.updatePosition(id, { status: 'failed', closedAt: this.now() });
          store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'skip', message: `Skipped ${label}: wallet has ${fmtSol(have)}, needs ${fmtSol(need)} (buy${platformFee > 0n ? ' + platform fee' : ''} + ${costs > reserve ? 'the fees to get in and out again' : 'fee reserve'})`, mint: t.mint, signature: t.signature });
          return;
        }
      }
      // The buy's signature is written down the moment it is signed: if the outcome is lost (a crash, no answer from
      // the RPC), restore() reads that very transaction instead of guessing from the wallet.
      const onSigned = (sig: string) => store.updatePosition(id, { buySig: sig });
      const fill = await executor.buy({ wallet, mint: t.mint, lamports, slippagePct: s.slippagePct, priorityFeeSol: s.priorityFeeSol, tipSol: s.tipSol ?? 0, live: true, feeBps, onSigned });
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
      this.solCache.delete(wallet.publicKey.toBase58());
      // The position is live only if the buy really went on-chain (a copy flipped to Live on a test server is paper).
      store.updatePosition(id, { mode: fill.simulated ? 'paper' : 'live', status: 'open', tokensBought: fill.tokens, tokensHeld: fill.tokens, costLamports: fill.lamports, openedAt: now, lastChangeAt: now, refValueLamports: fill.lamports, buySig: fill.signature });
      const fillId = store.insertFill({ positionId: id, userId: copy.userId, side: 'buy', reason: 'copy', tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n });
      // The exact SOL spent is read from the confirmed transaction afterwards; the position does not wait for it.
      void fill.refine?.then((exact) => {
        if (!exact) return;
        store.updateFillLamports(fillId, exact.lamports);
        store.updatePosition(id, { costLamports: exact.lamports });
      }).catch(() => undefined);
      store.addEvent({
        userId: copy.userId, copyId: copy.id, kind: 'buy',
        message: `Bought ${fmtSol(fill.lamports)} of ${label} — they bought ${fmtSol(t.solLamports)}${fill.simulated ? ' (test)' : ''}`,
        mint: t.mint, signature: fill.simulated ? null : fill.signature,
      });
    } catch (err) {
      store.updatePosition(id, { status: 'failed', closedAt: this.now() });
      store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label} failed: ${friendlyError(safeErrorMessage(err))}`, mint: t.mint });
    }
  }

  // ── the clock ─────────────────────────────────────────────────────────
  async tick(): Promise<void> {
    const now = this.now();
    for (const [key, r] of this.retries) {
      if (this.deps.store.position(r.positionId)?.status !== 'open') { this.retries.delete(key); continue; }
      if (r.nextAt <= now && !this.inFlight.has(key)) this.run(r.positionId, r.order);
    }
    const positions = this.deps.store.activePositions().filter((p) => p.status === 'open');
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
    if (this.quoting.has(p.id) || now - (this.lastQuoteAt.get(p.id) ?? 0) < this.deps.priceMs) return;
    this.lastQuoteAt.set(p.id, now);
    this.quoting.add(p.id);
    try {
      const value = await this.deps.executor.quoteSell(p.mint, p.tokensBought);
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

  private reservedExcept(positionId: number, key: string): bigint {
    let sum = 0n;
    for (const [k, v] of this.reserved.get(positionId) ?? []) if (k !== key) sum += v;
    return sum;
  }

  /** Sent at its own time whether or not earlier steps are confirmed; never queued behind them. */
  private runBagStep(positionId: number, order: SellOrder): void {
    const key = this.orderKey(positionId, order);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    const job: Promise<void> = this.bagStep(positionId, order, key)
      .catch((err) => log.warn('timed step failed', { position: positionId, error: safeErrorMessage(err) }))
      .finally(() => { this.inFlight.delete(key); this.loose.delete(job); });
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
        const copy = store.copyIncludingDeleted(p.copyId);
        const sentAt = this.now();
        const mine = this.reserved.get(p.id) ?? new Map<string, bigint>();
        mine.set(key, tokens);
        this.reserved.set(p.id, mine);
        let fill: Awaited<ReturnType<Executor['sell']>>;
        try {
          fill = await executor.sell({
            wallet, mint: p.mint, tokens, slippagePct: copy?.settings.slippagePct ?? 25,
            priorityFeeSol: copy?.settings.sellPriorityFeeSol ?? copy?.settings.priorityFeeSol ?? 0.0005,
            tipSol: copy?.settings.sellTipSol ?? copy?.settings.tipSol ?? 0, live, feeBps: this.deps.feeBpsFor?.(p.userId) ?? 0,
            exit: live, checkFirst: failures > 0,
          });
        } finally {
          mine.delete(key);
          if (!mine.size) this.reserved.delete(p.id);
        }
        if (fill.ok) {
          // The wallet's balance after the last step tells whether the bag is really empty (a failed read keeps our books).
          const after = live && order.everything ? await executor.tokenBalance(owner, p.mint).catch(() => null) : null;
          this.settleSell(p.id, order, fill, sentAt, after);
          this.solCache.delete(owner); // the wallet's SOL just changed
          return;
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

  /** Books a finished sell. Synchronous from the re-read on, so overlapping sells cannot corrupt the position. */
  private settleSell(positionId: number, order: SellOrder, fill: Extract<Awaited<ReturnType<Executor['sell']>>, { ok: true }>, sentAt: number, walletAfter: bigint | null): void {
    const { store } = this.deps;
    const p = store.position(positionId);
    if (!p) return;
    const sold = fill.tokens > p.tokensHeld ? p.tokensHeld : fill.tokens;
    // A test fill for tokens the books no longer hold is not money: count only what was really still there.
    const lamports = fill.simulated && fill.tokens > 0n && sold < fill.tokens ? (fill.lamports * sold) / fill.tokens : fill.lamports;
    let left = p.tokensHeld - sold;
    if (walletAfter !== null && walletAfter < left) left = walletAfter;
    const closed = left === 0n;
    store.updatePosition(p.id, {
      tokensHeld: left,
      proceedsLamports: p.proceedsLamports + lamports,
      ...(closed && p.status === 'open' ? { status: 'closed' as const, closedAt: this.now() } : {}),
      ...this.markDone(p, order),
    });
    if (sold === 0n && fill.simulated) return; // nothing was left for this step in test mode: no fill, no feed line
    const fillId = store.insertFill({ positionId: p.id, userId: p.userId, side: 'sell', reason: order.reason, tokens: fill.tokens, lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n });
    void fill.refine?.then((exact) => {
      if (!exact) return;
      const now = store.position(p.id);
      store.updateFillLamports(fillId, exact.lamports);
      if (now) store.updatePosition(p.id, { proceedsLamports: now.proceedsLamports + (exact.lamports - lamports) });
    }).catch(() => undefined);
    store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'sell', message: this.sellMessage(p, order, fill.tokens, lamports, sentAt, fill.simulated, closed), mint: p.mint, signature: fill.simulated ? null : fill.signature });
  }

  /** "Sold 40% of the bag of X (copy) for 0.4 SOL — +2.0s after buy · 412K tokens (test). Position closed." */
  private sellMessage(p: Position, order: SellOrder, tokens: bigint, lamports: bigint, sentAt: number, simulated: boolean, closed: boolean): string {
    const label = `${shortMint(p.mint)} (${p.copyName})`;
    const what = order.everything ? 'the rest' : order.basis === 'bag' ? `${fmtPct(order.percent)} of the bag` : order.percent >= 100 ? 'all' : fmtPct(order.percent);
    const after = `+${((sentAt - p.openedAt) / 1000).toFixed(1)}s after buy`;
    const why = order.basis === 'bag' ? after : `${REASON_TEXT[order.reason](order, p)} · ${after}`;
    return `Sold ${what} of ${label} for ${fmtSol(lamports)} — ${why} · ${fmtTokens(tokens, p.decimals)} tokens${simulated ? ' (test)' : ''}${closed ? '. Position closed.' : ''}`;
  }

  // ── selling ───────────────────────────────────────────────────────────
  private orderKey(positionId: number, order: SellOrder): string {
    return `${positionId}:${order.reason}:${order.stage ?? ''}:${order.tag ?? ''}`;
  }

  private run(positionId: number, order: SellOrder): void {
    const key = this.orderKey(positionId, order);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void this.enqueue(positionId, () => this.sell(positionId, order)).finally(() => this.inFlight.delete(key));
  }

  async sellNow(userId: number, positionId: number): Promise<{ ok: boolean; error?: string }> {
    const p = this.deps.store.position(positionId);
    if (!p || p.userId !== userId || p.status !== 'open') return { ok: false, error: 'no open position with that id' };
    // A click deserves more than one try: when the first fails (often because one of our own timed sells landed in
    // between and the amount was stale) it is tried again at once, and once more a moment later. Only the last
    // failure is shown.
    let result: { ok: boolean; error?: string } = { ok: false, error: 'not tried' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 2) await new Promise((r) => setTimeout(r, this.deps.zeroRecheckMs ?? 300));
      result = await this.enqueue(positionId, () => this.sell(positionId, { reason: 'manual', percent: 100 }, attempt < 2, attempt > 0));
      if (result.ok || result.error === 'position is not open') break;
    }
    return result;
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
    if (!p || p.status !== 'open' || p.tokensHeld <= 0n) return { ok: false, error: 'position is not open' };
    const label = `${shortMint(p.mint)} (${p.copyName})`;
    const wallet = this.deps.walletFor(p.userId);
    if (!wallet) {
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Cannot sell ${label}: no wallet`, mint: p.mint });
      return { ok: false, error: 'no wallet' };
    }
    const owner = wallet.publicKey.toBase58();
    // A stage that already fired (e.g. finished while this order waited in the queue) never sells twice.
    if ((order.reason === 'timed' && order.stage !== undefined && p.firedTimed.includes(order.stage))
      || (order.reason === 'stop_loss' && order.stage !== undefined && p.firedStop.includes(order.stage))
      || (order.reason === 'dead_coin' && p.deadFired)) return { ok: true };
    const live = p.mode === 'live';
    // The Live switch stops new real buys only: a position bought for real is always sold by its rules.
    if (live && !executor.isLive({ live: true, exit: true })) {
      return this.sellFailed(p, order, label, 'no connection to Solana: a live position cannot be sold right now', quiet);
    }
    try {
      // Live: this position's own tokens, never more than the wallet really holds (other copies or coins the user
      // holds by hand in the same wallet are not touched).
      const onChain = live ? await this.walletTokens(owner, p.mint) : p.tokensHeld;
      const held = onChain < p.tokensHeld ? onChain : p.tokensHeld;
      if (held <= 0n) {
        store.updatePosition(p.id, { status: 'closed', tokensHeld: 0n, closedAt: this.now(), ...this.markDone(p, order) });
        store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${label}: the wallet holds none of it any more (sold elsewhere?) — closed`, mint: p.mint });
        return { ok: true };
      }
      // Tokens one of our timed steps is selling right now are already on their way: this sell takes its share of
      // the rest (asking for them too would fail on chain, or make the step fail, and cost a fee either way).
      const inFlight = this.reservedExcept(p.id, '');
      const free = held > inFlight ? held - inFlight : 0n;
      const tokens = portion(free, order.percent);
      if (tokens <= 0n) {
        store.updatePosition(p.id, this.markDone(p, order));
        return { ok: true };
      }
      const copy = store.copyIncludingDeleted(p.copyId);
      const slippagePct = copy?.settings.slippagePct ?? 25;
      // (copies saved before sell fees existed fall back to their buy fees)
      const priorityFeeSol = copy?.settings.sellPriorityFeeSol ?? copy?.settings.priorityFeeSol ?? 0.0005;
      const tipSol = copy?.settings.sellTipSol ?? copy?.settings.tipSol ?? 0;
      const sentAt = this.now();
      const key = this.orderKey(p.id, order);
      const checkFirst = retry || (this.retries.get(key)?.tries ?? 0) > 0;
      // While this sell is out, its tokens are reserved: a timed step that comes due meanwhile does not ask for them.
      const mine = this.reserved.get(p.id) ?? new Map<string, bigint>();
      mine.set(key, tokens);
      this.reserved.set(p.id, mine);
      let fill: Awaited<ReturnType<Executor['sell']>>;
      try {
        fill = await executor.sell({ wallet, mint: p.mint, tokens, slippagePct, priorityFeeSol, tipSol, live: p.mode === 'live', feeBps: this.deps.feeBpsFor?.(p.userId) ?? 0, exit: live, checkFirst });
      } finally {
        mine.delete(key);
        if (!mine.size) this.reserved.delete(p.id);
      }
      if (!fill.ok) return this.sellFailed(p, order, label, fill.error, quiet);

      this.retries.delete(key);
      this.solCache.delete(owner); // the wallet's SOL just changed
      // Booked on the position as it is NOW: a timed step that landed while this sell was out has booked its own
      // tokens and SOL meanwhile, and must not be overwritten.
      const cur = store.position(p.id) ?? p;
      const base = cur.tokensHeld < held ? cur.tokensHeld : held;
      let left = base - fill.tokens;
      if (live) {
        // If the wallet now holds less than our books say (sold elsewhere), believe the wallet. A failed read
        // keeps our own figure: an RPC hiccup must not close a position.
        const after = await executor.tokenBalance(owner, p.mint).catch(() => null);
        if (after !== null && after < left) left = after;
      }
      if (left < 0n) left = 0n;
      const closed = left === 0n;
      store.updatePosition(p.id, {
        tokensHeld: left,
        proceedsLamports: cur.proceedsLamports + fill.lamports,
        ...(closed && cur.status === 'open' ? { status: 'closed' as const, closedAt: this.now() } : {}),
        ...this.markDone(cur, order),
      });
      const fillId = store.insertFill({ positionId: p.id, userId: p.userId, side: 'sell', reason: order.reason, tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n });
      const booked = fill.lamports;
      void fill.refine?.then((exact) => {
        if (!exact) return;
        const cur = store.position(p.id);
        store.updateFillLamports(fillId, exact.lamports);
        if (cur) store.updatePosition(p.id, { proceedsLamports: cur.proceedsLamports + (exact.lamports - booked) });
      }).catch(() => undefined);
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'sell', message: this.sellMessage(p, order, fill.tokens, fill.lamports, sentAt, fill.simulated, closed), mint: p.mint, signature: fill.simulated ? null : fill.signature });
      return { ok: true };
    } catch (err) {
      return this.sellFailed(p, order, label, safeErrorMessage(err), quiet);
    }
  }

  private sellFailed(p: Position, order: SellOrder, label: string, rawError: string, quiet = false): { ok: boolean; error: string } {
    const { store } = this.deps;
    const error = friendlyError(rawError);
    const why = REASON_TEXT[order.reason](order, p);
    if (order.reason === 'manual') {
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
      // One feed line per failing sell, not one per retry; one more when it turns into the slow, endless kind.
      if (tries === 1) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed: ${error} — retrying`, mint: p.mint });
      if (tries === MAX_SELL_TRIES) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `The sell of ${label} (${why}) has failed ${tries} times (${error}): still trying every ${Math.max(1, Math.round(slow / 1000))} s until it sells. Sell now works too.`, mint: p.mint });
    }
    return { ok: false, error };
  }

  // ── after a restart, and as a safety net ─────────────────────────────
  /**
   * Buys that were in flight when the server stopped. Test fills are dropped; a live one is settled by the wallet:
   * if it holds the coin, the position opens with those tokens (so its sell rules run), otherwise it failed.
   */
  async restore(): Promise<void> {
    const { store, executor } = this.deps;
    for (const p of store.openingPositions()) {
      if (this.queues.has(p.id)) continue; // still running in this process
      const label = `${shortMint(p.mint)} (${p.copyName})`;
      const wallet = this.deps.walletFor(p.userId);
      if (p.mode !== 'live' || !wallet || !executor.isLive({ live: true, exit: true })) {
        store.updatePosition(p.id, { status: 'failed', closedAt: this.now() });
        continue;
      }
      try {
        if (p.buySig && executor.settleBuy) {
          // Its own transaction says what happened: exact coins and cost, or that it failed.
          const r = await executor.settleBuy(p.buySig, wallet.publicKey.toBase58(), p.mint);
          if (r.state === 'landed') {
            const now = this.now();
            store.updatePosition(p.id, { status: 'open', tokensBought: r.tokens, tokensHeld: r.tokens, costLamports: r.lamports, refValueLamports: r.lamports, openedAt: now, lastChangeAt: now });
            store.insertFill({ positionId: p.id, userId: p.userId, side: 'buy', reason: 'copy', tokens: r.tokens, lamports: r.lamports, signature: p.buySig, simulated: false, error: null, feeLamports: 0n });
            store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'buy', message: `Bought ${fmtSol(r.lamports)} of ${label} — confirmed late (its exit starts now)`, mint: p.mint, signature: p.buySig });
          } else if (r.state === 'failed' || this.now() - p.openedAt > 90_000) {
            // Failed on chain, or not found long after its blockhash ran out: it never landed.
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
        } else {
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

  // ── plumbing ──────────────────────────────────────────────────────────
  private enqueue<T>(positionId: number, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(positionId) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => undefined);
    this.queues.set(positionId, tail);
    void tail.then(() => {
      if (this.queues.get(positionId) === tail) this.queues.delete(positionId);
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

  private stopped = false;
  /** Shutdown: retry loops end (their steps stay owed and are picked up after the restart). */
  stop(): void {
    this.stopped = true;
  }

  async idle(): Promise<void> {
    while (this.queues.size > 0 || this.loose.size > 0) await Promise.all([...this.queues.values(), ...this.loose]);
  }
}
