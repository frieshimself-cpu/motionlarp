// Makes a failing scenario as small as it can while it still shows the same violation.
//
// The scenario is first "frozen": the market's outcomes of the failing run (which sells failed, how long each
// took) are written into it, so nothing is random any more. Then, as long as the same violation still shows:
// cut the steps after it, turn actions into plain clock ticks, make market outcomes ordinary, drop ticks, drop
// copies, users and rules.
import { CALM_OP, type OpPlan, type StatusPlan, type Tape, type TipPlan } from './market.js';
import { runScenario, type RunResult } from './run.js';
import type { Scenario, Step } from './scenario.js';

export interface Shrunk { scenario: Scenario; result: RunResult; runs: number; reproduced: boolean }

const clone = <T>(v: T): T => structuredClone(v);
const isCalm = (p: OpPlan | undefined) => !p || (!p.fail && !p.part && !p.ghost && !p.refineNull && !p.quoted && p.late === undefined && p.L1 === CALM_OP.L1 && p.L2 === CALM_OP.L2 && p.L3 === CALM_OP.L3);
/** A status read's plan as an object (old tapes hold a number: how many blocks behind). */
const statusPlan = (s: StatusPlan | number | null | undefined): StatusPlan | null => (typeof s === 'number' ? { lag: s } : s ?? null);
/** What a status read's or a tip read's plan costs a reader: the node's oddities more than the time it took. */
const statusCost = (s: StatusPlan | number | null | undefined) => { const p = statusPlan(s); return p ? (p.lag ? 50 : 0) + (p.fork ? 50 : 0) + (p.conf ? 30 : 0) + (p.noSlot ? 30 : 0) + (p.L ? 5 : 0) : 0; };
const tipCost = (t: TipPlan | null | undefined) => (t ? (t.behind ? 40 : 0) + (t.L ? 5 : 0) : 0);

function opCost(p: OpPlan | undefined): number {
  if (!p) return 0;
  return (p.fail ? 300 : 0) + (p.part ? 200 : 0) + (p.ghost ? 200 : 0) + (p.late !== undefined ? 200 : 0) + (p.refineNull ? 100 : 0) + (p.L1 !== CALM_OP.L1 ? 100 : 0) + (p.L2 !== CALM_OP.L2 ? 100 : 0) + (p.L3 !== CALM_OP.L3 ? 50 : 0);
}
const dtCost = (dt: number) => (dt % 1_000 === 0 ? 0 : dt % 500 === 0 ? 1 : dt % 100 === 0 ? 2 : 3);

/** Smaller is simpler to read: fewer things happening, fewer odd market outcomes, fewer and plainer rules. */
function size(sc: Scenario): number {
  const tape = sc.tape;
  const odd = tape ? tape.buy.reduce((a, p) => a + opCost(p), 0) + tape.sell.reduce((a, p) => a + opCost(p), 0) + tape.quote.filter((q) => q && (q.fail || q.L !== 50)).length * 100 + tape.bal.filter((b) => b && (b.fail || b.L)).length * 100 + (tape.db ?? []).filter(Boolean).length * 150 + (tape.status ?? []).reduce<number>((a, s) => a + statusCost(s), 0) + (tape.tip ?? []).reduce<number>((a, t) => a + tipCost(t), 0) : 0;
  // (a window of a full disk, or a slow period of the chain, costs more the longer it lasts)
  const full = (sc.db?.full ?? []).reduce((a, w) => a + 300 + Math.round(w.ms / 100), 0) + (sc.slow ?? []).reduce((a, w) => a + 300 + Math.round(w.ms / 1_000), 0);
  const rules = sc.copies.reduce((a, c) => a + JSON.stringify(c.input).length, 0);
  const knobs = (sc.priceMs !== 0 ? 5 : 0) + (sc.retry !== 'prod' ? 5 : 0) + (sc.maxSolPerBuy !== 30 ? 5 : 0) + (sc.overAsk !== 'strict' ? 5 : 0) + sc.mints.filter((m) => m !== 1_000_000).length * 5
    + sc.users.filter((u) => u.feeBps !== 0).length * 20 + (sc.finale.dump ? 200 : 0) + (sc.finale.leadersExit ? 200 : 0);
  return sc.steps.filter((s) => s.act.a !== 'tick').length * 1_000 + sc.steps.length * 100 + sc.steps.reduce((a, s) => a + dtCost(s.dt), 0) + odd + full + sc.copies.length * 2_000 + sc.users.length * 1_500 + sc.mints.length * 500 + rules + knobs;
}

