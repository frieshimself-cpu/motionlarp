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

/** A Map that keeps its `max` most recently used entries and forgets the rest. */
class Recent<K, V> {
  private readonly m = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
  }
  get size(): number { return this.m.size; }
}

// The caches below are shared by every page that asks, for as long as the server runs. They were keyed by the text the
// page sent: Intl takes a zone's name in any letter case and under its other names ("europe/BERLIN", "CET", "US/Pacific"),
// so a logged-in page could add a clock (about 34 kB the garbage collector barely sees) and a fresh pass over its whole
// history with every new spelling, and the server kept some 150 MB after 15,000 of them. Now each spelling is first
// turned into the zone's own name, which is what the clocks and offsets are kept under, and each cache holds a bounded
// number of the most recently used entries.

/** A spelling, in lower case (a zone's name is the same in any case), → the zone's own name, as Intl gives it. */
const names = new Recent<string, string>(1024);
/** One clock per zone, by its own name (they are slow to make). */
const clocks = new Recent<string, Intl.DateTimeFormat>(64);

/** The zone's own name for a spelling the page sent ("europe/berlin", "US/Pacific"), or null for one unknown here. */
function canonicalZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || zone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) return null;
  const key = zone.toLowerCase();
  const hit = names.get(key);
  if (hit !== undefined) return hit;
  let name: string;
  try {
    name = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  names.set(key, name);
  return name;
}

/** The page's time zone (an IANA name such as "Europe/Berlin", in any case or under another of its names) when this
 *  machine knows it, else null. */
export function knownZone(zone: unknown): string | null {
  return canonicalZone(zone) === null ? null : (zone as string);
}

/** The clock of a zone by its own name. */
function clockOf(name: string): Intl.DateTimeFormat {
  let clock = clocks.get(name);
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    clocks.set(name, clock);
  }
  return clock;
}

/** How far ahead of UTC a clock was at `t` (ms, to the second). */
function offsetBy(clock: Intl.DateTimeFormat, t: number): number {
  const at = Math.floor(t / 1000) * 1000;
  const parts = clock.formatToParts(new Date(at));
  const v = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - at;
}

/** How far ahead of UTC the zone's clocks were at `t` (ms, to the second; 0 for a zone this machine does not know). */
export function zoneOffsetMs(zone: string, t: number): number {
  const name = canonicalZone(zone);
  return name === null ? 0 : offsetBy(clockOf(name), t);
}

export interface OffsetSpan { from: number; offsetMs: number }

/** The offsets the zone's clocks had between `from` and `to`, each from the second it began, oldest first. */
export function zoneOffsets(zone: string, from: number, to: number): OffsetSpan[] {
  const name = canonicalZone(zone);
  return offsetsBetween(name === null ? null : clockOf(name), from, to);
}

/** The offsets a clock had between `from` and `to` (none known: 0 throughout). */
function offsetsBetween(clock: Intl.DateTimeFormat | null, from: number, to: number): OffsetSpan[] {
  const offset = (t: number) => (clock ? offsetBy(clock, t) : 0);
  let cur = offset(from);
  const out: OffsetSpan[] = [{ from, offsetMs: cur }];
  // Clocks change a few times a year at most: look once a day, and find the very second of each change.
  for (let t = from; t < to; ) {
    const next = Math.min(t + DAY, to);
    if (offset(next) === cur) {
      t = next;
      continue;
    }
    let lo = Math.floor(t / 1000); // a second with the old offset
    let hi = Math.floor(next / 1000); // a second with a new one
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offset(mid * 1000) === cur) lo = mid;
      else hi = mid;
    }
    cur = offset(hi * 1000);
    out.push({ from: hi * 1000, offsetMs: cur });
    t = hi * 1000;
  }
  return out;
}

/** What has been worked out per zone (by its own name), and for which stretch of time (the past of the clocks does not
 *  change). */
const known = new Recent<string, { from: number; to: number; spans: OffsetSpan[] }>(64);

/** How many entries the zone caches hold (the tests check that they stay bounded). */
export function zoneCacheSizes(): { names: number; clocks: number; offsets: number } {
  return { names: names.size, clocks: clocks.size, offsets: known.size };
}

/** The zone's offsets over the closing times from `first` to `last`: only the stretches that hold any of them.
 *  `zone`: the zone's own name. */
function offsetsOver(zone: string, first: number, last: number): OffsetSpan[] {
  let k = known.get(zone);
  if (!k || first < k.from || last > k.to) {
    // A week ahead: the page asks every few seconds, and this is worked out again once a week, not each time.
    const from = Math.min(first, k?.from ?? first);
    const to = Math.max(last, k?.to ?? last) + 7 * DAY;
    k = { from, to, spans: offsetsBetween(clockOf(zone), from, to) };
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
  const z = canonicalZone(zone);
  const off = Math.max(-840, Math.min(840, Math.round(tzMinutes) || 0)) * 60_000;
  const today = Math.floor((now + (z ? offsetBy(clockOf(z), now) : off)) / DAY);
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
