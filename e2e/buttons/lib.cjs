'use strict';
// Helpers for the browser suite: a results book, page instrumentation (errors, console, network, dialogs),
// layout and bad-text detectors, number parsing.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

class Book {
  constructor(name, outDir) {
    this.name = name;
    this.outDir = outDir;
    this.pass = [];
    this.fail = [];
    this.notes = [];
    this.step = 'start';
    this.pageErrors = [];
    this.consoleErrors = [];
    this.requestFailed = [];
    this.httpErrors = [];
    this.dialogs = [];
    this.external = [];
    this.layout = [];
    this.badTexts = [];
    this.blockedClicks = [];
    /** While true, failing requests are the suite's own doing (an outage it stages). */
    this.staged = false;
    this.inventory = new Map(); // descriptor -> Set(screens)
    this.touched = new Set();
    this.allowed = []; // [{ status, re, step }]
    fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  }
  log(msg) { process.stdout.write(`[${this.name}] ${msg}\n`); }
  begin(step) { this.step = step; this.allowed = this.allowed.filter((a) => a.sticky); this.log(`— ${step}`); }
  /** A failed request the step provokes on purpose. */
  allow(status, re, sticky = false) { this.allowed.push({ status, re, sticky }); }
  ok(name, cond, evidence) {
    if (cond) { this.pass.push({ step: this.step, name }); return true; }
    const ev = typeof evidence === 'function' ? evidence() : evidence;
    this.fail.push({ step: this.step, name, evidence: ev });
    this.log(`  FAIL ${name} ${ev === undefined ? '' : util.inspect(ev, { depth: 6, breakLength: 200 }).slice(0, 1200)}`);
    return false;
  }
  eq(name, actual, expected) { return this.ok(name, util.isDeepStrictEqual(actual, expected), { actual, expected }); }
  note(name, detail) { this.notes.push({ step: this.step, name, detail }); this.log(`  NOTE ${name} ${detail === undefined ? '' : util.inspect(detail, { depth: 6, breakLength: 200 }).slice(0, 1200)}`); }
  async shot(page, name) {
    const file = path.join(this.outDir, 'shots', `${this.name}-${name.replace(/[^a-z0-9_-]+/gi, '_')}.png`);
    await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
    return file;
  }
  toJSON() {
    return {
      name: this.name, pass: this.pass, fail: this.fail, notes: this.notes, pageErrors: this.pageErrors, consoleErrors: this.consoleErrors,
      requestFailed: this.requestFailed, httpErrors: this.httpErrors, dialogs: this.dialogs, external: this.external, layout: this.layout, badTexts: this.badTexts, blockedClicks: this.blockedClicks,
      inventory: [...this.inventory].map(([k, v]) => ({ control: k, screens: [...v], touched: this.touched.has(k) })),
    };
  }
}

/** What the page-side recorder calls a control (stable across rows and re-renders). */
const DESCRIPTOR_SRC = `(el) => {
  const tag = el.tagName.toLowerCase();
  const keep = ['data-v', 'data-tab', 'data-preset', 'data-add', 'data-use-preset', 'data-preset-open', 'data-rule'];
  const scopeEl = el.closest('[data-rule]');
  const scope = el.closest('#timed-rows') ? 'timed-row ' : el.closest('#stop-rows') ? 'stop-row ' : scopeEl && scopeEl !== el ? 'rule:' + scopeEl.dataset.rule + ' ' : '';
  if (el.id) return tag + '#' + el.id;
  const data = [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => (keep.includes(a.name) ? '[' + a.name + '=' + a.value + ']' : '[' + a.name + ']')).join('');
  if (data) return scope + tag + data;
  if (tag === 'a') {
    if (el.classList.contains('brand')) return 'a.brand';
    if (el.hostname && el.hostname !== location.hostname) return 'a:external ' + el.hostname;
    return 'a:' + el.textContent.trim().slice(0, 30);
  }
  if (tag === 'input' || tag === 'textarea') return scope + tag + ':' + (el.getAttribute('aria-label') || el.name || el.type);
  return scope + tag + ':' + el.textContent.trim().slice(0, 30);
}`;

/** Records every control a click, a keystroke or a change lands on (so the report can say what was never used). */
const RECORDER = `(() => {
  const describe = ${DESCRIPTOR_SRC};
  const hit = (e) => {
    let el = e.target instanceof Element ? e.target.closest('button, a, input, textarea, select, label') : null;
    if (!el) return;
    if (el.tagName === 'LABEL') el = el.querySelector('input') || el;
    try { window.__touch(describe(el)); } catch {}
  };
  for (const t of ['click', 'input', 'change']) document.addEventListener(t, hit, true);
})();`;

