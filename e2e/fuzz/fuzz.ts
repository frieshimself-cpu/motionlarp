// Randomized stress test of the copy engine's rules (src/engine/engine.ts), offline.
//
//   npx tsx e2e/fuzz/fuzz.ts [seeds] [steps] [options]
//
//   seeds   how many seeds to run (default 3000)
//   steps   steps per seed at least (default 60; each seed adds up to 40 more)
//
//   --from N           first seed (default 1)
//   --jobs N           worker processes (default: CPU cores, at most 8)
//   --core             leave out the two profiles a healthy server never meets (ghost, crash)
//   --profile NAME     one profile for every seed: instant | calm | flaky | outage | partial | ghost | crash | slowread
//   --no-shrink        do not shrink the violations found
//   --shrink-budget N  runs spent shrinking one violation (default 500)
//   --seed S           run one seed and print its whole transcript (same steps / --core / --profile as the batch)
//   --replay FILE      run a saved scenario (e2e/fuzz/out/repro/*.json, e2e/fuzz/cases/*.json) and print its whole transcript
//   --cases            run the hand-written scenarios in e2e/fuzz/cases (one per defect found) and say which still show it
//   --selftest         plant known faults around the engine and check that the invariants catch each one
//   --out DIR          where results go (default e2e/fuzz/out: summary.json, report.txt, repro/)
//
// What a seed is: one or two users with wallets, one to three copies with random valid settings (through the real
// validateSettings; one of them is often the Scharo preset), a random list of things that happen (the copied wallet
// buys, sells part, sells all, buys again; prices move; Sell now; a copy is paused, edited, deleted; the owner
// flips Live trading, changes max per buy, disables a user; the server restarts as src/server.ts does; an RPC
// outage), a tick of the engine's clock after each, then a long quiet phase in which the market lets everything
// through. The market is fake (market.ts): confirmations take a random time, the engine is told a moment after a
// trade landed, sells fail (also many times in a row), land late, are paid only in part; with real trades the
// wallet's balance is the truth, in test mode nothing is held. Time is virtual (sim.ts): a seed replays exactly.
//
// Profiles: instant (every answer comes at once), calm (no failures, only timing), flaky (failures and short runs
// of them, unknown buy outcomes), outage (long runs of failures and RPC outages), partial (sells paid only in
// part), ghost (sells reported "outcome unknown", landed or not), crash (the process killed with trades in flight),
// slowread (buys handed back with the quote's coin count because the reads were slow; the exact count follows, or
// never arrives; only with --profile slowread, so the seeds of the default mix stay what they were).
//
// Files: scenario.ts (what happens, from a seed), market.ts (the fake chain), run.ts (drives the real Engine and
// Store and checks the invariants), shrink.ts (makes a failing scenario small), sim.ts (virtual clock, random
// generator), cases/ (hand-written scenarios, one per defect found), out/ (last run; ignored by git).
//
// Exit code 1 when a violation was found, 0 otherwise. The invariants: INVARIANTS below; how each is checked: run.ts.
import './env.js';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from './run.js';
import type { GenOptions, Profile, Scenario } from './scenario.js';

