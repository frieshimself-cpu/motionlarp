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