async function instrument(context, page, book, tag) {
  await page.exposeBinding('__touch', (_src, d) => { book.touched.add(d); }).catch(() => undefined);
  await page.addInitScript(RECORDER);
  page.__tag = tag;
  page.__dialogPlan = [];
  page.__api = [];
  page.on('pageerror', (e) => { book.pageErrors.push({ tag, step: book.step, message: String(e && e.stack ? e.stack : e).slice(0, 600) }); book.log(`  PAGE ERROR (${tag}) ${String(e).slice(0, 300)}`); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const url = (m.location() || {}).url || '';
    // Chrome writes one of these for every HTTP error; it is judged with the response itself below.
    if (/Failed to load resource: the server responded with a status of \d+/.test(text)) return;
    if (book.staged && /Failed to load resource/.test(text)) return;
    book.consoleErrors.push({ tag, step: book.step, text: text.slice(0, 500), url });
    book.log(`  CONSOLE ERROR (${tag}) ${text.slice(0, 300)}`);
  });
  page.on('requestfailed', (r) => {
    const failure = (r.failure() || {}).errorText || '';
    if (book.staged) return;
    // A navigation or reload cuts off the page's own polling: not a failure of the site.
    if (/ERR_ABORTED/.test(failure) && /\/api\/(state|history|admin\/state|admin\/connections|config)/.test(r.url())) return;
    book.requestFailed.push({ tag, step: book.step, method: r.method(), url: r.url(), failure });
  });
  page.on('response', async (r) => {
    const url = r.url();
    const status = r.status();
    if (/\/api\//.test(url)) {
      let body = '';
      try { body = await r.text(); } catch { body = ''; }
      page.__api.push({ at: Date.now(), method: r.request().method(), url, status, body, sent: r.request().postData() });
      if (page.__api.length > 4000) page.__api.splice(0, 1000);
    }
    if (status < 400) return;
    const p = new URL(url).pathname;
    // "Am I logged in?" is asked with a request that answers 401: the app's own way of showing the login form.
    if (status === 401 && /^\/api\/(state|history|admin\/state|admin\/connections)$/.test(p)) return;
    const allowed = book.staged ? { staged: true } : book.allowed.find((a) => a.status === status && a.re.test(p));
    book.httpErrors.push({ tag, step: book.step, method: r.request().method(), path: p, status, provoked: !!allowed });
    if (!allowed) book.log(`  UNEXPECTED HTTP ${status} ${r.request().method()} ${p} (${tag})`);
  });
  page.on('dialog', async (d) => {
    const plan = page.__dialogPlan.shift();
    const rec = { tag, step: book.step, type: d.type(), message: d.message(), planned: !!plan };
    book.dialogs.push(rec);
    page.__lastDialog = rec;
    try {
      if (!plan) { book.log(`  UNPLANNED DIALOG (${tag}) ${d.type()}: ${d.message().slice(0, 200)}`); await d.accept(); return; }
      if (plan.accept === false) await d.dismiss();
      else await d.accept(plan.text);
    } catch { /* the page went away */ }
  });
}

/** The next dialog on this page: accept or dismiss it (a prompt gets `text`). */
function planDialog(page, plan) { page.__dialogPlan.push(plan); }

/** The JSON bodies the page received from an API path since `since`. */
function apiCalls(page, re, since = 0) { return page.__api.filter((c) => c.at >= since && re.test(new URL(c.url).pathname)); }

