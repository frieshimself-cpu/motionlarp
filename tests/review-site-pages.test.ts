// From the every-button test of the site: how the pages print numbers and days, and what a card adds up
// (public/figures.js, loaded here as the browser loads it). Each failed on the code before its fix.
import { afterEach, describe, expect, it } from 'vitest';
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