// Loaded after env.ts has run (a static import of the engine would load node:sqlite, and print its warning, first).
const { runScenario } = await import('./run.js');
const { generate, PROFILES, SABOTAGES } = await import('./scenario.js');
const { shrink, tapeSummary } = await import('./shrink.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

/** code → [which of the task's invariants, what it promises]. */
export const INVARIANTS: Record<string, [string, string]> = {
  T1: ['1 tokens', '0 <= tokensHeld <= tokensBought, always'],
  T2: ['1/4 tokens', 'a closed or failed position holds no tokens'],
  T3: ['1 tokens', 'a booking never raises tokensHeld'],
  T4: ['1 tokens', 'LIVE: tokensBought - tokensHeld equals the tokens of the recorded sell fills'],
  T5: ['1/4 tokens', 'LIVE: with nothing in flight the books say what the wallet holds; no coins sit in the wallet without an open position'],
  W1: ['1 tokens', 'the fake wallet never goes negative'],
  OA1: ['1 tokens', 'LIVE: an ask for more than the wallet holds is corrected, not repeated'],
  M1: ['2 money', 'costLamports and tokensBought equal the buy fill'],
  M2: ['2 money', 'proceedsLamports equals the sum of the sell fills, at every moment'],
  M3: ['2 money', 'every fill is the trade that happened on the market, tokens and SOL; every sell that happened has a fill'],
  M4: ['2 money', 'profit shown (closed positions, the profit summary) equals the wallet\'s SOL change'],
  M5: ['2 money', 'a real fill ends up booked at the SOL the chain says, not at its quote (flagged in hand-written cases; random runs count it under "estimate-kept")'],
  DF1: ['3 once', 'a timed step, a stop loss level and the dead-coin rule sell at most once per position, across restarts'],
  Q: ['4 the end', 'at quiescence nothing is left opening or in flight, every step that came due has fired, and every position whose rules call for a full exit is closed'],
  SN1: ['4 the end', 'Sell now that answers ok has closed the position, or timed steps are selling the rest'],
  FX1: ['4 the end', 'a sell of everything (their exit, Sell now, dead coin, a 100 % stop or timed step) that went through leaves nothing behind once nothing else is on its way'],
  ST1: ['1/5 tokens', 'a sell never lands after its position was closed (it would sell the coins of the next position in that coin)'],
  O1: ['5 buys', 'one position per coin per user'],
  B1: ['5 buys', 'no buy against a rule (minimum, already holding, once per coin, stale, duplicate)'],
  B2: ['5 buys', 'a buy every rule allows is made'],
  B4: ['5 buys', 'a paused or deleted copy, or a disabled user, opens nothing'],
  B5: ['5 buys', 'no buy above max per buy'],
  TM1: ['6 timing', 'a timed step is never started or sent before its time from openedAt'],
  TL1: ['6 timing', 'a timed step that is due is started at that tick (bag: always; of what is left: when its queue is free)'],
  AM1: ['6 timing', 'each sell asks for the amount its rule says'],
  US1: ['1 tokens', 'nothing else of a position is sold while one of its sells has an unknown outcome that is not settled yet'],
  MI1: ['6 timing', '"sell when they sell" orders carry the share the mode calls for, and only when it calls for one'],
  FE1: ['7 feed', 'every buy has its feed line'],
  FE2: ['7 feed', 'every sell has exactly one feed line, with the booked numbers; no line for a sell that did not happen'],
  FE3: ['7 feed', 'every skipped copy has its feed line with the reason'],
  FE4: ['7 feed', 'every failing sell or buy has a feed line'],
  FE5: ['7 feed', 'a sell that keeps failing has one feed line (one more when it turns into the slow, endless kind), not one per retry'],
  F1: ['fees', 'buys and sells carry the copy\'s own fees, slippage and the user\'s platform fee, also after the copy was paused, edited or deleted'],
  R1: ['retries', 'a retried sell is checked (simulated) before it is sent'],
  X1: ['real or test', 'a position is real exactly when its buy was; a real position is sold for real (also with the Live switch off), a test one on paper; a buy of unknown outcome stays "opening", a failed one is marked failed'],
  E0: ['harness', 'the scenario ran to its end'],
  E1: ['engine', 'no exception escapes the engine (unhandled rejection, rejected tick, "timed step failed")'],
  E2: ['engine', 'the engine does not spin without time passing'],
  E3: ['harness', 'every trade belongs to an order'],
};

interface SigAgg {
  sig: string;
  seeds: number;
  asFirst: number;
  byProfile: Record<string, number>;
  live: number;
  test: number;
  /** In the seeds where this was not the first violation: which one was (it is probably a consequence of that one). */
  after: Record<string, number>;
  /** Candidate seeds to shrink, best first: [seed, steps, wasFirst]. */
  samples: { seed: number; steps: number; first: boolean; step: number; message: string; tail: string[] }[];
}
interface Agg {
  seeds: number;
  failingSeeds: number;
  steps: number;
  positions: number;
  opened: number;
  closed: number;
  buys: number;
  sells: number;
  sellFails: number;
  restarts: number;
  events: number;
  simSeconds: number;
  byProfile: Record<string, number>;
  live: number;
  sigs: Record<string, SigAgg>;
  notes: Record<string, number>;
  noteSeeds: Record<string, number[]>;
  harnessErrors: { seed: number; error: string }[];
}

const emptyAgg = (): Agg => ({ seeds: 0, failingSeeds: 0, steps: 0, positions: 0, opened: 0, closed: 0, buys: 0, sells: 0, sellFails: 0, restarts: 0, events: 0, simSeconds: 0, byProfile: {}, live: 0, sigs: {}, notes: {}, noteSeeds: {}, harnessErrors: [] });

function addResult(agg: Agg, r: RunResult, steps: number): void {
  agg.seeds++;
  if (r.violations.length) agg.failingSeeds++;
  for (const k of ['steps', 'positions', 'opened', 'closed', 'buys', 'sells', 'sellFails', 'restarts', 'events', 'simSeconds'] as const) agg[k] += r.stats[k];
  agg.byProfile[r.profile] = (agg.byProfile[r.profile] ?? 0) + 1;
  if (r.live) agg.live++;
  for (const [k, n] of Object.entries(r.notes)) {
    agg.notes[k] = (agg.notes[k] ?? 0) + n;
    const list = (agg.noteSeeds[k] ??= []);
    if (list.length < 8) list.push(r.seed);
  }
  if (r.crashed) agg.harnessErrors.push({ seed: r.seed, error: r.crashed.slice(0, 600) });
  for (const v of r.violations) {
    const s = (agg.sigs[v.sig] ??= { sig: v.sig, seeds: 0, asFirst: 0, byProfile: {}, live: 0, test: 0, after: {}, samples: [] });
    s.seeds++;
    if (v.first) s.asFirst++;
    else { const f = r.violations.find((x) => x.first)?.sig ?? '?'; s.after[f] = (s.after[f] ?? 0) + 1; }
    s.byProfile[r.profile] = (s.byProfile[r.profile] ?? 0) + 1;
    if (r.live) s.live++; else s.test++;
    s.samples.push({ seed: r.seed, steps, first: v.first, step: v.step, message: v.message, tail: v.tail });
    s.samples.sort((a, b) => Number(b.first) - Number(a.first) || a.step - b.step || a.seed - b.seed);
    if (s.samples.length > 6) s.samples.length = 6;
  }
}

function mergeAgg(a: Agg, b: Agg): void {
  for (const k of ['seeds', 'failingSeeds', 'steps', 'positions', 'opened', 'closed', 'buys', 'sells', 'sellFails', 'restarts', 'events', 'simSeconds', 'live'] as const) a[k] += b[k];
  for (const [k, n] of Object.entries(b.byProfile)) a.byProfile[k] = (a.byProfile[k] ?? 0) + n;
  for (const [k, n] of Object.entries(b.notes)) a.notes[k] = (a.notes[k] ?? 0) + n;
  for (const [k, list] of Object.entries(b.noteSeeds)) a.noteSeeds[k] = [...(a.noteSeeds[k] ?? []), ...list].sort((x, y) => x - y).slice(0, 8);
  a.harnessErrors.push(...b.harnessErrors);
  for (const s of Object.values(b.sigs)) {
    const t = (a.sigs[s.sig] ??= { sig: s.sig, seeds: 0, asFirst: 0, byProfile: {}, live: 0, test: 0, after: {}, samples: [] });
    for (const [k, n] of Object.entries(s.after ?? {})) t.after[k] = (t.after[k] ?? 0) + n;
    t.seeds += s.seeds;
    t.asFirst += s.asFirst;
    t.live += s.live;
    t.test += s.test;
    for (const [k, n] of Object.entries(s.byProfile)) t.byProfile[k] = (t.byProfile[k] ?? 0) + n;
    t.samples.push(...s.samples);
    t.samples.sort((x, y) => Number(y.first) - Number(x.first) || x.step - y.step || x.seed - y.seed);
    if (t.samples.length > 6) t.samples.length = 6;
  }
}

/** Steps for a seed: at least `steps`, up to 40 more. */
const stepsFor = (seed: number, steps: number) => steps + ((seed * 2654435761) >>> 0) % 41;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (['core', 'no-shrink', 'child', 'quiet', 'cases', 'verbose', 'selftest'].includes(key)) o[key] = true;
    else o[key] = argv[++i] ?? '';
  }
  return { pos, o };
}

