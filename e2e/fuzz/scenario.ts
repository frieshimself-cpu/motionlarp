// A scenario: who copies whom with which settings, and the list of things that happen. Everything in it is plain
// data (JSON), generated from a seed, so a failing scenario can be saved, shrunk and replayed exactly.
import { PRESETS } from '../../src/engine/settings.js';
import type { Faults, Tape } from './market.js';
import { Rng } from './sim.js';

/** Fixed addresses (valid 32-byte keys; none of them is used on any chain by this test). */
export const LEADERS = [
  'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih', // the Scharo preset's wallet
  '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB',
  'GsJuHUtw6ni41HNgiycuAn4xeFw5GupsZUBPHgzW6PJR',
];
export const MINTS = [
  'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump',
  'Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA',
  'So11111111111111111111111111111111111111112',
];

export type Action =
  | { a: 'tick' }
  /** approx: read from pump.fun's event (about 1 % under the real spend; within 1.5 % of the minimum it counts). */
  | { a: 'buy'; leader: number; mint: number; sol: number; twice?: boolean; stale?: boolean; noTime?: boolean; approx?: boolean }
  /** share: part of the leader's bag sold (1 = all). lost: the engine never hears of it (missed while down). */
  | { a: 'sell'; leader: number; mint: number; share: number; twice?: boolean; lost?: boolean }
  /** Price multiplied by num/den. */
  | { a: 'price'; mint: number; num: number; den: number }
  | { a: 'sellNow'; pick: number }
  | { a: 'pause'; copy: number }
  | { a: 'resume'; copy: number }
  | { a: 'edit'; copy: number; input: Record<string, unknown> }
  | { a: 'delete'; copy: number }
  | { a: 'restart'; kind: 'graceful' | 'crash'; downMs: number }
  /** Every sell, quote and balance read fails for this long (an RPC outage). */
  | { a: 'outage'; ms: number }
  | { a: 'maxBuy'; sol: number }
  | { a: 'userOff'; user: number; off: boolean }
  /** The owner's Live trading switch (new buys are real only while it is on). */
  | { a: 'liveSwitch'; on: boolean };

export interface Step { dt: number; act: Action }

/** code the sabotage must make fail → what the harness does to the engine's surroundings. */
export const SABOTAGES = {
  'clock-ahead': ['TM1', 'the engine is given a clock 3 s ahead: timed steps go out before their time'],
  'clock-behind': ['TL1', 'the engine is given a clock 3 s behind: a step that is due is not started'],
  refire: ['DF1', 'after a timed step sold, its "fired" mark is wiped from the database: it sells again'],
  'mute-sells': ['FE2', '"Sold" feed lines are thrown away'],
  'mute-skips': ['FE3', '"Skipped" feed lines are thrown away'],
  'min-zero': ['B1', 'the minimum leader buy is zeroed in the database behind the oracle\'s back'],
  'twin-position': ['O1', 'a second open position in the same coin is written into the database'],
  'fee-off': ['F1', 'the engine is given a platform fee 7 bps higher than the user\'s'],
  'lose-proceeds': ['M2', 'a sell\'s proceeds are taken off the position again after it was booked'],
  'hide-coins': ['T5', 'half of a position\'s tokens are taken off the books'],
  // (the two below check "every sale that landed is booked exactly once": the code may name the kind too)
  'drop-booking': ['M3:sold-but-not-booked', 'the first real sale\'s booking fails and its row in sells_out is deleted: nobody ever books it'],
  'book-twice': ['M3:sale-booked-twice', 'the first real sale\'s fill is written a second time'],
} as const;
export type Sabotage = keyof typeof SABOTAGES;

/**
 * Database faults (profiles dbfault and diskfull). `p`: chance that one write which changes something fails, once
 * (dbfault). `full`: windows of virtual time, in ms from the start, during which every such write fails, as on a
 * full disk; reads keep working (diskfull). `io`: share of the dbfault failures that are "disk I/O error" rather
 * than "database or disk is full". The final quiet phase runs without faults.
 */
export interface DbFaults { p?: number; io?: number; full?: { at: number; ms: number; err: 'full' | 'io' }[] }

