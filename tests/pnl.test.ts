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
