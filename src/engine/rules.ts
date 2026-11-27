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
  /** Distinguishes two orders of the same kind (e.g. the leader selling twice). */
  tag?: string;
  /** 'bag': the percent is a share of the tokens the buy received, not of what is held now. */
  basis?: 'bag';
  /** Sell whatever is in the wallet (the last step of a bag-based timed exit). */
  everything?: boolean;
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
  const ofBag = p.sell.timedOf === 'bag';
  const lastStage = timed[timed.length - 1]?.stage;
  for (const t of timed) {
    if (p.firedTimed.includes(t.stage)) continue;
    if (now < p.openedAt + t.afterSec * 1000) continue;
    if (!ofBag) out.push({ reason: 'timed', percent: t.percent, stage: t.stage });
    // Of the bag: every step runs on its own clock; the last one empties the wallet whatever its percent says.
    else out.push({ reason: 'timed', percent: t.percent, stage: t.stage, basis: 'bag', ...(t.stage === lastStage ? { everything: true } : {}) });
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
