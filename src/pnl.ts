// Profit figures: today, the last 7 days, all time, and a day-by-day list. Realized only (closed positions;
// fees included), live and test kept apart: test profit is not money.
import type { Store } from './store.js';

export interface PnlBucket { todaySol: number; weekSol: number; allSol: number; trades: number; wins: number }
export interface PnlDay { date: string; mode: 'live' | 'test'; trades: number; wins: number; pnlSol: number }
export interface PnlSummary { live: PnlBucket; test: PnlBucket; primary: 'live' | 'test'; days: PnlDay[] }

const DAY = 86_400_000;
const sol = (lamports: bigint) => Number((Number(lamports) / 1e9).toFixed(9));

// ── the viewer's calendar ────────────────────────────────────────────────
// Where the clocks change in spring and autumn a year has two offsets. A trade is dated by the offset its own closing
// time had, never by today's: with today's, a viewer in Berlin put the trades closed between 00:00 and 01:00 on a
// summer night on the day before, all winter long.

/** One clock per time zone, by its IANA name (they are slow to make: made once). */
const clocks = new Map<string, Intl.DateTimeFormat>();

/** The page's time zone (an IANA name such as "Europe/Berlin") when this machine knows it, else null. */
export function knownZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || zone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) return null;
  if (clocks.has(zone)) return zone;
  let clock: Intl.DateTimeFormat;
  try {
    clock = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch {
    return null;
  }
  if (clocks.size >= 1000) clocks.clear();
  clocks.set(zone, clock);
  return zone;
}

/** How far ahead of UTC the zone's clocks were at `t` (ms, to the second; 0 for a zone this machine does not know). */
export function zoneOffsetMs(zone: string, t: number): number {
  const clock = knownZone(zone) === null ? null : clocks.get(zone);
  if (!clock) return 0;
  const at = Math.floor(t / 1000) * 1000;
  const parts = clock.formatToParts(new Date(at));
  const v = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - at;
}

export interface OffsetSpan { from: number; offsetMs: number }

/** The offsets the zone's clocks had between `from` and `to`, each from the second it began, oldest first. */
export function zoneOffsets(zone: string, from: number, to: number): OffsetSpan[] {
  let cur = zoneOffsetMs(zone, from);
  const out: OffsetSpan[] = [{ from, offsetMs: cur }];
  // Clocks change a few times a year at most: look once a day, and find the very second of each change.
  for (let t = from; t < to; ) {
    const next = Math.min(t + DAY, to);
    if (zoneOffsetMs(zone, next) === cur) {
      t = next;
      continue;
    }
    let lo = Math.floor(t / 1000); // a second with the old offset
    let hi = Math.floor(next / 1000); // a second with a new one
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (zoneOffsetMs(zone, mid * 1000) === cur) lo = mid;
      else hi = mid;
    }
    cur = zoneOffsetMs(zone, hi * 1000);
    out.push({ from: hi * 1000, offsetMs: cur });
    t = hi * 1000;
  }
  return out;
}

/** What has been worked out per zone, and for which stretch of time (the past of the clocks does not change). */
const known = new Map<string, { from: number; to: number; spans: OffsetSpan[] }>();

/** The zone's offsets over the closing times from `first` to `last`: only the stretches that hold any of them. */
function offsetsOver(zone: string, first: number, last: number): OffsetSpan[] {
  let k = known.get(zone);
  if (!k || first < k.from || last > k.to) {
    // A week ahead: the page asks every few seconds, and this is worked out again once a week, not each time.
    const from = Math.min(first, k?.from ?? first);
    const to = Math.max(last, k?.to ?? last) + 7 * DAY;
    k = { from, to, spans: zoneOffsets(zone, from, to) };
    if (known.size >= 1000) known.clear();
    known.set(zone, k);
  }
  const s = k.spans;
  let i = 0;
  while (i + 1 < s.length && s[i + 1]!.from <= first) i++;
  let j = i;
  while (j + 1 < s.length && s[j + 1]!.from <= last) j++;
  return s.slice(i, j + 1);
}

/**
 * `tzMinutes`: the viewer's offset east of UTC as their page last read it, so "today" is their day. `zone`: their
 * time zone, as the page names it; with it each trade is dated by the offset its own closing time had there (a zone
 * this machine does not know, or none, falls back to tzMinutes for every trade).
 */
export function pnlSummary(store: Store, userId: number, tzMinutes: number, now = Date.now(), zone?: string | null): PnlSummary {
  const z = knownZone(zone);
  const off = Math.max(-840, Math.min(840, Math.round(tzMinutes) || 0)) * 60_000;
  const today = Math.floor((now + (z ? zoneOffsetMs(z, now) : off)) / DAY);
  const rows = z ? store.pnlByLocalDay(userId, (first, last) => offsetsOver(z, first, last)) : store.pnlByDay(userId, off);
  const empty = (): PnlBucket => ({ todaySol: 0, weekSol: 0, allSol: 0, trades: 0, wins: 0 });
  const lamports = { live: { today: 0n, week: 0n, all: 0n }, test: { today: 0n, week: 0n, all: 0n } };
  const out: PnlSummary = { live: empty(), test: empty(), primary: 'test', days: [] };
  for (const r of rows) {
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
