import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { pnlSummary } from '../src/pnl.js';
import { validateSettings } from '../src/engine/settings.js';

const LEADER = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
const SOL = 1_000_000_000n;

function setup() {
  const store = new Store(':memory:');
  const u = store.createUser('a', 'x');
  const s = validateSettings({ leader: LEADER, buySol: 0.1 });
  const copy = store.createCopy(u, s);
  const close = (mode: 'paper' | 'live', closedAt: number, cost: bigint, proceeds: bigint) => {
    const id = store.insertPosition({ userId: u, copyId: copy, mint: `m${Math.random()}`, mode, leaderSig: 'x', sell: s.sell, copyName: 'c', leader: LEADER, now: closedAt - 60_000 });
    store.updatePosition(id, { mode, status: 'closed', costLamports: cost, proceedsLamports: proceeds, closedAt });
  };
  return { store, u, close };
}

// "Now" is 2026-11-27 01:30 UTC. For someone at UTC−5 that is still 26 Nov, 20:30.
const NOW = Date.UTC(2026, 10, 27, 1, 30);

describe('profit by day', () => {
  it('today, the last 7 days and all time, live and test apart', () => {
    const { store, u, close } = setup();
    close('live', Date.UTC(2026, 10, 27, 0, 10), SOL, SOL + SOL / 2n); // today (UTC): +0.5
    close('live', Date.UTC(2026, 10, 26, 22, 0), SOL, SOL / 2n); // yesterday (UTC): −0.5
    close('live', Date.UTC(2026, 10, 1, 12, 0), SOL, 3n * SOL); // weeks ago: +2
    close('paper', Date.UTC(2026, 10, 27, 1, 0), SOL, SOL + SOL / 10n); // test, today: +0.1
    const p = pnlSummary(store, u, 0, NOW);
    expect(p.live).toMatchObject({ todaySol: 0.5, weekSol: 0, allSol: 2, trades: 3, wins: 2 });
    expect(p.test).toMatchObject({ todaySol: 0.1, allSol: 0.1, trades: 1, wins: 1 });
    expect(p.primary).toBe('live');
  });

  it('"today" follows the viewer\'s clock, not the server\'s', () => {
    const { store, u, close } = setup();
    close('live', Date.UTC(2026, 10, 27, 0, 10), SOL, SOL + SOL / 2n);
    close('live', Date.UTC(2026, 10, 26, 22, 0), SOL, SOL / 2n);
    // At UTC−5 both closed on 26 Nov local, which is still "today" there.
    expect(pnlSummary(store, u, -300, NOW).live.todaySol).toBe(0);
    expect(pnlSummary(store, u, 0, NOW).live.todaySol).toBe(0.5);
  });

  it('the daily list: newest first, one row per day and mode', () => {
    const { store, u, close } = setup();
    close('live', Date.UTC(2026, 10, 27, 0, 10), SOL, SOL + SOL / 2n);
    close('live', Date.UTC(2026, 10, 27, 0, 50), SOL, SOL / 2n);
    close('live', Date.UTC(2026, 10, 25, 9, 0), SOL, 2n * SOL);
    const p = pnlSummary(store, u, 0, NOW);
    expect(p.days.filter((d) => d.mode === 'live')).toEqual([
      { date: '2026-11-27', mode: 'live', trades: 2, wins: 1, pnlSol: 0 },
      { date: '2026-11-25', mode: 'live', trades: 1, wins: 1, pnlSol: 1 },
    ]);
  });

  it('only test trades: test is what the cards show', () => {
    const { store, u, close } = setup();
    close('paper', NOW - 1000, SOL, SOL + SOL / 10n);
    expect(pnlSummary(store, u, 0, NOW).primary).toBe('test');
  });
});