function git(...args: string[]): string {
  try {
    return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '?';
  }
}

const slug = (sig: string) => sig.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 1);

async function runRange(from: number, count: number, steps: number, gen: GenOptions, progress: (done: number) => void): Promise<Agg> {
  const agg = emptyAgg();
  for (let i = 0; i < count; i++) {
    const seed = from + i;
    const n = stepsFor(seed, steps);
    const r = await runScenario(generate(seed, n, gen));
    addResult(agg, r, n);
    if ((i + 1) % 50 === 0) progress(i + 1);
  }
  progress(count);
  return agg;
}

function printTranscript(r: RunResult): void {
  for (const l of r.transcript) console.log(l);
  console.log('');
  if (!r.violations.length) console.log('no violation');
  for (const v of r.violations) console.log(`VIOLATION ${v.sig}${v.first ? ' (first)' : ''} at step ${v.step}, +${(v.t / 1000).toFixed(3)}s, seen ${v.count}×: ${v.message}`);
  if (Object.keys(r.notes).length) console.log(`outcomes counted, not flagged: ${json(r.notes)}`);
  console.log(`stats: ${json(r.stats)}`);
}

async function main(): Promise<void> {
  const { pos, o } = parseArgs(process.argv.slice(2));
  const out = resolve(String(o.out ?? join(HERE, 'out')));
  const gen: GenOptions = { ...(o.core ? { core: true } : {}), ...(o.profile ? { profile: String(o.profile) as Profile } : {}) };
  if (gen.profile && !PROFILES.includes(gen.profile)) throw new Error(`unknown profile ${gen.profile}`);
  const steps = Number(pos[1] ?? 60);

  if (o.selftest) {
    // Each planted fault must make its invariant fail in at least one of the first seeds; clean seeds are the control.
    let bad = 0;
    const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
    console.log('self-test: a fault is planted around the engine (in the harness, never in src/); its invariant must fail');
    for (const [name, [code, what]] of Object.entries(SABOTAGES)) {
      let hits = 0;
      let control = 0;
      let example = '';
      for (const seed of seeds) {
        const sc = generate(seed, 60, { profile: 'calm' });
        const clean = await runScenario(sc);
        const planted = await runScenario({ ...sc, sabotage: name as keyof typeof SABOTAGES });
        if (clean.violations.some((v) => v.code === code)) control++;
        const v = planted.violations.find((x) => x.code === code);
        if (v) { hits++; if (!example) example = `seed ${seed}: ${v.sig} — ${v.message.slice(0, 140)}`; }
      }
      const ok = hits > control;
      if (!ok) bad++;
      console.log(`  ${ok ? 'caught ' : 'MISSED '} ${code.padEnd(4)} ${name.padEnd(14)} ${what}`);
      console.log(`           fails in ${hits} of ${seeds.length} seeds with the fault (${control} without)${example ? `; e.g. ${example}` : ''}`);
    }
    console.log(bad ? `${bad} planted fault(s) were NOT caught` : 'every planted fault was caught');
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (o.cases) {
    const dir = join(HERE, 'cases');
    let still = 0;
    console.log(`motionlarp engine — hand-written cases, commit ${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain', '--', 'src') ? ' + uncommitted changes in src/' : ''}`);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const sc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Scenario;
      const r = await runScenario(sc, { fullTranscript: true });
      const found = r.violations.map((v) => v.sig);
      const expected = (sig: string) => (sc.expect ?? []).some((e) => sig.startsWith(e));
      const hit = found.filter(expected);
      const shows = hit.length > 0;
      if (shows && !sc.documented) still++;
      console.log(`\n${shows ? (sc.documented ? 'AS DOCUMENTED' : 'STILL BROKEN ') : 'not shown    '} ${file}`);
      console.log(`    ${sc.about}`);
      if (sc.documented) console.log(`    documented: ${sc.documented}`);
      for (const v of r.violations) console.log(`    ${expected(v.sig) ? '✗' : '·'} ${v.sig}: ${v.message}`);
      if (!r.violations.length) console.log('    no violation');
      if (o.verbose) for (const l of r.transcript) console.log(`      ${l}`);
    }
    console.log(`\n${still} case(s) still show their defect. One case in full: npx tsx e2e/fuzz/fuzz.ts --replay e2e/fuzz/cases/<file>`);
    process.exitCode = still ? 1 : 0;
    return;
  }
  if (o.replay) {
    const sc = JSON.parse(readFileSync(String(o.replay), 'utf8')) as Scenario;
    printTranscript(await runScenario(sc, { fullTranscript: true }));
    return;
  }
  if (o.seed) {
    const seed = Number(o.seed);
    const sc = generate(seed, stepsFor(seed, steps), gen);
    console.log(`seed ${seed}: ${sc.steps.length} steps, profile ${sc.profile}, ${sc.live ? 'LIVE' : 'TEST'}`);
    printTranscript(await runScenario(sc, { fullTranscript: true }));
    return;
  }

  const seeds = Number(pos[0] ?? 3000);
  const from = Number(o.from ?? 1);
  if (o.child) {
    const agg = await runRange(from, seeds, steps, gen, (done) => process.stdout.write(`progress ${done}\n`));
    writeFileSync(String(o.part), json(agg));
    return;
  }

  mkdirSync(out, { recursive: true });
  const commit = git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain', '--', 'src', 'public', 'tests', 'package.json');
  const t0 = Date.now();
  console.log(`motionlarp engine fuzz — commit ${commit}${dirty ? ' + uncommitted changes:' : ' (src/ clean)'}`);
  if (dirty) for (const l of dirty.split('\n')) console.log(`    ${l}`);
  console.log(`seeds ${from}..${from + seeds - 1}, at least ${steps} steps each${gen.profile ? `, profile ${gen.profile}` : gen.core ? ', core profiles only' : ''}`);

  const jobs = Math.max(1, Math.min(Number(o.jobs ?? Math.min(8, cpus().length)), seeds));
  const agg = emptyAgg();
  if (jobs === 1) {
    mergeAgg(agg, await runRange(from, seeds, steps, gen, (done) => { if (done % 250 === 0 || done === seeds) console.log(`  ${done}/${seeds} seeds, ${((Date.now() - t0) / 1000).toFixed(0)}s`); }));
  } else {
    const per = Math.ceil(seeds / jobs);
    const done = new Array<number>(jobs).fill(0);
    let shown = 0;
    await Promise.all(Array.from({ length: jobs }, (_, j) => new Promise<void>((res, rej) => {
      const start = from + j * per;
      const count = Math.min(per, from + seeds - start);
      if (count <= 0) return res();
      const part = join(out, `part-${j}.json`);
      const args = [...process.execArgv, fileURLToPath(import.meta.url), String(count), String(steps), '--from', String(start), '--child', '--part', part, ...(gen.core ? ['--core'] : []), ...(gen.profile ? ['--profile', gen.profile] : [])];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.on('data', (d: Buffer) => {
        for (const m of String(d).matchAll(/progress (\d+)/g)) done[j] = Number(m[1]);
        const total = done.reduce((a, b) => a + b, 0);
        if (total - shown >= 500 || total === seeds) { shown = total; console.log(`  ${total}/${seeds} seeds, ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
      });
      child.on('error', rej);
      child.on('exit', (code) => {
        if (code !== 0) return rej(new Error(`worker ${j} exited with ${code}`));
        mergeAgg(agg, JSON.parse(readFileSync(part, 'utf8')) as Agg);
        rmSync(part, { force: true });
        res();
      });
    })));
  }
  const ranIn = (Date.now() - t0) / 1000;

  // ── shrink each distinct violation ──
  const sigs = Object.values(agg.sigs).sort((a, b) => b.seeds - a.seeds);
  const shrunk: Record<string, { seed: number; file: string; steps: number; actions: number; reproduced: boolean; firstInShrunk: string; tape: string; message: string }> = {};
  if (!o['no-shrink'] && sigs.length) {
    mkdirSync(join(out, 'repro'), { recursive: true });
    const budget = Number(o['shrink-budget'] ?? 500);
    console.log(`\nshrinking ${sigs.length} distinct violation${sigs.length === 1 ? '' : 's'} (up to ${budget} runs each, two candidate seeds)…`);
    for (const s of sigs) {
      let best: { seed: number; sc: Scenario; res: RunResult; cost: number } | null = null;
      for (const cand of s.samples.slice(0, 2)) {
        const sc = generate(cand.seed, cand.steps, gen);
        const r = await shrink(sc, s.sig, budget);
        if (!r.reproduced) continue;
        const cost = r.scenario.steps.filter((x) => x.act.a !== 'tick').length * 10 + r.scenario.steps.length + r.scenario.copies.length * 5;
        if (!best || cost < best.cost) best = { seed: cand.seed, sc: r.scenario, res: r.result, cost };
      }
      if (!best) { console.log(`  ${s.sig}: could not be reproduced from a frozen scenario`); continue; }
      const file = join(out, 'repro', `${slug(s.sig)}.json`);
      writeFileSync(file, json(best.sc));
      const v = best.res.violations.find((x) => x.sig === s.sig)!;
      const firstV = best.res.violations.find((x) => x.first);
      writeFileSync(file.replace(/\.json$/, '.txt'), [`${s.sig} — shrunk from seed ${best.seed}`, `replay: npx tsx e2e/fuzz/fuzz.ts --replay ${file.replace(`${REPO}/`, '')}`, `market outcomes: ${tapeSummary(best.sc.tape)}`, '', ...best.res.transcript, '', ...best.res.violations.map((x) => `VIOLATION ${x.sig}${x.first ? ' (first)' : ''}: ${x.message}`)].join('\n'));
      shrunk[s.sig] = { seed: best.seed, file: file.replace(`${REPO}/`, ''), steps: best.sc.steps.length, actions: best.sc.steps.filter((x) => x.act.a !== 'tick').length, reproduced: true, firstInShrunk: firstV?.sig ?? '', tape: tapeSummary(best.sc.tape), message: v.message };
      console.log(`  ${s.sig}: seed ${best.seed} → ${best.sc.steps.length} steps (${shrunk[s.sig]!.actions} actions), ${best.sc.copies.length} cop${best.sc.copies.length === 1 ? 'y' : 'ies'}  →  ${shrunk[s.sig]!.file}`);
    }
  }

  // ── report ──
  const lines: string[] = [];
  const say = (s = '') => { lines.push(s); console.log(s); };
  say('');
  say('════════ RESULT ════════');
  say(`commit ${commit}${dirty ? ' (working tree has uncommitted changes in src/ public/ tests/)' : ''}`);
  say(`${agg.seeds} seeds, ${agg.steps} steps (${(agg.steps / agg.seeds).toFixed(0)} per seed), ${agg.live} LIVE / ${agg.seeds - agg.live} TEST, ${ranIn.toFixed(0)}s, ${jobs} worker${jobs === 1 ? '' : 's'}`);
  say(`profiles: ${Object.entries(agg.byProfile).sort().map(([k, n]) => `${k} ${n}`).join(', ')}`);
  say(`exercised: ${agg.positions} positions (${agg.opened} opened, ${agg.closed} closed), ${agg.buys} buys, ${agg.sells} sells answered (${agg.sellFails} failed), ${agg.restarts} restarts, ${Math.round(agg.simSeconds / 3600)} h of simulated time, ${agg.events} events`);
  say(`seeds with a violation: ${agg.failingSeeds} of ${agg.seeds}`);
  say('');
  if (!sigs.length) say('NO VIOLATION FOUND');
  // 'ghost' (a sell reported "outcome unknown" that had landed) and 'crash' (the process killed with trades in
  // flight) are situations a healthy server does not meet: what only shows there is listed apart.
  const RARE = new Set(['ghost', 'crash']);
  const core = sigs.filter((x) => Object.keys(x.byProfile).some((k) => !RARE.has(k)));
  const rare = sigs.filter((x) => !core.includes(x));
  const show = (list: SigAgg[], title: string) => {
    if (!list.length) return;
    say(title);
    say('');
    for (const x of list) {
      const [inv, what] = INVARIANTS[x.sig.split(':')[0]!] ?? ['?', '?'];
      say(`■ ${x.sig}`);
      say(`    invariant ${inv}: ${what}`);
      say(`    ${x.seeds} seeds (${x.asFirst} as the first violation of the seed); real trades ${x.live}, test mode ${x.test}; by profile: ${Object.entries(x.byProfile).sort().map(([k, n]) => `${k} ${n}`).join(', ')}`);
      const after = Object.entries(x.after).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (after.length) say(`    where it was not the first, the first was: ${after.map(([k, n]) => `${k} (${n})`).join(', ')}`);
      say(`    seeds: ${x.samples.map((y) => `${y.seed}${y.first ? '*' : ''}`).join(', ')}   (* = first violation of that seed)`);
      say(`    e.g. seed ${x.samples[0]!.seed}: ${x.samples[0]!.message}`);
      const sh = shrunk[x.sig];
      if (sh) say(`    shrunk: ${sh.file} (${sh.steps} steps, ${sh.actions} actions; first violation there: ${sh.firstInShrunk}) — ${sh.message}`);
      say('');
    }
  };
  show(core, 'VIOLATIONS (profiles: instant, calm, flaky, outage, partial, slowread)');
  show(rare, 'ONLY WITH A SELL OF UNKNOWN OUTCOME THAT HAD LANDED (ghost) OR A CRASH (crash)');
  if (Object.keys(agg.notes).length) {
    const notes = Object.entries(agg.notes).sort((a, b) => b[1] - a[1]);
    const line = ([k, n]: [string, number]) => say(`    ${n}×  ${k}   (seeds ${agg.noteSeeds[k]!.slice(0, 5).join(', ')})`);
    const undocumented = notes.filter(([k]) => k.startsWith('estimate-kept:'));
    const documented = notes.filter(([k]) => !k.startsWith('estimate-kept:'));
    if (undocumented.length) {
      say('counted, not flagged (not documented: a real trade stays booked at its quote, History and the profit with it; see cases/14):');
      undocumented.forEach(line);
    }
    if (documented.length) {
      say('documented outcomes (not counted as violations):');
      documented.forEach(line);
    }
    say('');
  }
  const failedCodes = new Set(sigs.map((s) => s.sig.split(':')[0]!));
  say('invariants that never failed:');
  for (const [code, [inv, what]] of Object.entries(INVARIANTS)) if (!failedCodes.has(code)) say(`    ${code.padEnd(4)} (${inv}) ${what}`);
  if (agg.harnessErrors.length) {
    say('');
    say(`scenarios that ended with an exception: ${agg.harnessErrors.length}`);
    for (const h of agg.harnessErrors.slice(0, 5)) say(`    seed ${h.seed}: ${h.error.split('\n').slice(0, 3).join(' | ')}`);
  }
  writeFileSync(join(out, 'summary.json'), json({ commit, dirty, from, seeds, steps, gen, ranIn, agg, shrunk }));
  writeFileSync(join(out, 'report.txt'), lines.join('\n'));
  say('');
  say(`details: ${join(out, 'summary.json').replace(`${REPO}/`, '')}; one seed: npx tsx e2e/fuzz/fuzz.ts --seed N ${steps}${gen.core ? ' --core' : ''}${gen.profile ? ` --profile ${gen.profile}` : ''}`);
  process.exitCode = sigs.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
