#!/usr/bin/env node
'use strict';
// Prints what the last run wrote to .run/report-<size>.json in a form a person can read.
//   node e2e/buttons/report.cjs            failed checks, layout, clicks that could not land, errors
//   node e2e/buttons/report.cjs --passed   also every check that passed
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, '.run');
const showPassed = process.argv.includes('--passed');
const short = (v, n = 700) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? `${s.slice(0, n)}…` : s; };

// Every size the last runs wrote a report for, widest first.
const SIZES = ['desktop', 'phone', 'phone-360', 'phone-320'];
const found = fs.existsSync(OUT) ? fs.readdirSync(OUT).map((f) => /^report-(.+)\.json$/.exec(f)?.[1]).filter(Boolean) : [];
for (const size of [...SIZES, ...found.filter((s) => !SIZES.includes(s)).sort()]) {
  const file = path.join(OUT, `report-${size}.json`);
  if (!fs.existsSync(file)) { console.log(`\n(no report for ${size})`); continue; }
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\n══════════ ${size} ══════════  commit ${r.git.commit}${r.git.dirty.length ? ` + ${r.git.dirty.length} uncommitted changes` : ' (clean)'}  finished ${r.finishedAt}`);
  console.log(`checks passed ${r.pass.length}, failed ${r.fail.length}; page errors ${r.pageErrors.length}; console errors ${r.consoleErrors.length}; unexpected HTTP errors ${r.httpErrors.filter((h) => !h.provoked).length} (provoked on purpose: ${r.httpErrors.filter((h) => h.provoked).length}); failed requests ${r.requestFailed.length}; requests to other sites ${r.external.length}; dialogs nobody planned ${r.dialogs.filter((d) => !d.planned).length}; calls to the Jupiter stand-in ${r.stubHits}`);
  console.log('\n── failed checks ──');
  for (const f of r.fail) console.log(`✗ [${f.step}] ${f.name}\n     ${short(f.evidence)}`);
  console.log('\n── wider than the screen ──');
  const seen = new Map();
  for (const l of r.layout) for (const o of l.offenders) {
    const k = `${o.el}|${o.inside || ''}`;
    const e = seen.get(k) || { ...o, screens: new Set(), layoutWidth: l.layoutWidth };
    e.screens.add(l.screen);
    seen.set(k, e);
  }
  for (const e of seen.values()) console.log(`  ${e.el}  "${e.text.slice(0, 40)}"  x ${e.left}…${e.right} on a ${e.viewport}px screen${e.inside ? ` (inside the sideways-scrolling ${e.inside})` : ''}  [${[...e.screens].slice(0, 6).join(', ')}${e.screens.size > 6 ? ', …' : ''}]`);
  if (!seen.size) console.log('  (nothing)');
  console.log('\n── clicks that could not land where the control is drawn ──');
  const bc = new Map();
  for (const b of r.blockedClicks || []) { const k = b.control; const e = bc.get(k) || { ...b, n: 0 }; e.n += 1; bc.set(k, e); }
  for (const e of bc.values()) console.log(`  ${e.control} ×${e.n}  covered by: ${e.coveredBy}  box ${JSON.stringify(e.box)}  [first in: ${e.step}]`);
  if (!bc.size) console.log('  (none)');
  console.log('\n── texts like undefined / NaN / null / [object Object] ──');
  for (const b of r.badTexts) console.log(`  ${b.screen}: ${short(b.items, 400)}`);
  if (!r.badTexts.length) console.log('  (none)');
  for (const [title, list] of [['page errors', r.pageErrors], ['console errors', r.consoleErrors], ['unexpected HTTP errors', r.httpErrors.filter((h) => !h.provoked)], ['failed requests', r.requestFailed], ['requests to other sites', r.external], ['dialogs nobody planned', r.dialogs.filter((d) => !d.planned)]]) {
    console.log(`\n── ${title} ──`);
    for (const x of list.slice(0, 30)) console.log(`  ${short(x, 400)}`);
    if (!list.length) console.log('  (none)');
  }
  console.log('\n── controls seen on a screen but never clicked or typed into ──');
  for (const c of r.inventory.filter((x) => !x.touched)) console.log(`  ${c.control}  [${c.screens.slice(0, 4).join(', ')}]`);
  console.log(`  (${r.inventory.filter((x) => x.touched).length} kinds of control were used)`);
  console.log('\n── notes ──');
  for (const n of r.notes) console.log(`  [${n.step}] ${n.name}: ${short(n.detail, 500)}`);
  if (showPassed) { console.log('\n── passed ──'); for (const p of r.pass) console.log(`✓ [${p.step}] ${p.name}`); }
}