// Finding B17 (the every-button test, and two reviews after it): the page sent one fixed offset, today's, and every
// trade was moved by it. Across a change of the clocks, a trade closed in the hour the clocks moved went to the wrong
// day. Now the page also names its time zone, and each trade is dated by the offset its own closing time had there.
describe('days across a change of the clocks', () => {
  const DAY = 86_400_000;
  // 27 Nov 2026. Since then the clocks went back in Berlin (25 Oct, +2 → +1) and in Los Angeles (1 Nov, −7 → −8), and
  // forward in Auckland (27 Sep, +12 → +13).
  const NOV27 = Date.UTC(2026, 10, 27, 12, 0);
  const liveDays = (p: ReturnType<typeof pnlSummary>) => p.days.filter((d) => d.mode === 'live').map((d) => d.date);
  /** The date a person in `zone` reads off their own calendar at `t`. */
  const localDate = (zone: string, t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  /** What the page sends as "tz": the offset of the viewer's clock at that moment, in minutes east of UTC. */
  const pageOffset = (zone: string, t: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t));
    const v = (k: string) => Number(p.find((x) => x.type === k)!.value);
    return Math.round((Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute')) - Math.floor(t / 60_000) * 60_000) / 60_000);
  };

  it('Berlin: a trade closed at 22:30 UTC on 18 October closed on the 19th there (00:30, summer time)', () => {
    const { store, u, close } = setup();
    close('live', Date.UTC(2026, 9, 18, 22, 30), SOL, 2n * SOL);
    expect(liveDays(pnlSummary(store, u, 60, NOV27, 'Europe/Berlin'))).toEqual(['2026-10-19']);
  });

  it('Los Angeles: a trade closed at 07:30 UTC on 25 October closed on the 25th there (00:30, summer time)', () => {
    const { store, u, close } = setup();
    close('live', Date.UTC(2026, 9, 25, 7, 30), SOL, 2n * SOL);
    expect(liveDays(pnlSummary(store, u, -480, NOV27, 'America/Los_Angeles'))).toEqual(['2026-10-25']);
  });

  it('Auckland: a trade closed at 11:30 UTC on 20 September closed on the 20th there (23:30, winter time)', () => {
    const { store, u, close } = setup();
    close('live', Date.UTC(2026, 8, 20, 11, 30), SOL, 2n * SOL);
    expect(liveDays(pnlSummary(store, u, 780, NOV27, 'Pacific/Auckland'))).toEqual(['2026-09-20']);
  });

  it('trades on both sides of a change: each by its own offset, one row per day', () => {
    const { store, u, close } = setup();
    close('live', Date.UTC(2026, 9, 18, 22, 30), SOL, 2n * SOL); // 19 Oct 00:30 in Berlin (+2)
    close('live', Date.UTC(2026, 9, 19, 21, 30), SOL, SOL / 2n); // 19 Oct 23:30 (+2)
    close('live', Date.UTC(2026, 9, 25, 0, 30), SOL, SOL); // 25 Oct 02:30, before the change at 01:00 UTC (+2)
    close('live', Date.UTC(2026, 9, 25, 23, 30), SOL, SOL); // 26 Oct 00:30 (+1)
    close('paper', Date.UTC(2026, 10, 26, 23, 10), SOL, SOL); // 27 Nov 00:10 (+1): today
    const p = pnlSummary(store, u, 60, NOV27, 'Europe/Berlin');
    expect(p.days.map((d) => [d.date, d.mode, d.trades])).toEqual([['2026-11-27', 'test', 1], ['2026-10-26', 'live', 1], ['2026-10-25', 'live', 1], ['2026-10-19', 'live', 2]]);
    expect(p.test.todaySol).toBe(0);
    expect(p.test.trades).toBe(1);
  });

  it('the days match the viewer\'s own calendar whatever the hour the page is opened (Berlin, Los Angeles, Auckland)', () => {
    for (const zone of ['Europe/Berlin', 'America/Los_Angeles', 'Pacific/Auckland']) {
      for (let h = 0; h < 24; h++) {
        const now = Date.UTC(2026, 10, 27, h, 20);
        const { store, u, close } = setup();
        const want = new Map<string, number>();
        // As the browser suite's seed places them: at the clock time of the moment it runs, days and weeks back, and a
        // little before.
        for (const daysAgo of [0, 1, 2, 6, 7, 9, 25, 26, 27, 32, 33, 34, 40, 45, 60, 61, 62, 63]) {
          for (const minutes of [0, 15, 45, 75]) {
            const t = now - daysAgo * DAY - minutes * 60_000;
            close('live', t, SOL, SOL + 1n);
            want.set(localDate(zone, t), (want.get(localDate(zone, t)) ?? 0) + 1);
          }
        }
        const p = pnlSummary(store, u, pageOffset(zone, now), now, zone);
        const got = p.days.map((d) => [d.date, d.trades]);
        expect(got, `${zone}, the page opened at ${String(h).padStart(2, '0')}:20 UTC`).toEqual([...want].sort((a, b) => (a[0] < b[0] ? 1 : -1)));
        const today = localDate(zone, now);
        expect(p.live.todaySol, `${zone} at ${h}:20 UTC: today`).toBeCloseTo((want.get(today) ?? 0) * 1e-9, 12);
      }
    }
  });

  it('a time zone this machine does not know falls back to the offset the page sent', () => {
    const { store, u, close } = setup();
    close('live', Date.UTC(2026, 9, 18, 22, 30), SOL, 2n * SOL);
    for (const zone of ['Mars/Olympus', '', '../../etc', 'Europe/Berlin; DROP TABLE positions', 'x'.repeat(300)]) {
      expect(liveDays(pnlSummary(store, u, 60, NOV27, zone)), JSON.stringify(zone)).toEqual(['2026-10-18']);
    }
    expect(liveDays(pnlSummary(store, u, 60, NOV27))).toEqual(['2026-10-18']);
  });
});

// Third review (finding N4): what only the reviewers' own probes covered. Zones whose offset is not a whole hour (:45,
// :30, and a change of the clocks by 30 minutes), the exact second of a change (and of the local midnights around it,
// where a day is 23 or 25 hours long, or starts at 01:00), and the offsets cache reaching back for an account older than
// the one that asked first. Each trade's day is checked against the date Intl itself prints for its closing time.
describe('days in zones of quarter and half hours, at the exact second of a change, and for an older account', () => {
  const S = 1000;
  const localDate = (zone: string, t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  /** Trades closed at `times`, viewed from `zone` at `now`: the days listed, and the days Intl puts them on. */
  const check = (zone: string, times: number[], now: number) => {
    const { store, u, close } = setup();
    for (const t of times) close('live', t, SOL, SOL + 1n);
    const want = new Map<string, number>();
    for (const t of times) want.set(localDate(zone, t), (want.get(localDate(zone, t)) ?? 0) + 1);
    const p = pnlSummary(store, u, 0, now, zone);
    expect(p.days.map((d) => [d.date, d.trades]), zone).toEqual([...want].sort((a, b) => (a[0] < b[0] ? 1 : -1)));
    return { p, want };
  };

  it('Kathmandu (UTC+5:45): 18:14:59 UTC is 23:59:59 on the 26th there, 18:15:00 UTC is already the 27th', () => {
    const before = Date.UTC(2026, 10, 26, 18, 14, 59);
    const { p } = check('Asia/Kathmandu', [before, before + S, before - 6 * 3_600_000, before + 6 * 3_600_000], Date.UTC(2026, 10, 27, 12, 0));
    expect(p.days.map((d) => d.date)).toEqual(['2026-11-27', '2026-11-26']);
    expect(p.live.todaySol).toBe(2e-9); // the two of the 27th
  });

  it('Chatham (UTC+12:45, +13:45 in summer) and St John\'s (UTC−3:30, −2:30 in summer), around each change of 2026 and its midnights', () => {
    for (const [zone, changes] of [['Pacific/Chatham', [Date.UTC(2026, 3, 4, 14), Date.UTC(2026, 8, 26, 14)]], ['America/St_Johns', [Date.UTC(2026, 2, 8, 5, 30), Date.UTC(2026, 10, 1, 4, 30)]]] as const) {
      const times: number[] = [];
      for (const c of changes) for (const d of [-25, -24, -23, -13, -12, -11, -1, 0, 1, 11, 12, 13, 23, 24, 25]) for (const s of [-1, 0, 1]) times.push(c + d * 3_600_000 + s * S);
      check(zone, times, Date.UTC(2026, 10, 27, 12, 0));
    }
  });

  it('Lord Howe Island (clocks move by 30 minutes): the second before and the second of each change, and the midnights next to it', () => {
    const zone = 'Australia/Lord_Howe';
    // 4 Apr 15:00 UTC: 02:00 at +11 becomes 01:30 at +10:30. 3 Oct 15:30 UTC: 02:00 at +10:30 becomes 02:30 at +11.
    const times: number[] = [];
    for (const c of [Date.UTC(2026, 3, 4, 15, 0), Date.UTC(2026, 9, 3, 15, 30)]) {
      for (const d of [-1, 0, 1]) times.push(c + d * S);
      // The local midnights before and after, each by the offset it had (13:00 or 13:30 UTC), to the second.
      for (const m of [c - 2 * 3_600_000, c - 2.5 * 3_600_000, c + 22 * 3_600_000, c + 21.5 * 3_600_000]) for (const d of [-1, 0, 1]) times.push(m + d * S);
    }
    const { want } = check(zone, times, Date.UTC(2026, 10, 27, 12, 0));
    expect(want.size).toBeGreaterThanOrEqual(5);
  });

  it('the exact second of a change: Berlin (the hour from 02:00 comes twice) and Santiago (the change is at midnight)', () => {
    // Berlin, 25 Oct 01:00 UTC: 03:00 summer time becomes 02:00 winter time; 23:00 UTC that evening is midnight.
    const berlin = Date.UTC(2026, 9, 25, 1, 0);
    const { p: pb } = check('Europe/Berlin', [berlin - S, berlin, berlin + S, Date.UTC(2026, 9, 24, 21, 59, 59), Date.UTC(2026, 9, 24, 22), Date.UTC(2026, 9, 25, 22, 59, 59), Date.UTC(2026, 9, 25, 23)], Date.UTC(2026, 9, 25, 12));
    expect(pb.days.map((d) => [d.date, d.trades])).toEqual([['2026-10-26', 1], ['2026-10-25', 5], ['2026-10-24', 1]]);
    // Santiago, 5 Apr 03:00 UTC: midnight at −3 becomes 23:00 of the 4th at −4 (the hour before midnight comes twice);
    // 6 Sep 04:00 UTC: midnight at −4 becomes 01:00 of the 6th at −3 (the 6th starts at 01:00).
    const apr = Date.UTC(2026, 3, 5, 3, 0);
    const sep = Date.UTC(2026, 8, 6, 4, 0);
    const { p: ps } = check('America/Santiago', [apr - S, apr, apr + 3_600_000 - S, apr + 3_600_000, sep - S, sep, sep + S], Date.UTC(2026, 10, 27, 12, 0));
    expect(ps.days.map((d) => [d.date, d.trades])).toEqual([['2026-09-06', 2], ['2026-09-05', 1], ['2026-04-05', 1], ['2026-04-04', 3]]);
    // "Today", asked at the second before and the second of the change, by a page whose offset is stale (0): the zone
    // decides, at the second (the trade of 23:59:59 on the 5th is today until midnight, which is 01:00 on the 6th).
    const { store, u, close } = setup();
    close('live', sep - S, SOL, 2n * SOL);
    expect(pnlSummary(store, u, 0, sep - S, 'America/Santiago').live.todaySol).toBe(1);
    expect(pnlSummary(store, u, 0, sep, 'America/Santiago').live.todaySol).toBe(0);
  });

  it('an account older than the one whose page asked first: the offsets are worked out back to its first trade', () => {
    const zone = 'Europe/Paris'; // asked by no other test here: the cache starts with the newer account
    const { store, close } = setup();
    const newer = store.createUser('newer', 'x');
    const newerCopy = store.createCopy(newer, validateSettings({ leader: LEADER, buySol: 0.1 }));
    const closeFor = (uid: number, copy: number, t: number) => {
      const id = store.insertPosition({ userId: uid, copyId: copy, mint: `m${Math.random()}`, mode: 'live', leaderSig: 'x', sell: validateSettings({ leader: LEADER, buySol: 0.1 }).sell, copyName: 'c', leader: LEADER, now: t - 60_000 });
      store.updatePosition(id, { mode: 'live', status: 'closed', costLamports: SOL, proceedsLamports: 2n * SOL, closedAt: t });
    };
    closeFor(newer, newerCopy, Date.UTC(2026, 10, 20, 23, 30)); // 21 Nov 00:30 in Paris (winter time)
    const now = Date.UTC(2026, 10, 27, 12, 0);
    expect(pnlSummary(store, newer, 60, now, zone).days.map((d) => d.date)).toEqual(['2026-11-21']);
    // The older account (the store's first user), with trades in summer time and before the change of March.
    close('live', Date.UTC(2026, 6, 14, 22, 30), SOL, 2n * SOL); // 15 Jul 00:30 (summer time)
    close('live', Date.UTC(2026, 2, 28, 23, 30), SOL, 2n * SOL); // 29 Mar 00:30, before the change at 01:00 UTC
    close('live', Date.UTC(2025, 9, 25, 22, 30), SOL, 2n * SOL); // 26 Oct 2025 00:30 (summer time, a year before)
    const older = pnlSummary(store, 1, 60, now, zone);
    expect(older.days.map((d) => d.date)).toEqual(['2026-07-15', '2026-03-29', '2025-10-26']);
    expect(pnlSummary(store, newer, 60, now, zone).days.map((d) => d.date)).toEqual(['2026-11-21']);
  });
});