// ── detectors run inside the page ───────────────────────────────────────
const LAYOUT_SRC = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const seen = new Set();
  const sideScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX)) return p; } return null; };
  for (const el of document.querySelectorAll('body *')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.position === 'fixed' && el.classList.contains('backdrop')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right > vw + 1 || r.left < -1) {
      if (el.closest('[hidden]')) continue;
      let parentBad = false;
      for (let p = el.parentElement; p; p = p.parentElement) if (seen.has(p)) { parentBad = true; break; }
      seen.add(el);
      if (parentBad) continue;
      const sc = sideScroller(el);
      out.push({
        el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
        text: (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 70),
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), viewport: vw,
        inside: sc ? sc.tagName.toLowerCase() + (sc.id ? '#' + sc.id : '') + (typeof sc.className === 'string' && sc.className ? '.' + sc.className.trim().split(/\\s+/).join('.') : '') : null,
      });
    }
  }
  return { viewport: vw, pageScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, layoutWidth: window.innerWidth, offenders: out.slice(0, 40) };
})()`;

const BADTEXT_SRC = `(() => {
  const bad = /(^|[^A-Za-z0-9_])(undefined|NaN|null|Infinity)([^A-Za-z0-9_]|$)|\\[object Object\\]/;
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue;
    if (!t || !bad.test(t)) continue;
    const p = n.parentElement;
    if (!p || p.closest('script, style')) continue;
    out.push({ where: p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (typeof p.className === 'string' && p.className ? '.' + p.className.trim().split(/\\s+/).join('.') : ''), text: t.trim().slice(0, 160) });
  }
  for (const el of document.querySelectorAll('body *')) {
    for (const a of ['value', 'title', 'placeholder', 'aria-label', 'href', 'style']) {
      const v = a === 'value' ? (el.value !== undefined && typeof el.value === 'string' ? el.value : null) : el.getAttribute(a);
      if (v && bad.test(v)) out.push({ where: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '[' + a + ']', text: String(v).slice(0, 160) });
    }
  }
  return out.slice(0, 40);
})()`;

const INVENTORY_SRC = `(() => {
  const describe = ${DESCRIPTOR_SRC};
  const out = [];
  for (const el of document.querySelectorAll('button, a[href], input, textarea, select')) {
    if (el.closest('[hidden]')) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    out.push(describe(el));
  }
  return [...new Set(out)];
})()`;

/** Looks at the screen as it stands: sideways overflow, bad texts, and what controls it has. */
async function screenCheck(page, book, screen, opts = {}) {
  let layout, bad, inv;
  try {
    [layout, bad, inv] = await Promise.all([page.evaluate(LAYOUT_SRC), page.evaluate(BADTEXT_SRC), page.evaluate(INVENTORY_SRC)]);
  } catch (err) {
    book.note(`screenCheck ${screen} could not run`, String(err).slice(0, 200));
    return;
  }
  for (const d of inv) { if (!book.inventory.has(d)) book.inventory.set(d, new Set()); book.inventory.get(d).add(screen); }
  const offenders = layout.offenders.filter((o) => !(opts.ignoreInside || []).some((re) => re.test(o.inside || '')));
  if (offenders.length || layout.pageScrollWidth > layout.viewport + 1) {
    book.layout.push({ screen, step: book.step, viewport: layout.viewport, pageScrollWidth: layout.pageScrollWidth, layoutWidth: layout.layoutWidth, offenders });
  }
  if (bad.length) book.badTexts.push({ screen, step: book.step, items: bad });
  if (opts.shot !== false) await book.shot(page, screen);
}

// ── numbers as the pages print them ─────────────────────────────────────
/** "+0.2693", "−0.25", "-0.0004", "0" → number (null when there is none). */
function shown(text) {
  if (text === null || text === undefined) return null;
  const m = /([+−-]?)\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(String(text).replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] === '−' || m[1] === '-' ? -n : n;
}
function signOf(text) { const m = /([+−-])\s*\d/.exec(String(text)); return m ? m[1] : ''; }

/** Lamports → SOL as an exact decimal string. */
function solStr(l) {
  const big = BigInt(l);
  const neg = big < 0n;
  const a = neg ? -big : big;
  const s = `${a / 1_000_000_000n}.${String(a % 1_000_000_000n).padStart(9, '0')}`.replace(/\.?0+$/, '');
  return (neg ? '-' : '') + (s || '0');
}
const solNum = (l) => Number(BigInt(l)) / 1e9;

/** Is `text` the number `exact`, rounded to `d` decimals (2 from 100 up, as the site prints them)? */
function matches(text, exact, d = 4) {
  const n = shown(text);
  if (n === null) return false;
  const dd = Math.abs(exact) >= 100 ? 2 : d;
  return Math.abs(n - exact) <= 0.5 * 10 ** -dd + 1e-12;
}

/** The site's own "5m ago" wording, for a time and a moment of looking; one unit of slack either way. */
function agoMatches(text, ms, now = Date.now()) {
  const m = /(\d+)([smhd]) ago/.exec(text || '');
  if (!m) return false;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  const secs = Math.max(0, (now - ms) / 1000);
  const want = secs < 60 ? ['s', secs] : secs < 3600 ? ['m', secs / 60] : secs < 86400 ? ['h', secs / 3600] : ['d', secs / 86400];
  // Near a unit border the page may be on either side of it.
  if (m[2] !== want[0]) return Math.abs(Number(m[1]) * unit - secs) <= unit + 5;
  return Math.abs(Number(m[1]) - want[1]) <= 1.05 + (m[2] === 's' ? 8 : 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeout = 8000, every = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err; }
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

module.exports = { Book, instrument, planDialog, apiCalls, screenCheck, shown, signOf, solStr, solNum, matches, agoMatches, sleep, until };
