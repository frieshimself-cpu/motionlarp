import { describe, expect, it } from 'vitest';
import { dueSells, type PositionView } from '../src/engine/rules.js';
import { defaultSettings, validateSettings, SettingsError, type SellSettings } from '../src/engine/settings.js';

const LEADER = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';

function pos(sell: Partial<SellSettings>, over: Partial<PositionView> = {}): PositionView {
  return {
    openedAt: 0,
    tokensBought: 1_000_000n,
    tokensHeld: 1_000_000n,
    costLamports: 100_000_000n,
    refValueLamports: 100_000_000n, // value of tokensBought at the last quote
    lastChangeAt: 0,
    firedTimed: [],
    firedStop: [],
    deadFired: false,
    sell: { mirror: { enabled: false, mode: 'same' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 60 }, ...sell },
    ...over,
  };
}

describe('timed sells', () => {
  const timed = [{ afterSec: 3, percent: 25 }, { afterSec: 6, percent: 50 }, { afterSec: 9, percent: 100 }];
  it('nothing before the first timer', () => {
    expect(dueSells(pos({ timed }), 2999)).toEqual([]);
  });
  it('25 % at 3 s, then 50 % at 6 s, then 100 % at 9 s, each once', () => {
    expect(dueSells(pos({ timed }), 3000)).toEqual([{ reason: 'timed', percent: 25, stage: 0 }]);
    expect(dueSells(pos({ timed }, { firedTimed: [0] }), 6000)).toEqual([{ reason: 'timed', percent: 50, stage: 1 }]);
    expect(dueSells(pos({ timed }, { firedTimed: [0, 1] }), 9500)).toEqual([{ reason: 'timed', percent: 100, stage: 2 }]);
    expect(dueSells(pos({ timed }, { firedTimed: [0, 1, 2] }), 99_000)).toEqual([]);
  });
  it('overdue timers (after a restart) all come due, in order', () => {
    expect(dueSells(pos({ timed }), 60_000).map((o) => o.stage)).toEqual([0, 1, 2]);
  });
  it('order of entry does not matter: sorted by time', () => {
    const shuffled = [timed[2]!, timed[0]!, timed[1]!];
    expect(dueSells(pos({ timed: shuffled }), 6000).map((o) => o.percent)).toEqual([25, 50]);
  });
});

describe('stop loss levels', () => {
  const stopLoss = [{ lossPct: 30, percent: 50 }, { lossPct: 60, percent: 100 }];
  it('no sell at −29 %', () => {
    expect(dueSells(pos({ stopLoss }, { refValueLamports: 71_000_000n }), 1)).toEqual([]);
  });
  it('−31 % fires the first level once', () => {
    expect(dueSells(pos({ stopLoss }, { refValueLamports: 69_000_000n }), 1)).toEqual([{ reason: 'stop_loss', percent: 50, stage: 0 }]);
    expect(dueSells(pos({ stopLoss }, { refValueLamports: 69_000_000n, firedStop: [0] }), 1)).toEqual([]);
  });
  it('a crash through both levels fires both', () => {
    expect(dueSells(pos({ stopLoss }, { refValueLamports: 10_000_000n }), 1).map((o) => o.stage)).toEqual([0, 1]);
  });
  it('loss is measured per token, so a half-sold bag is judged on price, not on size', () => {
    // Half sold, price unchanged: no loss.
    expect(dueSells(pos({ stopLoss }, { tokensHeld: 500_000n }), 1)).toEqual([]);
  });
  it('no quote yet: no stop loss decision', () => {
    expect(dueSells(pos({ stopLoss }, { refValueLamports: null }), 1)).toEqual([]);
  });
});

describe('dead coin', () => {
  it('sells everything after idleSec without a price change, once', () => {
    const p = pos({ deadCoin: { enabled: true, idleSec: 60 } }, { lastChangeAt: 1000 });
    expect(dueSells(p, 60_999)).toEqual([]);
    expect(dueSells(p, 61_000)).toEqual([{ reason: 'dead_coin', percent: 100 }]);
    expect(dueSells({ ...p, deadFired: true }, 99_000)).toEqual([]);
  });
  it('off means off', () => {
    expect(dueSells(pos({}, { lastChangeAt: 0 }), 10_000_000)).toEqual([]);
  });
});

it('a closed position has nothing due', () => {
  expect(dueSells(pos({ timed: [{ afterSec: 0, percent: 100 }] }, { tokensHeld: 0n }), 5000)).toEqual([]);
});

describe('validateSettings', () => {
  const base = { ...defaultSettings(), leader: LEADER, name: 'Cupsey' };
  it('accepts the defaults with a leader', () => {
    expect(validateSettings(base).leader).toBe(LEADER);
  });
  it('fills defaults for missing fields and sorts timers', () => {
    const s = validateSettings({ leader: LEADER, buySol: 0.1, sell: { timed: [{ afterSec: 9, percent: 100 }, { afterSec: 3, percent: 25 }] } });
    expect(s.slippagePct).toBe(25);
    expect(s.sell.timed.map((t) => t.afterSec)).toEqual([3, 9]);
    expect(s.sell.mirror.enabled).toBe(true);
  });
  it.each([
    [{ buySol: 0 }, 'buy amount'],
    [{ buySol: -1 }, 'buy amount'],
    [{ minLeaderBuySol: -0.1 }, 'minimum'],
    [{ leader: 'nope' }, 'wallet address'],
    [{ sell: { timed: [{ afterSec: 3, percent: 0 }] } }, 'percent'],
    [{ sell: { timed: [{ afterSec: 3, percent: 101 }] } }, 'percent'],
    [{ sell: { timed: [{ afterSec: -1, percent: 50 }] } }, 'seconds'],
    [{ sell: { stopLoss: [{ lossPct: 0, percent: 50 }] } }, 'loss'],
    [{ sell: { stopLoss: [{ lossPct: 100, percent: 50 }] } }, 'loss'],
    [{ sell: { deadCoin: { enabled: true, idleSec: 2 } } }, 'dead coin'],
    [{ slippagePct: 0 }, 'slippage'],
    [{ priorityFeeSol: 1 }, 'priority fee'],
  ])('rejects %j', (patch, word) => {
    expect(() => validateSettings({ ...base, ...patch })).toThrow(SettingsError);
    expect(() => validateSettings({ ...base, ...patch })).toThrow(new RegExp(word, 'i'));
  });
});