export interface Scenario {
  seed: number;
  /** What kind of trouble this seed has (for grouping results). */
  profile: string;
  live: boolean;
  overAsk: 'strict' | 'clamp';
  priceMs: number;
  /** 'prod': the engine's own retry pauses; 'fast': short ones passed in. */
  retry: 'prod' | 'fast';
  maxSolPerBuy: number;
  users: { feeBps: number; sol: number }[];
  /** Tokens (base units) one SOL buys at the start, per coin. */
  mints: number[];
  copies: { user: number; input: Record<string, unknown> }[];
  faults: Faults;
  steps: Step[];
  finale: { dump: boolean; leadersExit: boolean };
  /** Present in a saved (frozen) scenario: the market's outcomes in call order. */
  tape?: Tape;
  /** Coins a user already holds in the wallet, bought by hand (only in hand-written scenarios). */
  preload?: { user: number; mint: number; tokens: number }[];
  /** A note for the reader of a hand-written scenario. */
  about?: string;
  /** Hand-written scenario: the violations it shows while the defect exists (e2e/fuzz/cases). */
  expect?: string[];
  /** Hand-written scenarios: where the product documents this behaviour as intended (the case then shows a
   *  consequence of a documented rule, not a defect; `--cases` lists it apart). */
  documented?: string;
  /** Hand-written scenarios: a real fill that stays booked at its quote (the exact SOL never reached the engine) is
   *  a violation (M5). Random runs only count these (they would turn every eighth seed red). */
  strictExact?: boolean;
  /** Self-test only (--selftest): a fault the HARNESS plants around the engine, to prove a check can fail. */
  sabotage?: Sabotage;
  /** Profiles dbfault and diskfull: database writes that fail (see DbFaults). */
  db?: DbFaults;
  /** The executor's coming fix (market.ts, `noRecordNoSend`): written into a scenario shrunk with
   *  FUZZ_NO_RECORD_NO_SEND=1, so that its replay runs the same way. */
  noRecordNoSend?: boolean;
}

const PCTS = [5, 10, 20, 25, 30, 33.3, 40, 50, 60, 75, 90, 100, 100, 100];
const TIMES = [0, 0.5, 1, 1.5, 2, 2, 3, 4, 4, 5, 6, 6, 8, 10, 12, 15, 20, 30];
const SCHARO = PRESETS.find((p) => p.id === 'scharo')?.settings ?? PRESETS[0]?.settings;

/** Random but valid input for validateSettings. */
export function genSettings(r: Rng, leader: string, name: string): Record<string, unknown> {
  const timedN = r.pick([0, 0, 1, 2, 3, 3, 4]);
  const timedOf = r.chance(0.5) ? 'bag' : 'left';
  const timed: { afterSec: number; percent: number }[] = [];
  for (let i = 0; i < timedN; i++) {
    const afterSec = r.chance(0.8) ? r.pick(TIMES) : Number(r.float(0, 40).toFixed(1));
    const percent = r.chance(0.85) ? r.pick(PCTS) : Number(r.float(0.5, 100).toFixed(2));
    timed.push({ afterSec, percent });
  }
  // Most ladders end with "everything".
  if (timed.length && r.chance(0.6)) {
    let last = 0;
    for (let i = 1; i < timed.length; i++) if (timed[i]!.afterSec >= timed[last]!.afterSec) last = i;
    timed[last]!.percent = 100;
  }
  const stopN = r.pick([0, 0, 0, 1, 2, 3]);
  const stopLoss: { lossPct: number; percent: number }[] = [];
  for (let i = 0; i < stopN; i++) {
    stopLoss.push({ lossPct: r.chance(0.8) ? r.pick([5, 10, 20, 30, 50, 60, 80, 95]) : Number(r.float(1, 99).toFixed(1)), percent: r.pick(PCTS) });
  }
  const priorityFeeSol = r.pick([0, 0.0001, 0.0005, 0.001, 0.005]);
  const tipSol = r.pick([0, 0, 0.001, 0.005]);
  return {
    name,
    leader,
    enabled: true,
    mode: r.chance(0.5) ? 'live' : 'paper',
    buySol: r.pick([0.01, 0.02, 0.05, 0.1, 0.5, 1, 2, 7]),
    minLeaderBuySol: r.pick([0, 0, 0.1, 0.5, 1, 2]),
    slippagePct: r.pick([0.5, 5, 25, 50, 100]),
    priorityFeeSol,
    tipSol,
    ...(r.chance(0.6) ? { sellPriorityFeeSol: r.pick([0, 0.0001, 0.001, 0.002]), sellTipSol: r.pick([0, 0.001, 0.002]) } : {}),
    oncePerCoin: r.chance(0.5),
    sell: {
      mirror: { enabled: r.chance(0.65), mode: r.pick(['same', 'all', 'exit']) },
      timedOf,
      timed,
      stopLoss,
      deadCoin: { enabled: r.chance(0.3), idleSec: r.pick([5, 8, 10, 15, 20, 30, 60]) },
    },
  };
}

