// The copytrader. Reacts to followed wallets' trades (buys → copy buys, sells → "sell when they sell") and to the
// clock (timed sells, stop loss levels, dead coin). Every decision, copied or skipped, lands in the user's feed.
//
// Each position has one queue: its buy and all its sells run one after another, so two sells never race and each
// one sells its percent of what is left at that moment.
import type { Keypair } from '@solana/web3.js';
import { lamportsToSol } from '../config.js';
import { log, safeErrorMessage } from '../log.js';
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
  maxSolPerBuy: number;
  feeReserveSol: number;
  /** Leader trades older than this are not copied (e.g. caught up after downtime). */
  staleSec?: number;
}

const MAX_SELL_TRIES = 3;
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
  private readonly failures = new Map<string, number>();
  private readonly lastQuoteAt = new Map<number, number>();
  private readonly quoteOkAt = new Map<number, number>();

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── leader trades ─────────────────────────────────────────────────────
  async onLeaderTrade(t: LeaderTrade): Promise<void> {
    const staleSec = this.deps.staleSec ?? 60;
    if (t.blockTime && this.now() / 1000 - t.blockTime > staleSec) return;
    if (!this.deps.store.markSeen(`${t.signature}:${t.mint}`)) return;
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
        jobs.push(this.enqueue(p.id, () => this.sell(p.id, { reason: 'mirror', percent })));
      }
    }
    await Promise.all(jobs);
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
    if (s.buySol > this.deps.maxSolPerBuy) return skip(`${s.buySol} SOL is above the server limit of ${this.deps.maxSolPerBuy} SOL per buy`);
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
      if (executor.isLive({ live: s.mode === 'live' })) {
        const need = lamports + BigInt(Math.round(this.deps.feeReserveSol * 1e9));
        const have = await executor.solBalance(wallet.publicKey.toBase58());
        if (have < need) {
          store.updatePosition(id, { status: 'failed', closedAt: this.now() });
          store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'skip', message: `Skipped ${label}: wallet has ${fmtSol(have)}, needs ${fmtSol(need)} (buy + fee reserve)`, mint: t.mint, signature: t.signature });
          return;
        }
      }
      const fill = await executor.buy({ wallet, mint: t.mint, lamports, slippagePct: s.slippagePct, priorityFeeSol: s.priorityFeeSol, live: s.mode === 'live' });
      if (!fill.ok) {
        store.updatePosition(id, { status: 'failed', closedAt: this.now() });
        store.insertFill({ positionId: id, userId: copy.userId, side: 'buy', reason: 'copy', tokens: 0n, lamports, signature: null, simulated: false, error: fill.error });
        store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label} failed: ${fill.error}`, mint: t.mint, signature: t.signature });
        return;
      }
      const now = this.now();
      store.updatePosition(id, { status: 'open', tokensBought: fill.tokens, tokensHeld: fill.tokens, costLamports: fill.lamports, openedAt: now, lastChangeAt: now, refValueLamports: fill.lamports, buySig: fill.signature });
      store.insertFill({ positionId: id, userId: copy.userId, side: 'buy', reason: 'copy', tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null });
      store.addEvent({
        userId: copy.userId, copyId: copy.id, kind: 'buy',
        message: `Bought ${fmtSol(fill.lamports)} of ${label} — they bought ${fmtSol(t.solLamports)}${fill.simulated ? ' (test)' : ''}`,
        mint: t.mint, signature: fill.simulated ? null : fill.signature,
      });
    } catch (err) {
      store.updatePosition(id, { status: 'failed', closedAt: this.now() });
      store.addEvent({ userId: copy.userId, copyId: copy.id, kind: 'error', message: `Buy of ${label} failed: ${safeErrorMessage(err)}`, mint: t.mint });
    }
  }

  // ── the clock ─────────────────────────────────────────────────────────
  async tick(): Promise<void> {
    const positions = this.deps.store.activePositions().filter((p) => p.status === 'open');
    await Promise.all(positions.map((p) => this.tickOne(p)));
  }

  private async tickOne(p: Position): Promise<void> {
    const now = this.now();
    let view = p;
    if (now - (this.lastQuoteAt.get(p.id) ?? 0) >= this.deps.priceMs) {
      this.lastQuoteAt.set(p.id, now);
      try {
        const value = await this.deps.executor.quoteSell(p.mint, p.tokensBought);
        this.quoteOkAt.set(p.id, this.now());
        if (value !== p.refValueLamports) {
          this.deps.store.updatePosition(p.id, { refValueLamports: value, lastChangeAt: now });
          view = { ...p, refValueLamports: value, lastChangeAt: now };
        }
      } catch (err) {
        log.debug('quote failed', { position: p.id, error: safeErrorMessage(err) });
      }
    }
    for (const order of dueSells(view, now)) {
      if (order.reason === 'dead_coin' && now - (this.quoteOkAt.get(p.id) ?? 0) > QUOTE_FRESH_MS) continue;
      const key = `${p.id}:${order.reason}:${order.stage ?? ''}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      void this.enqueue(p.id, () => this.sell(p.id, order)).finally(() => this.inFlight.delete(key));
    }
  }

  // ── selling ───────────────────────────────────────────────────────────
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
    const live = executor.isLive({ live: p.mode === 'live' });
    try {
      const held = live ? await executor.tokenBalance(owner, p.mint) : p.tokensHeld;
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
      const priorityFeeSol = copy?.settings.priorityFeeSol ?? 0.0005;
      const fill = await executor.sell({ wallet, mint: p.mint, tokens, slippagePct, priorityFeeSol, live: p.mode === 'live' });
      if (!fill.ok) return this.sellFailed(p, order, label, fill.error);

      this.failures.delete(`${p.id}:${order.reason}:${order.stage ?? ''}`);
      let left = live ? await executor.tokenBalance(owner, p.mint) : held - fill.tokens;
      if (left < 0n) left = 0n;
      const closed = left === 0n;
      store.updatePosition(p.id, {
        tokensHeld: left,
        proceedsLamports: p.proceedsLamports + fill.lamports,
        ...(closed ? { status: 'closed' as const, closedAt: this.now() } : {}),
        ...this.markDone(p, order),
      });
      store.insertFill({ positionId: p.id, userId: p.userId, side: 'sell', reason: order.reason, tokens: fill.tokens, lamports: fill.lamports, signature: fill.signature, simulated: fill.simulated, error: null });
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

  private sellFailed(p: Position, order: SellOrder, label: string, error: string): { ok: boolean; error: string } {
    const { store } = this.deps;
    const why = REASON_TEXT[order.reason](order, p);
    if (order.reason === 'mirror' || order.reason === 'manual') {
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed: ${error}`, mint: p.mint });
      return { ok: false, error };
    }
    const key = `${p.id}:${order.reason}:${order.stage ?? ''}`;
    const tries = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, tries);
    if (tries >= MAX_SELL_TRIES) {
      this.failures.delete(key);
      store.updatePosition(p.id, this.markDone(p, order));
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Gave up on the ${why} of ${label} after ${tries} failed tries: ${error}`, mint: p.mint });
    } else {
      store.addEvent({ userId: p.userId, copyId: p.copyId, kind: 'error', message: `Sell of ${label} (${why}) failed, retrying: ${error}`, mint: p.mint });
    }
    return { ok: false, error };
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