describe('trading fees per copy', () => {
  const base = { leader: LEADER, buySol: 0.1 };
  it('defaults: sells use the buy fees unless set', () => {
    const s = validateSettings({ ...base, priorityFeeSol: 0.001, tipSol: 0.002 });
    expect(s).toMatchObject({ priorityFeeSol: 0.001, tipSol: 0.002, sellPriorityFeeSol: 0.001, sellTipSol: 0.002 });
    expect(validateSettings(base)).toMatchObject({ priorityFeeSol: 0.0005, tipSol: 0, sellPriorityFeeSol: 0.0005, sellTipSol: 0 });
  });
  it('buy and sell fees can differ', () => {
    const s = validateSettings({ ...base, priorityFeeSol: 0.001, tipSol: 0.003, sellPriorityFeeSol: 0.0002, sellTipSol: 0 });
    expect(s).toMatchObject({ priorityFeeSol: 0.001, tipSol: 0.003, sellPriorityFeeSol: 0.0002, sellTipSol: 0 });
  });
  it.each([[{ tipSol: -1 }, 'tip'], [{ tipSol: 2 }, 'tip'], [{ sellTipSol: 2 }, 'tip'], [{ sellPriorityFeeSol: 5 }, 'priority fee']])('rejects %j', (patch, word) => {
    expect(() => validateSettings({ ...base, ...patch })).toThrow(new RegExp(word, 'i'));
  });
});

describe('timed sells as shares of the ORIGINAL bag', () => {
  const timed = [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 30 }, { afterSec: 6, percent: 100 }];
  const bag = (over: Partial<PositionView> = {}) => pos({ timed, timedOf: 'bag' }, over);
  it('40 % of the bag at 2 s, 30 % of the bag at 4 s, then everything left at 6 s', () => {
    expect(dueSells(bag(), 1999)).toEqual([]);
    expect(dueSells(bag(), 2000)).toEqual([{ reason: 'timed', percent: 40, stage: 0, basis: 'bag' }]);
    expect(dueSells(bag({ firedTimed: [0] }), 4000)).toEqual([{ reason: 'timed', percent: 30, stage: 1, basis: 'bag' }]);
    expect(dueSells(bag({ firedTimed: [0, 1] }), 6000)).toEqual([{ reason: 'timed', percent: 100, stage: 2, basis: 'bag', everything: true }]);
  });
  it('a later step is due on its own clock even while an earlier one has not finished', () => {
    expect(dueSells(bag(), 4100).map((o) => o.stage)).toEqual([0, 1]);
    expect(dueSells(bag(), 6100).map((o) => o.stage)).toEqual([0, 1, 2]);
  });
  it('the last step sells everything whatever percent it carries', () => {
    const p = pos({ timed: [{ afterSec: 2, percent: 40 }, { afterSec: 6, percent: 30 }], timedOf: 'bag' }, { firedTimed: [0] });
    expect(dueSells(p, 6000)[0]).toMatchObject({ everything: true });
  });
  it('the default stays "of what is left"', () => {
    expect(dueSells(pos({ timed }), 2000)).toEqual([{ reason: 'timed', percent: 40, stage: 0 }]);
  });
});

describe('new copy options', () => {
  const base = { leader: LEADER, buySol: 0.1 };
  it('timed sells can be of the original bag', () => {
    expect(validateSettings({ ...base, sell: { timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }] } }).sell.timedOf).toBe('bag');
    expect(validateSettings(base).sell.timedOf).toBe('left');
  });
  it('"sell when they sell" has a third mode: only when they sell everything', () => {
    expect(validateSettings({ ...base, sell: { mirror: { enabled: true, mode: 'exit' } } }).sell.mirror.mode).toBe('exit');
  });
  it('the Scharo preset is a valid copy with exactly the agreed settings', async () => {
    const { PRESETS } = await import('../src/engine/settings.js');
    const scharo = PRESETS.find((p) => p.name === 'Scharo')!;
    const s = validateSettings({ ...scharo.settings, buySol: 1 });
    expect(s).toMatchObject({
      leader: 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih', minLeaderBuySol: 0, slippagePct: 100, oncePerCoin: false,
      priorityFeeSol: 0.001, tipSol: 0.005, sellPriorityFeeSol: 0.001, sellTipSol: 0.005,
      sell: { mirror: { enabled: true, mode: 'exit' }, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 30 }, { afterSec: 6, percent: 100 }], stopLoss: [], deadCoin: { enabled: false } },
    });
  });
});