export async function shrink(start: Scenario, sig: string, budget = 600, log: (s: string) => void = () => undefined): Promise<Shrunk> {
  let runs = 0;
  const first = await runScenario(clone(start), { fullTranscript: true });
  runs++;
  let best: Scenario = { ...clone(start), tape: clone(first.tape) };
  let bestRes = await runScenario(clone(best), { fullTranscript: true });
  runs++;
  if (!bestRes.violations.some((v) => v.sig === sig)) return { scenario: best, result: first, runs, reproduced: false };

  const attempt = async (cand: Scenario): Promise<boolean> => {
    if (runs >= budget) return false;
    runs++;
    let res: RunResult;
    try {
      res = await runScenario(clone(cand), { fullTranscript: true });
    } catch {
      return false;
    }
    if (!res.violations.some((v) => v.sig === sig)) return false;
    if (size(cand) >= size(best)) return false;
    best = cand;
    bestRes = res;
    return true;
  };

  /** Tries `apply` on chunks of indexes [0, n): halves first, then smaller, down to singles. */
  const chunks = async (n: () => number, apply: (sc: Scenario, from: number, to: number) => boolean): Promise<boolean> => {
    let any = false;
    for (let width = Math.max(1, Math.ceil(n() / 2)); width >= 1; width = width === 1 ? 0 : Math.ceil(width / 2)) {
      for (let from = 0; from < n(); ) {
        if (runs >= budget) return any;
        const cand = clone(best);
        const changed = apply(cand, from, Math.min(n(), from + width));
        if (changed && (await attempt(cand))) any = true; // the list shrank or changed: stay at the same place
        else from += width;
      }
    }
    return any;
  };

  for (let round = 0; round < 6 && runs < budget; round++) {
    const before = size(best);

    // 1. Nothing after the step that showed it.
    const v = bestRes.violations.find((x) => x.sig === sig)!;
    if (v.step >= 0 && v.step < best.steps.length - 1) await attempt({ ...clone(best), steps: clone(best.steps.slice(0, v.step + 1)) });
    if (best.finale.dump) await attempt({ ...clone(best), finale: { ...best.finale, dump: false } });
    if (best.finale.leadersExit) await attempt({ ...clone(best), finale: { ...best.finale, leadersExit: false } });

    // 2. Actions become plain ticks (the clock keeps its times).
    await chunks(() => best.steps.length, (sc, from, to) => {
      let changed = false;
      for (let i = from; i < to; i++) if (sc.steps[i]!.act.a !== 'tick') { sc.steps[i]!.act = { a: 'tick' }; changed = true; }
      return changed;
    });

    // 3. Market outcomes become ordinary (a prompt success).
    for (const kind of ['sell', 'buy'] as const) {
      await chunks(() => best.tape![kind].length, (sc, from, to) => {
        let changed = false;
        for (let i = from; i < to; i++) if (!isCalm(sc.tape![kind][i])) { sc.tape![kind][i] = { ...CALM_OP }; changed = true; }
        return changed;
      });
    }
    await chunks(() => best.tape!.quote.length, (sc, from, to) => {
      let changed = false;
      for (let i = from; i < to; i++) { const q = sc.tape!.quote[i]; if (q && (q.fail || q.L !== 50)) { sc.tape!.quote[i] = { L: 50 }; changed = true; } }
      return changed;
    });
    if (best.tape!.bal.some((b) => b && (b.fail || b.L))) await attempt({ ...clone(best), tape: { ...clone(best.tape!), bal: [] } });
    await chunks(() => best.tape!.bal.length, (sc, from, to) => {
      let changed = false;
      for (let i = from; i < to; i++) { const b = sc.tape!.bal[i]; if (b && (b.fail || b.L)) { sc.tape!.bal[i] = null; changed = true; } }
      return changed;
    });
    // Reads of the chain (a tip read, a status read of a sell): as few odd ones as still show it (a hole: answered at
    // once by an up-to-date node), then each as plain as it can be (no node oddity it does not need, as little behind as
    // it can be, no time taken).
    for (const kind of ['status', 'tip'] as const) {
      await chunks(() => best.tape![kind]?.length ?? 0, (sc, from, to) => {
        let changed = false;
        for (let i = from; i < to; i++) if (sc.tape![kind]![i]) { sc.tape![kind]![i] = null; changed = true; }
        return changed;
      });
    }
    for (let i = 0; i < (best.tape!.status?.length ?? 0) && runs < budget; i++) {
      const cur = statusPlan(best.tape!.status![i]);
      if (!cur) continue;
      for (const key of ['fork', 'conf', 'noSlot', 'L'] as const) {
        const now = statusPlan(best.tape!.status![i]);
        if (!now?.[key] || runs >= budget) continue;
        const cand = clone(best);
        const { [key]: _gone, ...rest } = now;
        cand.tape!.status![i] = rest;
        await attempt(cand);
      }
      for (let lag = statusPlan(best.tape!.status![i])?.lag ?? 0; lag > 1 && runs < budget; ) {
        const cand = clone(best);
        cand.tape!.status![i] = { ...statusPlan(best.tape!.status![i])!, lag: Math.ceil(lag / 2) };
        if (!(await attempt(cand))) break;
        lag = statusPlan(best.tape!.status![i])?.lag ?? 0;
      }
    }
    for (let i = 0; i < (best.tape!.tip?.length ?? 0) && runs < budget; i++) {
      for (const key of ['behind', 'L'] as const) {
        const now = best.tape!.tip![i];
        if (!now?.[key] || runs >= budget) continue;
        const cand = clone(best);
        const { [key]: _gone, ...rest } = now;
        cand.tape!.tip![i] = rest;
        await attempt(cand);
      }
    }
    // Slow periods of the chain: fewer, then shorter.
    for (let i = (best.slow?.length ?? 0) - 1; i >= 0 && runs < budget; i--) {
      const cand = clone(best);
      cand.slow!.splice(i, 1);
      if (!cand.slow!.length) delete cand.slow;
      await attempt(cand);
    }
    for (let i = 0; i < (best.slow?.length ?? 0) && runs < budget; i++) {
      for (;;) {
        const w = best.slow![i]!;
        if (w.ms <= 20_000) break;
        const cand = clone(best);
        cand.slow![i] = { ...w, ms: Math.round(w.ms / 2) };
        if (!(await attempt(cand))) break;
      }
    }
    // Database writes that fail (dbfault): as few as still show it.
    await chunks(() => best.tape!.db?.length ?? 0, (sc, from, to) => {
      let changed = false;
      for (let i = from; i < to; i++) if (sc.tape!.db![i]) { sc.tape!.db![i] = null; changed = true; }
      return changed;
    });
    // Windows of a full disk (diskfull): fewer, then shorter.
    for (let i = (best.db?.full?.length ?? 0) - 1; i >= 0 && runs < budget; i--) {
      const cand = clone(best);
      cand.db!.full!.splice(i, 1);
      await attempt(cand);
    }
    for (let i = 0; i < (best.db?.full?.length ?? 0) && runs < budget; i++) {
      for (;;) {
        const w = best.db!.full![i]!;
        if (w.ms <= 200) break;
        const cand = clone(best);
        // (half as long, from the same start or ending at the same time)
        cand.db!.full![i] = { ...w, ms: Math.round(w.ms / 2) };
        if (await attempt(cand)) continue;
        const late = clone(best);
        late.db!.full![i] = { ...w, at: w.at + Math.round(w.ms / 2), ms: w.ms - Math.round(w.ms / 2) };
        if (!(await attempt(late))) break;
      }
    }
    // …then each remaining odd outcome keeps only what matters: failure → success, slow → prompt.
    for (const kind of ['sell', 'buy'] as const) {
      for (let i = 0; i < best.tape![kind].length && runs < budget; i++) {
        const p = best.tape![kind][i];
        if (isCalm(p)) continue;
        for (const patch of [{ L2: 0 }, { L3: CALM_OP.L3 }, { L1: CALM_OP.L1 }, { refineNull: undefined }, { part: undefined }, { ghost: undefined }, { late: undefined }] as Partial<OpPlan>[]) {
          const cur = best.tape![kind][i]!;
          const key = Object.keys(patch)[0] as keyof OpPlan;
          if (cur[key] === patch[key]) continue;
          const cand = clone(best);
          cand.tape![kind][i] = { ...cur, ...patch };
          await attempt(cand);
        }
      }
    }

    // 4. Ticks that are not needed go (their time is added to the next step).
    await chunks(() => best.steps.length, (sc, from, to) => {
      const keep: Step[] = [];
      let carry = 0;
      let changed = false;
      sc.steps.forEach((s, i) => {
        if (i >= from && i < to && s.act.a === 'tick' && i < sc.steps.length - 1) { carry += s.dt; changed = true; return; }
        keep.push({ ...s, dt: s.dt + carry });
        carry = 0;
      });
      sc.steps = keep;
      return changed;
    });

    // 5. Fewer copies, users, coins; simpler rules.
    for (let i = best.copies.length - 1; i >= 0 && best.copies.length > 1; i--) {
      const cand = clone(best);
      cand.copies.splice(i, 1);
      await attempt(cand);
    }
    if (best.users.length > 1) {
      const cand = clone(best);
      cand.users = cand.users.slice(0, 1);
      await attempt(cand);
    }
    if (best.mints.length > 1) {
      const cand = clone(best);
      cand.mints = cand.mints.slice(0, 1);
      await attempt(cand);
    }
    for (let u = 0; u < best.users.length; u++) {
      if (best.users[u]!.feeBps !== 0) { const cand = clone(best); cand.users[u]!.feeBps = 0; await attempt(cand); }
    }
    for (let c = 0; c < best.copies.length && runs < budget; c++) {
      const edits: ((input: Record<string, unknown>) => boolean)[] = [
        (i) => { const s = i.sell as Record<string, unknown>; if (!(s.stopLoss as unknown[])?.length) return false; s.stopLoss = []; return true; },
        (i) => { const s = i.sell as Record<string, { enabled: boolean }>; if (!s.deadCoin?.enabled) return false; s.deadCoin = { ...s.deadCoin, enabled: false }; return true; },
        (i) => { const s = i.sell as Record<string, { enabled: boolean }>; if (!s.mirror?.enabled) return false; s.mirror = { ...s.mirror, enabled: false }; return true; },
        (i) => { const s = i.sell as Record<string, unknown[]>; if (!s.timed?.length) return false; s.timed = []; return true; },
        (i) => { const s = i.sell as Record<string, unknown[]>; if ((s.timed?.length ?? 0) < 2) return false; s.timed = s.timed!.slice(0, -1); return true; },
        (i) => { const s = i.sell as Record<string, unknown[]>; if ((s.timed?.length ?? 0) < 2) return false; s.timed = s.timed!.slice(1); return true; },
        (i) => { const s = i.sell as Record<string, unknown[]>; if ((s.stopLoss?.length ?? 0) < 2) return false; s.stopLoss = s.stopLoss!.slice(0, 1); return true; },
        (i) => { if (i.priorityFeeSol === 0 && i.tipSol === 0 && i.sellPriorityFeeSol === 0 && i.sellTipSol === 0) return false; Object.assign(i, { priorityFeeSol: 0, tipSol: 0, sellPriorityFeeSol: 0, sellTipSol: 0 }); return true; },
        (i) => { if (i.minLeaderBuySol === 0) return false; i.minLeaderBuySol = 0; return true; },
        (i) => { if (i.oncePerCoin === false) return false; i.oncePerCoin = false; return true; },
        (i) => { if (i.buySol === 1) return false; i.buySol = 1; return true; },
        (i) => { if (i.slippagePct === 100) return false; i.slippagePct = 100; return true; },
      ];
      for (const edit of edits) {
        const cand = clone(best);
        if (edit(cand.copies[c]!.input)) await attempt(cand);
      }
    }
    for (const patch of [{ priceMs: 0 }, { retry: 'prod' as const }, { maxSolPerBuy: 30 }, { overAsk: 'strict' as const }]) {
      const key = Object.keys(patch)[0] as keyof Scenario;
      if (best[key] !== (patch as Record<string, unknown>)[key]) await attempt({ ...clone(best), ...patch });
    }
    // Ordinary prices: one SOL buys a million tokens.
    if (best.mints.some((m) => m !== 1_000_000)) await attempt({ ...clone(best), mints: best.mints.map(() => 1_000_000) });
    // Round step times.
    for (let i = 0; i < best.steps.length && runs < budget; i++) {
      const dt = best.steps[i]!.dt;
      for (const round of [1_000, 500, 100]) {
        const r = Math.max(round, Math.round(dt / round) * round);
        if (r === dt) break;
        const cand = clone(best);
        cand.steps[i]!.dt = r;
        if (await attempt(cand)) break;
      }
    }
    log(`  shrink round ${round + 1}: size ${before} → ${size(best)} (${runs} runs)`);
    if (size(best) >= before) break;
  }
  return { scenario: best, result: bestRes, runs, reproduced: true };
}

