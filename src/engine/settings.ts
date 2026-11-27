// A copy's settings: who to copy, how much, and when to sell. Validated on every save; errors are readable.
import { PublicKey } from '@solana/web3.js';

export interface TimedSell { afterSec: number; percent: number }
export interface StopLossLevel { lossPct: number; percent: number }

export interface SellSettings {
  /**
   * Sell when the copied wallet sells: the same share of our bag ('same'), everything on any sell ('all'), or
   * everything only once they have sold their whole bag ('exit': their partial sells are ignored).
   */
  mirror: { enabled: boolean; mode: 'same' | 'all' | 'exit' };
  /** After N seconds (counted from our own confirmed buy), sell P %. Sorted by time. */
  timed: TimedSell[];
  /**
   * What a timed sell's % is a share of. 'left': what is still held at that moment. 'bag': the tokens the buy
   * received; each step then runs on its own clock without waiting for the one before, and the last step sells
   * whatever is left in the wallet.
   */
  timedOf: 'left' | 'bag';
  /** At −L % (price per token against what we paid), sell P % of what is still held. Each fires once. */
  stopLoss: StopLossLevel[];
  /** No trades in the coin for N seconds → sell everything. */
  deadCoin: { enabled: boolean; idleSec: number };
}

export interface CopySettings {
  name: string;
  leader: string;
  enabled: boolean;
  /** 'paper' = test mode (nothing sent); 'live' sends only when the server runs with LIVE_TRADING=true. */
  mode: 'paper' | 'live';
  buySol: number;
  /** Copy only buys where the copied wallet spent at least this much SOL. */
  minLeaderBuySol: number;
  slippagePct: number;
  /** Trading fees, per transaction. Priority fee: paid to the network to be included sooner. Tip: paid to the
   *  block builder (Jito) to land sooner still; 0 = no tip. Buys and sells are set separately. */
  priorityFeeSol: number;
  tipSol: number;
  sellPriorityFeeSol: number;
  sellTipSol: number;
  /** Buy each coin at most once per copy (leaders often buy in several chunks). */
  oncePerCoin: boolean;
  sell: SellSettings;
}

export class SettingsError extends Error {}

export const LIMITS = { maxStages: 10, maxBuySol: 100, maxPriorityFeeSol: 0.1, maxTipSol: 0.5, minIdleSec: 5, maxSec: 7 * 86_400 };

