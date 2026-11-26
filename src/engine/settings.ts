// A copy's settings: who to copy, how much, and when to sell. Validated on every save; errors are readable.
import { PublicKey } from '@solana/web3.js';

export interface TimedSell { afterSec: number; percent: number }
export interface StopLossLevel { lossPct: number; percent: number }

export interface SellSettings {
  /** Sell when the copied wallet sells: the same share of our bag ('same') or everything ('all'). */
  mirror: { enabled: boolean; mode: 'same' | 'all' };
  /** After N seconds, sell P % of what is still held. Sorted by time. */
  timed: TimedSell[];
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
  priorityFeeSol: number;
  /** Buy each coin at most once per copy (leaders often buy in several chunks). */
  oncePerCoin: boolean;
  sell: SellSettings;
}

export class SettingsError extends Error {}

export const LIMITS = { maxStages: 10, maxBuySol: 100, maxPriorityFeeSol: 0.1, minIdleSec: 5, maxSec: 7 * 86_400 };

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
    oncePerCoin: true,
    sell: {
      mirror: { enabled: true, mode: 'same' },
      timed: [],
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
  const priorityFeeSol = number(i.priorityFeeSol, d.priorityFeeSol, 'priority fee');
  if (!(priorityFeeSol >= 0 && priorityFeeSol <= LIMITS.maxPriorityFeeSol)) throw new SettingsError(`priority fee must be between 0 and ${LIMITS.maxPriorityFeeSol} SOL`);

  const s = obj(i.sell);
  const m = obj(s.mirror);
  const mirror = { enabled: bool(m.enabled, d.sell.mirror.enabled), mode: m.mode === 'all' ? ('all' as const) : ('same' as const) };

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
    oncePerCoin: bool(i.oncePerCoin, d.oncePerCoin),
    sell: { mirror, timed, stopLoss, deadCoin },
  };
}