export function tapeSummary(t: Tape | undefined, db?: Scenario['db'], slow?: Scenario['slow']): string {
  if (!t) return 'random';
  const at = (p: OpPlan) => `at its last valid height ${p.late! < 0 ? '−' : '+'}${Math.abs(p.late!)}`;
  const lands = (p: OpPlan) => (p.late !== undefined ? `lands LATE, ${at(p)}` : `lands after ${p.L1} ms`);
  const odd = (list: OpPlan[]) => list.map((p, i) => (isCalm(p) ? null : `#${i + 1}: ${p.fail ? `fails (${p.fail})${p.ghost ? ` but ${lands(p)}` : p.late !== undefined ? `, told ${at(p)}` : ''}` : `${lands(p)}, engine told ${p.L2} ms later${p.part ? `, fills ${p.part * 100}%` : ''}${p.quoted ? `, handed back with the quote's coin count (the wallet got ${p.quoted}x of it)` : ''}${p.refineNull ? ', exact SOL never read' : `, exact SOL ${p.L3} ms after that`}`}`)).filter(Boolean);
  const out = [`buys: ${odd(t.buy).join('; ') || 'all ordinary'}`, `sells: ${odd(t.sell).join('; ') || 'all ordinary'}`];
  const ms = (L?: number) => (L ? `${L >= 1_000 ? `${(L / 1_000).toFixed(1)} s` : `${L} ms`}` : 'at once');
  const status = (t.status ?? []).map((s, i) => {
    const p = statusPlan(s);
    if (!p || (!p.lag && !p.fork && !p.conf && !p.noSlot && (p.L ?? 0) < 1_000)) return null;
    return `#${i + 1}: ${[ms(p.L), p.lag ? `${p.lag} blocks behind` : '', p.fork ? `on a fork, the main fork's last ${p.fork} unseen` : '', p.conf ? `${p.conf} behind on confirmations` : '', p.noSlot ? 'no slot' : ''].filter(Boolean).join(', ')}`;
  }).filter(Boolean);
  if (status.length) out.push(`status reads (odd ones): ${status.join('; ')}`);
  const tips = (t.tip ?? []).map((p, i) => (p && (p.behind || (p.L ?? 0) >= 1_000) ? `#${i + 1}: ${[ms(p.L), p.behind ? `${p.behind} blocks behind` : ''].filter(Boolean).join(', ')}` : null)).filter(Boolean);
  if (tips.length) out.push(`tip reads (odd ones): ${tips.join('; ')}`);
  const writes = (t.db ?? []).map((d, i) => (d ? `#${i + 1} (${d.m ?? '?'}): ${d.err === 'io' ? 'disk I/O error' : 'database or disk is full'}` : null)).filter(Boolean);
  if (writes.length) out.push(`database writes that fail: ${writes.join('; ')}`);
  if (db?.full?.length) out.push(`disk full: ${db.full.map((w) => `+${(w.at / 1000).toFixed(3)}s for ${w.ms / 1000}s`).join('; ')}`);
  if (slow?.length) out.push(`slow chain: ${slow.map((w) => `+${(w.at / 1000).toFixed(3)}s for ${Math.round(w.ms / 1000)}s, a block every ${w.blockMs} ms`).join('; ')}`);
  return out.join(' | ');
}
