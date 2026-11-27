// From the every-button test of the site: how the pages print numbers and days, and what a card adds up
// (public/figures.js, loaded here as the browser loads it). Each failed on the code before its fix.
import { afterEach, describe, expect, it } from 'vitest';
import * as figures from '../public/figures.js';
import { dayLabel, fmtSol, openPnl, plain, signed } from '../public/figures.js';

describe('B20: numbers under 0.000001 are written out, never as "5e-7"', () => {
  it('as the editor fills its boxes and the dashboard prints a copy\'s fees', () => {
    expect(plain(0.0000005)).toBe('0.0000005');
    expect(plain(0.00000015)).toBe('0.00000015');
    expect(plain(1e-9)).toBe('0.000000001');
    expect(plain(-0.0000005)).toBe('-0.0000005');
    for (const n of [0, 0.25, 7, 100, 0.000001, 33.5, 0.123456789]) expect(plain(n)).toBe(String(n));
    expect(plain('')).toBe(''); // an empty box stays empty
  });
  it('what plain() writes is the same number, and the editor\'s own check takes it', () => {
    for (const n of [0.0000005, 1.5e-7, 0.000000001, 123e-10]) {
      expect(Number(plain(n))).toBe(n);
      expect(plain(n)).toMatch(/^\d*\.?\d+$/); // the check in public/app.js
    }
  });
});

describe('B19: one minus sign', () => {
  it('a negative amount prints "−" as the P/L beside it does', () => {
    expect(fmtSol(-0.000405)).toBe('−0.0004');
    expect(signed(-0.0091)).toBe('−0.0091');
    expect(fmtSol(-123.456)).toBe('−123.46');
    expect(fmtSol(0.0048)).toBe('0.0048');
    expect(fmtSol(-0.00001)).toBe('0'); // rounds to nothing: no sign at all
    expect(fmtSol(null)).toBe('—');
  });
});

describe('a signed amount too small for its decimals', () => {
  it('is shown with as many more as it takes, so its sign and its colour never stand beside a bare "0" (a loss of 0.0002 SOL read "−0", in red)', () => {
    expect(signed(-0.000197, 3)).toBe('−0.0002');
    expect(signed(0.000197, 3)).toBe('+0.0002');
    expect(signed(-0.0000123)).toBe('−0.00001');
    expect(figures.cls(-0.000197)).toBe('down');
    expect(figures.cls(0.000197)).toBe('up');
  });
  it('is 0, with no sign and no colour, once it is under half a millionth of a SOL', () => {
    for (const n of [-0.0000001, 0.0000004, 0, -0]) {
      expect(signed(n, 3)).toBe('0');
      expect(figures.cls(n)).toBe('');
    }
  });
  it('anything else is as before', () => {
    expect(signed(-1.23456, 3)).toBe('−1.235');
    expect(signed(0.5, 3)).toBe('+0.5');
    expect(signed(250.123, 3)).toBe('+250.12');
    expect(signed(-0.0091)).toBe('−0.0091');
    expect(signed(null as unknown as number, 3)).toBe('0');
    expect(figures.cls(2)).toBe('up');
    expect(figures.cls(-2)).toBe('down');
    expect(figures.cls(null as unknown as number)).toBe('');
  });
});

describe('B16: "Profit by day" names each day as the viewer\'s calendar does', () => {
  const tz = process.env.TZ;
  afterEach(() => { process.env.TZ = tz; });
  it('the same day name from UTC−11 to UTC+14', () => {
    for (const zone of ['Pacific/Pago_Pago', 'America/Los_Angeles', 'UTC', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      expect(dayLabel('2026-11-27', 'en-US')).toBe('Fri, Nov 27');
      expect(dayLabel('2026-10-19', 'en-US')).toBe('Mon, Oct 19');
    }
  });
});

describe('5 (second review): History\'s heading names what each of its numbers covers', () => {
  // The heading's count, total and winners are of one kind (real once there are real trades), while the list under it
  // holds both: "150 · total … · the latest 200 are listed" stood above 200 rows, 100 of them tagged test.
  const heading = (h: { trades: number; kind: 'live' | 'test'; shown: number; closedAll: number }) => (figures as Record<string, any>).closedHeading?.(h);
  it('real and test positions: the count says "real", and the cut list says of how many and of which kinds', () => {
    expect(heading({ trades: 150, kind: 'live', shown: 200, closedAll: 250 })).toEqual({ count: '150 real', listed: 'the latest 200 of 250 closed positions (real and test) are listed' });
    expect(heading({ trades: 9, kind: 'live', shown: 14, closedAll: 14 })).toEqual({ count: '9 real', listed: '' });
  });
  it('one kind only: a test account says "test"; a real-only account and an empty one need no word', () => {
    expect(heading({ trades: 205, kind: 'test', shown: 200, closedAll: 205 })).toEqual({ count: '205 test', listed: 'the latest 200 of 205 are listed' });
    expect(heading({ trades: 12, kind: 'live', shown: 12, closedAll: 12 })).toEqual({ count: '12', listed: '' });
    expect(heading({ trades: 250, kind: 'live', shown: 200, closedAll: 250 })).toEqual({ count: '250', listed: 'the latest 200 of 250 are listed' });
    expect(heading({ trades: 0, kind: 'test', shown: 0, closedAll: 0 })).toEqual({ count: '0', listed: '' });
  });
});

describe('B1: the "Open positions" card', () => {
  it('real positions\' profit alone, the test ones apart', () => {
    const r = openPnl([{ mode: 'live', pnlSol: 0.1 }, { mode: 'paper', pnlSol: -0.534255 }, { mode: 'live', pnlSol: -0.031111111 }]);
    expect(r.sol).toBeCloseTo(0.068888889, 9);
    expect(r.test).toBe(false);
    expect(r.testSol).toBeCloseTo(-0.534255, 9);
  });
  it('only test positions open: their profit, marked test; nothing open: zero', () => {
    expect(openPnl([{ mode: 'paper', pnlSol: -0.5 }])).toEqual({ sol: -0.5, test: true, testSol: null });
    expect(openPnl([{ mode: 'live', pnlSol: 0.2 }])).toEqual({ sol: 0.2, test: false, testSol: null });
    expect(openPnl([])).toEqual({ sol: 0, test: false, testSol: null });
  });
});
