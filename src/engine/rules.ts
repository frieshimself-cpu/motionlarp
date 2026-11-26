// When an open position should sell, from the clock and the last price. Pure: no I/O, no clock of its own.
// "Sell when they sell" is not here: it is driven by the copied wallet's transactions (engine.ts).
import type { SellSettings } from './settings.js';

export type SellReason = 'timed' | 'stop_loss' | 'dead_coin' | 'mirror' | 'manual';

export interface SellOrder {
  reason: SellReason;
  /** Percent of the tokens held at the moment of the sell. */
  percent: number;
  /** Index of the timed sell / stop loss level that fired. */
  stage?: number;
}

export interface PositionView {
  openedAt: number;
  tokensBought: bigint;
  tokensHeld: bigint;
  costLamports: bigint;
  /** Sell value of `tokensBought` at the last quote (a price reading independent of what we still hold). */
  refValueLamports: bigint | null;
  /** Last time the quote changed (or the position opened): no change = no trades in the coin. */
  lastChangeAt: number;
  firedTimed: number[];
  firedStop: number[];
  deadFired: boolean;
  sell: SellSettings;
}

/** Loss in percent of the price paid, from the last quote; null without a quote. */
export function lossPercent(p: Pick<PositionView, 'refValueLamports' | 'costLamports'>): number | null {
  if (p.refValueLamports === null || p.costLamports <= 0n) return null;
  return (1 - Number(p.refValueLamports) / Number(p.costLamports)) * 100;
}

export function dueSells(p: PositionView, now: number): SellOrder[] {
  if (p.tokensHeld <= 0n) return [];
  const out: SellOrder[] = [];

  const timed = p.sell.timed.map((t, stage) => ({ ...t, stage })).sort((a, b) => a.afterSec - b.afterSec);
  for (const t of timed) {
    if (p.firedTimed.includes(t.stage)) continue;
    if (now >= p.openedAt + t.afterSec * 1000) out.push({ reason: 'timed', percent: t.percent, stage: t.stage });
  }

  const loss = lossPercent(p);
  if (loss !== null) {
    const levels = p.sell.stopLoss.map((l, stage) => ({ ...l, stage })).sort((a, b) => a.lossPct - b.lossPct);
    for (const l of levels) {
      if (p.firedStop.includes(l.stage)) continue;
      if (loss >= l.lossPct) out.push({ reason: 'stop_loss', percent: l.percent, stage: l.stage });
    }
  }

  if (p.sell.deadCoin.enabled && !p.deadFired && now - p.lastChangeAt >= p.sell.deadCoin.idleSec * 1000) {
    out.push({ reason: 'dead_coin', percent: 100 });
  }
  return out;
}
