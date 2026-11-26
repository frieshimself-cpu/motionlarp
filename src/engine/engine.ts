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
}

/** An automatic sell that fails is retried after these pauses, then given up (Sell now stays available). */
const RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000];
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
    const staleSec = this.deps.staleSec ?? 60;
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
        const percent = p.sell.mirror.mode === 'all' || share >= 0.995 ? 100 : share * 100;
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
    if (t.solLamports < minLamports) return skip(`they bought ${fmtSol(t.solLamports)}, under your ${fmtSol(minLamports)} minimum`);
    if (store.activePosition(copy.id, t.mint)) return skip('already holding this coin');
    if (s.oncePerCoin && store.hasTraded(copy.id, t.mint)) return skip('already traded this coin (buy once per coin is on)');
    const maxBuy = typeof this.deps.maxSolPerBuy === 'function' ? this.deps.maxSolPerBuy() : this.deps.maxSolPerBuy;
    if (s.buySol > maxBuy) return skip(`${s.buySol} SOL is above the server limit of ${maxBuy} SOL per buy`);
    const wallet = this.deps.walletFor(copy.userId);
    if (!wallet) return skip('no wallet imported yet');

    const id = store.insertPosition({ userId: copy.userId, copyId: copy.id, mint: t.mint, mode: s.mode, leaderSig: t.signature, sell: s.sell, copyName: s.name, leader: t.leader, now: this.now() });
    return this.enqueue(id, () => this.buy(id, copy, wallet, t));
  }

  private async buy(id: number, copy: CopyRow, wallet: Keypair, t: LeaderTrade): Promise<void> {
    const { store, executor } = this.deps;
    const s = copy.settings;
    const lamports = BigInt(Math.round(s.buySol * 1e9));
    const label = `${shortMint(t.mint)} (${s.name})`;
    try {
      const feeBps = this.deps.feeBpsFor?.(copy.userId) ?? 0;
      if (executor.isLive({ live: s.mode === 'live' })) {
        const platformFee = (lamports * BigInt(Math.floor(feeBps))) / 10_000n;
        const need = lamports + platformFee + BigInt(Math.round(this.deps.feeReserveSol * 1e9));
        const have = await this.solBalance(wallet.publicKey.toBase58());
        if (have < need) {
          store.updatePosition(id, { status: 'failed', closedAt: this.now() });
          store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'skip', message: `Skipped ${label}: wallet has ${fmtSol(have)}, needs ${fmtSol(need)} (buy${platformFee > 0n ? ' + platform fee' : ''} + fee reserve)`, mint: t.mint, signature: t.signature });
          return;
        }
      }
      const fill = await executor.buy({ wallet, mint: t.mint, lamports, slippagePct: s.slippagePct, priorityFeeSol: s.priorityFeeSol, tipSol: s.tipSol ?? 0, live: s.mode === 'live', feeBps });
      if (!fill.ok) {
        store.updatePosition(id, { status: 'failed', closedAt: this.now() });
        store.insertFill({ positionId: id, userId: copy.userId, side: 'buy', reason: 'copy', tokens: 0n, lamports, signature: null, simulated: false, error: fill.error });
        store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label} failed: ${friendlyError(fill.error)}`, mint: t.mint, signature: t.signature });
        return;
      }
      const now = this.now();
      this.solCache.delete(wallet.publicKey.toBase58());
      // The position is live only if the buy really went on-chain (a copy flipped to Live on a test server is paper).
      store.updatePosition(id, { mode: fill.simulated ? 'paper' : 'live', status: 'open', tokensBought: fill.tokens, tokensHeld: fill.tokens, costLamports: fill.lamports, openedAt: now, lastChangeAt: now, refValueLamports: fill.lamports, buySig: fill.signature });
      store.insertFill({ positionId: id, userId: copy.userId, side: 'buy', reason: 'copy', tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n });
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
      this.run(view.id, order);
    }
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
    return this.enqueue(positionId, () => this.sell(positionId, { reason: 'manual', percent: 100 }));
  }

  private markDone(p: Position, order: SellOrder): Partial<Pick<Position, 'firedTimed' | 'firedStop' | 'deadFired'>> {
    if (order.reason === 'timed' && order.stage !== undefined) return { firedTimed: [...new Set([...p.firedTimed, order.stage])] };
    if (order.reason === 'stop_loss' && order.stage !== undefined) return { firedStop: [...new Set([...p.firedStop, order.stage])] };
    if (order.reason === 'dead_coin') return { deadFired: true };
    return {};
  }

  private async sell(positionId: number, order: SellOrder): Promise<{ ok: boolean; error?: string }> {
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
    if (live && !executor.isLive({ live: true })) {
      return this.sellFailed(p, order, label, 'the server is in test mode: a live position can only be sold once LIVE_TRADING is back on');
    }
    try {
      // Live: this position's own tokens, never more than the wallet really holds (other copies or coins the user
      // holds by hand in the same wallet are not touched).
      const onChain = live ? await executor.tokenBalance(owner, p.mint) : p.tokensHeld;
      const held = onChain < p.tokensHeld ? onChain : p.tokensHeld;
      if (held <= 0n) {
        store.updatePosition(p.id, { status: 'closed', tokensHeld: 0n, closedAt: this.now(), ...this.markDone(p, order) });
        store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'info', message: `${label}: the wallet holds none of it any more (sold elsewhere?) — closed`, mint: p.mint });
        return { ok: true };
      }
      const tokens = portion(held, order.percent);
      if (tokens <= 0n) {
        store.updatePosition(p.id, this.markDone(p, order));
        return { ok: true };
      }
      const copy = store.copy(p.copyId);
      const slippagePct = copy?.settings.slippagePct ?? 25;
      // (copies saved before sell fees existed fall back to their buy fees)
      const priorityFeeSol = copy?.settings.sellPriorityFeeSol ?? copy?.settings.priorityFeeSol ?? 0.0005;
      const tipSol = copy?.settings.sellTipSol ?? copy?.settings.tipSol ?? 0;
      const fill = await executor.sell({ wallet, mint: p.mint, tokens, slippagePct, priorityFeeSol, tipSol, live: p.mode === 'live', feeBps: this.deps.feeBpsFor?.(p.userId) ?? 0 });
      if (!fill.ok) return this.sellFailed(p, order, label, fill.error);

      this.retries.delete(this.orderKey(p.id, order));
      let left = held - fill.tokens;
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
        proceedsLamports: p.proceedsLamports + fill.lamports,
        ...(closed ? { status: 'closed' as const, closedAt: this.now() } : {}),
        ...this.markDone(p, order),
      });
      store.insertFill({ positionId: p.id, userId: p.userId, side: 'sell', reason: order.reason, tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null, feeLamports: fill.feeLamports ?? 0n });
      const what = order.percent >= 100 ? 'all' : fmtPct(order.percent);
      store.addEvent({
        userId: p.userId, copyId: p.copyId, kind: 'sell',
        message: `Sold ${what} of ${label} for ${fmtSol(fill.lamports)} — ${REASON_TEXT[order.reason](order, p)}${fill.simulated ? ' (test)' : ''}${closed ? '. Position closed.' : ''}`,
        mint: p.mint, signature: fill.simulated ? null : fill.signature,
      });
      return { ok: true };
    } catch (err) {
      return this.sellFailed(p, order, label, safeErrorMessage(err));
    }
  }

  private sellFailed(p: Position, order: SellOrder, label: string, rawError: string): { ok: boolean; error: string } {
    const { store } = this.deps;
    const error = friendlyError(rawError);
    const why = REASON_TEXT[order.reason](order, p);
    if (order.reason === 'manual') {
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed: ${error}`, mint: p.mint });
      return { ok: false, error };
    }
    const key = this.orderKey(p.id, order);
    const tries = (this.retries.get(key)?.tries ?? 0) + 1;
    if (tries >= MAX_SELL_TRIES) {
      this.retries.delete(key);
      store.updatePosition(p.id, this.markDone(p, order));
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Gave up on the ${why} of ${label} after ${tries} failed tries: ${error}. Use Sell now.`, mint: p.mint });
    } else {
      const wait = RETRY_MS[tries - 1]!;
      this.retries.set(key, { positionId: p.id, order, tries, nextAt: this.now() + wait });
      // One feed line per failing sell, not one per retry.
      if (tries === 1) store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed: ${error} — retrying`, mint: p.mint });
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
      if (p.mode !== 'live' || !wallet || !executor.isLive({ live: true })) {
        store.updatePosition(p.id, { status: 'failed', closedAt: this.now() });
        continue;
      }
      try {
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
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }
}