export function defaultSettings(): Omit<CopySettings, 'leader'> & { leader: string } {
  return {
    name: '',
    leader: '',
    enabled: true,
    mode: 'paper',
    buySol: 0.05,
    minLeaderBuySol: 0.5,
    slippagePct: 25,
    priorityFeeSol: 0.0005,
    tipSol: 0,
    sellPriorityFeeSol: 0.0005,
    sellTipSol: 0,
    oncePerCoin: true,
    sell: {
      mirror: { enabled: true, mode: 'same' },
      timed: [],
      timedOf: 'left',
      stopLoss: [],
      deadCoin: { enabled: false, idleSec: 120 },
    },
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function number(v: unknown, fallback: number, what: string): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new SettingsError(`${what} must be a number`);
  return n;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function percent(v: unknown, what: string): number {
  const p = number(v, NaN, `${what} percent`);
  if (!(p > 0 && p <= 100)) throw new SettingsError(`${what}: the percent to sell must be above 0 and at most 100`);
  return p;
}

export function isWalletAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
}

export function validateSettings(input: unknown): CopySettings {
  const d = defaultSettings();
  const i = obj(input);
  const leader = String(i.leader ?? '').trim();
  if (!isWalletAddress(leader)) throw new SettingsError('enter the wallet address to copy (a Solana wallet address)');

  const buySol = number(i.buySol, d.buySol, 'buy amount');
  if (!(buySol > 0 && buySol <= LIMITS.maxBuySol)) throw new SettingsError(`buy amount must be above 0 and at most ${LIMITS.maxBuySol} SOL`);
  const minLeaderBuySol = number(i.minLeaderBuySol, d.minLeaderBuySol, 'minimum leader buy');
  if (!(minLeaderBuySol >= 0)) throw new SettingsError('the minimum leader buy cannot be negative');
  const slippagePct = number(i.slippagePct, d.slippagePct, 'slippage');
  if (!(slippagePct >= 0.5 && slippagePct <= 100)) throw new SettingsError('slippage must be between 0.5 % and 100 %');
  const fee = (v: unknown, fallback: number, what: string, max: number) => {
    const n = number(v, fallback, what);
    if (!(n >= 0 && n <= max)) throw new SettingsError(`${what} must be between 0 and ${max} SOL`);
    return n;
  };
  const priorityFeeSol = fee(i.priorityFeeSol, d.priorityFeeSol, 'priority fee', LIMITS.maxPriorityFeeSol);
  const tipSol = fee(i.tipSol, d.tipSol, 'tip', LIMITS.maxTipSol);
  // Sells use the buy fees unless set on their own.
  const sellPriorityFeeSol = fee(i.sellPriorityFeeSol, priorityFeeSol, 'sell priority fee', LIMITS.maxPriorityFeeSol);
  const sellTipSol = fee(i.sellTipSol, tipSol, 'sell tip', LIMITS.maxTipSol);

  const s = obj(i.sell);
  const m = obj(s.mirror);
  const mirror = { enabled: bool(m.enabled, d.sell.mirror.enabled), mode: m.mode === 'all' ? ('all' as const) : m.mode === 'exit' ? ('exit' as const) : ('same' as const) };
  const timedOf = s.timedOf === 'bag' ? ('bag' as const) : ('left' as const);

  const timedIn = Array.isArray(s.timed) ? s.timed : [];
  if (timedIn.length > LIMITS.maxStages) throw new SettingsError(`at most ${LIMITS.maxStages} timed sells`);
  const timed = timedIn.map((t, k) => {
    const o = obj(t);
    const afterSec = number(o.afterSec, NaN, `timed sell ${k + 1} seconds`);
    if (!(afterSec >= 0 && afterSec <= LIMITS.maxSec)) throw new SettingsError(`timed sell ${k + 1}: seconds must be 0 or more (at most 7 days)`);
    return { afterSec, percent: percent(o.percent, `timed sell ${k + 1}`) };
  }).sort((a, b) => a.afterSec - b.afterSec);

  const stopIn = Array.isArray(s.stopLoss) ? s.stopLoss : [];
  if (stopIn.length > LIMITS.maxStages) throw new SettingsError(`at most ${LIMITS.maxStages} stop loss levels`);
  const stopLoss = stopIn.map((t, k) => {
    const o = obj(t);
    const lossPct = number(o.lossPct, NaN, `stop loss ${k + 1} loss`);
    if (!(lossPct > 0 && lossPct < 100)) throw new SettingsError(`stop loss ${k + 1}: the loss must be between 0 % and 100 %`);
    return { lossPct, percent: percent(o.percent, `stop loss ${k + 1}`) };
  }).sort((a, b) => a.lossPct - b.lossPct);

  const dc = obj(s.deadCoin);
  const deadCoin = { enabled: bool(dc.enabled, d.sell.deadCoin.enabled), idleSec: number(dc.idleSec, d.sell.deadCoin.idleSec, 'dead coin seconds') };
  if (deadCoin.enabled && !(deadCoin.idleSec >= LIMITS.minIdleSec && deadCoin.idleSec <= LIMITS.maxSec)) {
    throw new SettingsError(`dead coin: seconds without trades must be at least ${LIMITS.minIdleSec}`);
  }

  return {
    name: String(i.name ?? '').trim().slice(0, 40) || `${leader.slice(0, 4)}…${leader.slice(-4)}`,
    leader,
    enabled: bool(i.enabled, d.enabled),
    mode: i.mode === 'live' ? 'live' : 'paper',
    buySol,
    minLeaderBuySol,
    slippagePct,
    priorityFeeSol,
    tipSol,
    sellPriorityFeeSol,
    sellTipSol,
    oncePerCoin: bool(i.oncePerCoin, d.oncePerCoin),
    sell: { mirror, timed, timedOf, stopLoss, deadCoin },
  };
}

/**
 * Ready-made copies: one click in the editor fills everything in, the buy size included (it can still be changed).
 *
 * Scharo (owner's spec, 27 Nov 2026): buy 7 SOL when this wallet buys 1 SOL or more; fees 0.001 priority + 0.005 tip
 * on buys, 0.001 + 0.001 on sells; 100 % slippage; exit on a timer from our own confirmed buy, whatever the price: 40 % of the bag at +2 s,
 * 30 % of the bag at +4 s, everything left at +6 s; sell everything at once if they sell their whole bag first;
 * no stop loss, no dead-coin exit; the same coin can be bought again once this exit has finished.
 */
export const PRESETS: { id: string; name: string; settings: Record<string, unknown> }[] = [
  {
    id: 'scharo',
    name: 'Scharo',
    settings: {
      name: 'Scharo',
      leader: 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih',
      buySol: 7,
      minLeaderBuySol: 1,
      slippagePct: 100,
      priorityFeeSol: 0.001,
      tipSol: 0.005,
      sellPriorityFeeSol: 0.001,
      sellTipSol: 0.001,
      oncePerCoin: false,
      sell: {
        mirror: { enabled: true, mode: 'exit' },
        timedOf: 'bag',
        timed: [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 30 }, { afterSec: 6, percent: 100 }],
        stopLoss: [],
        deadCoin: { enabled: false, idleSec: 120 },
      },
    },
  },
];