// 'slowread', 'dbfault' and 'diskfull' are not in the default mix (so every earlier seed stays what it was): only
// with --profile.
export const PROFILES = ['instant', 'calm', 'flaky', 'outage', 'partial', 'ghost', 'crash', 'slowread', 'dbfault', 'diskfull'] as const;
export type Profile = (typeof PROFILES)[number];
/** Profiles whose buys may be handed back with the quote's coin count (market.ts `quoted`). */
const QUOTED: readonly string[] = ['slowread', 'dbfault', 'diskfull'];

export function faultsFor(profile: Profile, r: Rng): Faults {
  const none: Faults = { instant: false, buyFail: 0, buyUnsure: 0, sellFail: 0, streak: 0, streakMax: 0, slow: 0, partial: 0, ghost: 0, quoteFail: 0, balFail: 0, balLag: 0, refineNull: 0 };
  // Half the seeds read balances at once, half with a real connection's delay.
  const balLag = r.pick([0, 0, 80, 250]);
  switch (profile) {
    case 'instant': return { ...none, instant: true };
    case 'calm': return { ...none, slow: 0.05, balLag };
    case 'flaky': return { ...none, buyFail: 0.08, buyUnsure: 0.05, sellFail: r.pick([0.1, 0.2, 0.35]), streak: 0.3, streakMax: 4, slow: 0.1, quoteFail: 0.1, balFail: 0.03, balLag, refineNull: 0.05 };
    case 'outage': return { ...none, buyFail: 0.05, buyUnsure: 0.08, sellFail: 0.3, streak: 0.5, streakMax: 14, slow: 0.1, quoteFail: 0.15, balFail: 0.05, balLag };
    case 'partial': return { ...none, sellFail: 0.1, streak: 0.2, streakMax: 3, slow: 0.05, partial: 0.25, balLag };
    case 'ghost': return { ...none, sellFail: 0.25, streak: 0.2, streakMax: 3, slow: 0.05, ghost: 0.5, balLag };
    case 'crash': return { ...none, buyUnsure: 0.05, sellFail: 0.1, streak: 0.2, streakMax: 3, slow: 0.1, balLag };
    // Reads are slow right after a buy: it is handed back with the quote's coin count and the exact one follows
    // (or never arrives). Otherwise a mild market, so what shows is this path's own.
    case 'slowread': return { ...none, sellFail: 0.08, streak: 0.2, streakMax: 3, slow: 0.05, balLag, refineNull: 0.15, quoted: 0.6 };
    // Database writes fail (see DbFaults); a mild market otherwise, with what the booking paths depend on: sells that
    // fail and are retried, exact figures that arrive later (or never), buys handed back with the quote's coin count,
    // a few buys of unknown outcome.
    case 'dbfault':
    case 'diskfull': return { ...none, buyUnsure: 0.03, sellFail: 0.08, streak: 0.2, streakMax: 3, slow: 0.05, balLag, refineNull: 0.1, quoted: 0.3 };
  }
}

/** The database faults of a dbfault or diskfull seed, from their own random stream (the plan's draws stay as they
 *  are). `spanMs`: how long the steps take, about (the windows of a full disk fall inside it). */
