// Profit figures: today, the last 7 days, all time, and a day-by-day list. Realized only (closed positions;
// fees included), live and test kept apart: test profit is not money.
import type { Store } from './store.js';

export interface PnlBucket { todaySol: number; weekSol: number; allSol: number; trades: number; wins: number }
export interface PnlDay { date: string; mode: 'live' | 'test'; trades: number; wins: number; pnlSol: number }
export interface PnlSummary { live: PnlBucket; test: PnlBucket; primary: 'live' | 'test'; days: PnlDay[] }

const DAY = 86_400_000;
const sol = (lamports: bigint) => Number((Number(lamports) / 1e9).toFixed(9));

/** `tzMinutes`: the viewer's offset east of UTC, so "today" is their day. */
export function pnlSummary(store: Store, userId: number, tzMinutes: number, now = Date.now()): PnlSummary {
  const off = Math.max(-840, Math.min(840, Math.round(tzMinutes) || 0)) * 60_000;
  const today = Math.floor((now + off) / DAY);
  const empty = (): PnlBucket => ({ todaySol: 0, weekSol: 0, allSol: 0, trades: 0, wins: 0 });
  const lamports = { live: { today: 0n, week: 0n, all: 0n }, test: { today: 0n, week: 0n, all: 0n } };
  const out: PnlSummary = { live: empty(), test: empty(), primary: 'test', days: [] };
  for (const r of store.pnlByDay(userId, off)) {
    const mode = r.mode === 'live' ? 'live' : 'test';
    const b = out[mode];
    b.trades += r.trades;
    b.wins += r.wins;
    lamports[mode].all += r.pnlLamports;
    if (r.day === today) lamports[mode].today += r.pnlLamports;
    if (r.day > today - 7) lamports[mode].week += r.pnlLamports;
    out.days.push({ date: new Date(r.day * DAY).toISOString().slice(0, 10), mode, trades: r.trades, wins: r.wins, pnlSol: sol(r.pnlLamports) });
  }
  for (const mode of ['live', 'test'] as const) {
    out[mode].todaySol = sol(lamports[mode].today);
    out[mode].weekSol = sol(lamports[mode].week);
    out[mode].allSol = sol(lamports[mode].all);
  }
  out.primary = out.live.trades > 0 ? 'live' : 'test';
  return out;
}