export function dbFaultsFor(profile: Profile, seed: number, spanMs: number): DbFaults | undefined {
  const r = Rng.derive(seed, 'db');
  if (profile === 'dbfault') return { p: r.pick([0.01, 0.03, 0.06, 0.12]), io: 0.25 };
  if (profile !== 'diskfull') return undefined;
  const full: NonNullable<DbFaults['full']> = [];
  const n = r.pick([1, 2, 2, 3, 3, 4]);
  for (let i = 0; i < n; i++) {
    const ms = r.chance(0.5) ? r.pick([500, 1_000, 2_000, 5_000, 10_000, 20_000]) : r.int(500, 20_000);
    full.push({ at: r.int(0, Math.max(1, spanMs - 1)), ms, err: r.chance(0.8) ? 'full' : 'io' });
  }
  full.sort((a, b) => a.at - b.at);
  return { full };
}

export interface GenOptions {
  /** Force one profile for every seed. */
  profile?: Profile;
  /** Leave out the two profiles a healthy server never meets: sells whose outcome stays unknown, and crashes. */
  core?: boolean;
}

export function generate(seed: number, steps: number, opt: GenOptions = {}): Scenario {
  const r = Rng.derive(seed, 'plan');
  const profile: Profile = opt.profile ?? r.weighted(opt.core
    ? [[11, 'instant'], [27, 'calm'], [40, 'flaky'], [14, 'outage'], [8, 'partial']] as const
    : [[10, 'instant'], [24, 'calm'], [36, 'flaky'], [12, 'outage'], [7, 'partial'], [5, 'ghost'], [6, 'crash']] as const);
  const live = r.chance(0.62);
  const nUsers = r.chance(0.35) ? 2 : 1;
  const nLeaders = r.chance(0.4) ? 2 : 1;
  const nMints = r.pick([1, 1, 2, 2, 3]);
  const nCopies = r.pick([1, 1, 2, 2, 3]);
  const scarce = live && r.chance(0.08);
  const users = Array.from({ length: nUsers }, () => ({ feeBps: r.pick([0, 0, 50, 100, 250]), sol: scarce ? Number(r.float(0.02, 3).toFixed(4)) : 1_000 }));
  const mints = Array.from({ length: nMints }, () => r.pick([1_000_000, 1_000_000, 100_000_000, 30_000_000_000_000]));
  const copies: Scenario['copies'] = [];
  let scharo = false;
  for (let i = 0; i < nCopies; i++) {
    const user = r.int(0, nUsers - 1);
    if (SCHARO && !scharo && r.chance(0.22)) {
      scharo = true;
      copies.push({ user, input: { ...SCHARO, ...(r.chance(0.3) ? { buySol: r.pick([0.05, 0.5, 1]) } : {}) } });
    } else {
      copies.push({ user, input: genSettings(r, LEADERS[r.int(0, nLeaders - 1)]!, `c${i + 1}`) });
    }
  }
  // The Scharo copy follows leader 0 whatever nLeaders says: make sure that leader trades.
  const leaderCount = scharo ? Math.max(1, nLeaders) : nLeaders;
  const maxSolPerBuy = r.chance(0.85) ? 30 : r.pick([0.05, 1, 5]);

  const out: Step[] = [];
  const holds = new Set<string>(); // leader:mint the leader probably holds (the runner checks for real)
  let restarts = 0;
  let outageSteps = 0;
  // In a few seeds the owner flips the Live switch while positions are open.
  const switches = r.chance(0.12);
  const dtOf = (): number => {
    if (outageSteps > 0) { outageSteps--; return r.pick([500, 2_000, 5_000, 15_000, 30_000, 45_000]); }
    return r.weighted([[50, () => r.int(50, 400)], [25, () => r.int(400, 1_500)], [15, () => r.int(1_500, 5_000)], [8, () => r.int(5_000, 20_000)], [2, () => r.int(20_000, 90_000)]] as const)();
  };
  for (let i = 0; i < steps; i++) {
    const leader = r.int(0, leaderCount - 1);
    const mint = r.int(0, nMints - 1);
    const key = `${leader}:${mint}`;
    const kind = r.weighted([
      [30, 'tick'], [holds.size ? 12 : 30, 'buy'], [holds.size ? 9 : 0, 'sellPart'], [holds.size ? 7 : 0, 'sellAll'], [12, 'price'], [5, 'sellNow'],
      [2, 'pause'], [1.5, 'resume'], [2, 'edit'], [1.2, 'delete'], [restarts < 2 ? 3 : 0, 'restart'], [profile === 'outage' ? 3 : 0, 'outage'], [0.7, 'maxBuy'], [0.7, 'userOff'],
      [switches ? 1.2 : 0, 'liveSwitch'],
    ] as const);
    let act: Action = { a: 'tick' };
    if (kind === 'buy') {
      const approx = r.chance(0.2);
      // An "approx" buy is often just under a round minimum: 0.99 SOL meets a 1 SOL minimum, 0.98 does not.
      act = { a: 'buy', leader, mint, sol: approx ? r.pick([0.0985, 0.099, 0.49, 0.495, 0.98, 0.99, 1.97, 1.99, 3]) : r.pick([0.05, 0.2, 0.5, 1, 1.5, 2, 3, 5]), ...(approx ? { approx: true } : {}), ...(r.chance(0.08) ? { twice: true } : {}), ...(r.chance(0.03) ? { stale: true } : {}), ...(r.chance(0.3) ? { noTime: true } : {}) };
      holds.add(key);
    } else if (kind === 'sellPart' || kind === 'sellAll') {
      const k = r.pick([...holds]);
      const [l, m] = k.split(':').map(Number) as [number, number];
      const all = kind === 'sellAll';
      act = { a: 'sell', leader: l, mint: m, share: all ? 1 : r.pick([0.1, 0.25, 0.5, 0.5, 0.75, 0.9, 0.997]), ...(r.chance(0.06) ? { twice: true } : {}), ...(r.chance(0.04) ? { lost: true } : {}) };
      if (all) holds.delete(k);
    } else if (kind === 'price') {
      const [num, den] = r.pick([[1, 2], [3, 4], [9, 10], [99, 100], [101, 100], [11, 10], [3, 2], [2, 1], [5, 1], [1, 10], [1, 100], [1, 1]] as const);
      act = { a: 'price', mint, num, den };
    } else if (kind === 'sellNow') act = { a: 'sellNow', pick: r.int(0, 5) };
    else if (kind === 'pause') act = { a: 'pause', copy: r.int(0, nCopies - 1) };
    else if (kind === 'resume') act = { a: 'resume', copy: r.int(0, nCopies - 1) };
    else if (kind === 'edit') {
      const c = r.int(0, nCopies - 1);
      act = { a: 'edit', copy: c, input: genSettings(r, LEADERS[r.int(0, leaderCount - 1)]!, `c${c + 1}e`) };
    } else if (kind === 'delete') act = { a: 'delete', copy: r.int(0, nCopies - 1) };
    else if (kind === 'restart') {
      restarts++;
      act = { a: 'restart', kind: profile === 'crash' && r.chance(0.7) ? 'crash' : 'graceful', downMs: r.pick([1_000, 5_000, 20_000, 70_000]) };
    } else if (kind === 'outage') {
      const ms = r.pick([3_000, 10_000, 30_000, 120_000, 300_000]);
      act = { a: 'outage', ms };
      outageSteps = ms >= 120_000 ? r.int(6, 14) : r.int(2, 5);
    } else if (kind === 'maxBuy') act = { a: 'maxBuy', sol: r.pick([0.05, 1, 5, 30]) };
    else if (kind === 'userOff') act = { a: 'userOff', user: r.int(0, nUsers - 1), off: r.chance(0.6) };
    else if (kind === 'liveSwitch') act = { a: 'liveSwitch', on: r.chance(0.5) };
    out.push({ dt: dtOf(), act });
  }
  const sc: Scenario = {
    seed, profile, live, overAsk: ((strict: boolean) => (strict && !QUOTED.includes(profile) ? 'strict' : 'clamp'))(r.chance(0.5)) /* (the real executor clamps: with a quote's coin count in the books a strict market would only show its own harshness) */, priceMs: r.pick([0, 200, 2_000, 2_000]), retry: r.chance(0.5) ? 'prod' : 'fast',
    maxSolPerBuy, users, mints, copies, faults: faultsFor(profile, r), steps: out, finale: { dump: r.chance(0.3), leadersExit: r.chance(0.35) },
  };
  const db = dbFaultsFor(profile, seed, out.reduce((a, s) => a + s.dt, 0));
  if (db) sc.db = db;
  return sc;
}
