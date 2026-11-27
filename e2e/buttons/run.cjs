#!/usr/bin/env node
'use strict';
// The every-button browser suite. For each screen size it: seeds a fresh database (seed.ts), starts the real server
// offline (no RPC_URL; Jupiter's address pointed at a local stand-in so nothing leaves this machine), drives the user
// site and the admin page in Chromium, and writes what it saw to .run/report-<size>.json.
//
//   node e2e/buttons/run.cjs                    both sizes (desktop 1280, phone 390)
//   node e2e/buttons/run.cjs --only desktop     one size
//   node e2e/buttons/run.cjs --scenario admin   only scenarios whose name contains the word (several: a,b)
//   node e2e/buttons/run.cjs --keep-server      leave the last server running (to poke at it by hand)
//
// A failed check is a finding about the site, written to the report; the exit code is 0 whenever the suite itself ran.
const { chromium } = require('playwright');
const { spawn, spawnSync, execSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Book, instrument, until } = require('./lib.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, '.run');
const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ONLY = argOf('--only');
const SCENARIO = argOf('--scenario');
const KEEP = args.includes('--keep-server');

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1280, height: 900 }, mobile: false, net: 1 },
  { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true, net: 2 },
].filter((v) => !ONLY || v.name === ONLY);

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/** Stands in for Jupiter: the Status page's "real quote" goes here instead of out to the internet. */
async function startStub() {
  const stub = { mode: 'ok', hits: 0, port: await freePort(), server: null };
  stub.server = http.createServer((req, res) => {
    stub.hits += 1;
    if (stub.mode !== 'ok') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'stand-in says: no route today' })); return; }
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ inputMint: u.searchParams.get('inputMint'), outputMint: u.searchParams.get('outputMint'), inAmount: u.searchParams.get('amount') ?? '0', outAmount: '1500000', otherAmountThreshold: '1490000', swapMode: 'ExactIn', routePlan: [] }));
  });
  await new Promise((r) => stub.server.listen(stub.port, '127.0.0.1', r));
  return stub;
}

function seed(db, manifestFile, masterKey, adminPassword) {
  const r = spawnSync('npx', ['tsx', 'e2e/buttons/seed.ts', db, manifestFile], { cwd: ROOT, env: { ...process.env, MASTER_KEY: masterKey, ADMIN_PASSWORD: adminPassword, RPC_URL: '', LOG_LEVEL: 'error' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`seed failed: ${r.stderr || r.stdout}`);
  return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
}

const children = new Set();

async function startServer({ db, masterKey, adminPassword, stubPort, logFile }) {
  const port = await freePort();
  const emptyEnv = path.join(OUT, 'empty.env');
  fs.writeFileSync(emptyEnv, '');
  const env = {
    ...process.env,
    PORT: String(port), HOST: '127.0.0.1', DB_PATH: db, MASTER_KEY: masterKey, ADMIN_PASSWORD: adminPassword, SECURE_COOKIES: 'false',
    // Offline, whatever a stray .env or the shell says: no RPC, no keys, no live trading.
    RPC_URL: '', RPC_WS_URL: '', JUPITER_API_KEY: '', LIVE_TRADING: 'false', FEE_BPS: '0', FEE_WALLET: '', FEE_EXEMPT_USERS: '', MAX_SOL_PER_BUY: '', HELIUS_STREAM: 'off',
    DOTENV_CONFIG_PATH: emptyEnv,
    // Jupiter's address: the local stand-in (the Status page asks it for a quote even without an RPC).
    JUPITER_URL: `http://127.0.0.1:${stubPort}`,
    // Each browser context gets its own visitor address (X-Forwarded-For), as behind the site's reverse proxy
    // (docker-compose sets TRUST_PROXY too): the login limiter counts per address, and one address runs out after ten logins.
    TRUST_PROXY: 'true',
    BRAND_NAME: 'WalletMotion', LOG_LEVEL: 'info',
  };
  const log = fs.openSync(logFile, 'w');
  const child = spawn('npx', ['tsx', 'src/server.ts'], { cwd: ROOT, env, stdio: ['ignore', log, log], detached: true });
  children.add(child);
  const base = `http://127.0.0.1:${port}`;
  const cfg = await until(async () => {
    try { const r = await fetch(`${base}/api/config`); return r.ok ? await r.json() : null; } catch { return null; }
  }, { timeout: 40_000, every: 250 });
  if (!cfg) { stopServer(child); throw new Error(`the server did not come up; see ${logFile}`); }
  if (cfg.server.mode !== 'offline' || cfg.server.live !== false) { stopServer(child); throw new Error(`the server is not offline (${JSON.stringify(cfg.server)}): refusing to go on`); }
  return { child, base, port, config: cfg, logFile };
}

function stopServer(child) {
  if (!child) return;
  children.delete(child);
  // With a buy "in flight" in the seeded data the server would wait 40 s before stopping: a throwaway database
  // does not need that.
  for (const sig of ['SIGTERM', 'SIGKILL']) { try { process.kill(-child.pid, sig); } catch { /* gone */ } }
}

function gitState() {
  const sh = (c) => { try { return execSync(c, { cwd: ROOT, encoding: 'utf8' }); } catch { return ''; } };
  const status = sh('git status --porcelain').split('\n').filter((l) => l.trim());
  return { commit: sh('git rev-parse --short HEAD').trim(), dirty: status.filter((l) => !/ e2e\/buttons\//.test(l)).map((l) => l.trim()) };
}

/** A click that cannot land where the control is drawn (covered, or off the screen) is written down, then made the
 *  way a script can, so the rest of the suite still runs. A person would have to pan the page to reach it. */
function patchClicks(page, book, firstTry) {
  const proto = Object.getPrototypeOf(page.locator('body'));
  if (proto.__suitePatched) return;
  const orig = proto.click;
  proto.__suitePatched = true;
  proto.click = async function click(opts = {}) {
    const pg = this.page();
    const bk = pg.__book;
    if (!bk || opts.force) return orig.call(this, opts);
    try {
      return await orig.call(this, { timeout: pg.__firstTry || 8000, ...opts });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const why = /intercepts pointer events/.test(msg) ? (/- (<[^\n]*?) intercepts pointer events/.exec(msg.replace(/\x1b\[\d+m/g, '')) || [])[1] : /outside of the viewport/.test(msg) ? 'outside of the viewport' : null;
      if (!why) throw err;
      let box = null;
      try { box = await this.first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), screen: document.documentElement.clientWidth, layoutWidth: window.innerWidth }; }); } catch { /* gone */ }
      bk.blockedClicks.push({ tag: pg.__tag, step: bk.step, control: String(this).replace(/^locator\(|\)$/g, ''), coveredBy: why.slice(0, 160), box });
      return this.first().dispatchEvent('click');
    }
  };
  void firstTry;
}

async function runSize(vp, stub, summary) {
  const book = new Book(vp.name, OUT);
  current.book = book;
  const masterKey = crypto.randomBytes(32).toString('hex');
  const adminPassword = `owner-${crypto.randomBytes(6).toString('hex')}`;
  const db = path.join(OUT, `site-${vp.name}.db`);
  const manifestFile = path.join(OUT, `manifest-${vp.name}.json`);
  let server = null;
  let browser = null;
  try {
    const manifest = seed(db, manifestFile, masterKey, adminPassword);
    book.log(`seeded ${db}`);
    server = await startServer({ db, masterKey, adminPassword, stubPort: stub.port, logFile: path.join(OUT, `server-${vp.name}.log`) });
    book.log(`server ${server.base} (offline), stand-in for Jupiter on :${stub.port}`);
    browser = await chromium.launch();
    const env = {
      browser, vp, base: server.base, book, manifest, stub, db, root: ROOT, out: OUT, config: server.config, adminPassword,
      ip: (n) => `10.${vp.net}.0.${n}`,
      contexts: [],
      async open(tag, ip, extra = {}) {
        const context = await browser.newContext({
          baseURL: server.base, viewport: vp.viewport, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1,
          locale: extra.locale || 'en-US', timezoneId: extra.tz || 'UTC', extraHTTPHeaders: { 'x-forwarded-for': ip },
          permissions: extra.noClipboard ? [] : ['clipboard-read', 'clipboard-write'], ...(extra.storageState ? { storageState: extra.storageState } : {}),
        });
        // Nothing but this machine: the two Google Fonts stylesheets get an empty answer, anything else is refused and written down.
        await context.route((url) => url.hostname !== '127.0.0.1', async (route) => {
          const url = route.request().url();
          if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
          book.external.push({ tag, step: book.step, url });
          return route.abort();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        page.__book = book;
        page.__firstTry = vp.mobile ? 2500 : 8000;
        patchClicks(page, book);
        await instrument(context, page, book, tag);
        const s = { context, page, tag };
        env.contexts.push(s);
        return s;
      },
      /** A scenario that throws is written down and the suite goes on. */
      async scenario(name, fn, opts = {}) {
        if (SCENARIO && !opts.always && !SCENARIO.split(',').some((w) => name.includes(w))) return;
        book.begin(name);
        for (const s of env.contexts) s.page.__dialogPlan = [];
        const t0 = Date.now();
        try { await fn(); } catch (err) {
          book.ok(`scenario "${name}" ran to its end`, false, String(err && err.stack ? err.stack : err).replace(/\x1b\[\d+m/g, '').slice(0, 1500));
          for (const s of env.contexts) if (!s.page.isClosed()) await book.shot(s.page, `crash-${name}-${s.tag}`);
        }
        book.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      },
    };
    await require('./scenarios.cjs').runAll(env);
  } catch (err) {
    book.ok('the suite ran to its end', false, String(err && err.stack ? err.stack : err));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) { if (KEEP && vp === VIEWPORTS[VIEWPORTS.length - 1]) book.log(`server left running on ${server.base} (pid ${server.child.pid}); manifest ${manifestFile}`); else stopServer(server.child); }
  }
  const report = { ...book.toJSON(), git: gitState(), stubHits: stub.hits, finishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, `report-${vp.name}.json`), JSON.stringify(report, null, 1));
  summary.sizes[vp.name] = {
    passed: book.pass.length, failed: book.fail.length, pageErrors: book.pageErrors.length, consoleErrors: book.consoleErrors.length,
    unexpectedHttp: book.httpErrors.filter((h) => !h.provoked).length, requestFailed: book.requestFailed.length, external: book.external.length,
    layoutScreens: book.layout.length, clicksThatCouldNotLand: book.blockedClicks.length, badTextScreens: book.badTexts.length, unplannedDialogs: book.dialogs.filter((d) => !d.planned).length,
    untouchedControls: report.inventory.filter((c) => !c.touched).map((c) => c.control),
  };
}

const current = { book: null };
process.on('unhandledRejection', (err) => { console.error('unhandled rejection in the suite:', err); if (current.book) current.book.ok('no stray error inside the suite itself', false, String(err && err.stack ? err.stack : err).slice(0, 800)); });
process.on('uncaughtException', (err) => { console.error('uncaught exception in the suite:', err); if (current.book) current.book.ok('no stray error inside the suite itself', false, String(err && err.stack ? err.stack : err).slice(0, 800)); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const c of children) stopServer(c); process.exit(130); });
process.on('exit', () => { if (!KEEP) for (const c of children) stopServer(c); });

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const summary = { startedAt: new Date().toISOString(), git: gitState(), sizes: {} };
  const stub = await startStub();
  for (const vp of VIEWPORTS) await runSize(vp, stub, summary);
  if (!KEEP) await new Promise((r) => stub.server.close(r));
  summary.git = gitState();
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log('\n===== SUMMARY =====');
  console.log(JSON.stringify(summary, null, 1));
  for (const vp of VIEWPORTS) {
    const r = JSON.parse(fs.readFileSync(path.join(OUT, `report-${vp.name}.json`), 'utf8'));
    console.log(`\n===== ${vp.name}: ${r.fail.length} failed checks =====`);
    for (const f of r.fail) console.log(`✗ [${f.step}] ${f.name}\n    ${JSON.stringify(f.evidence, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 900)}`);
  }
  if (!KEEP) setTimeout(() => process.exit(0), 300);
}

main().catch((err) => { console.error(err); for (const c of children) stopServer(c); process.exit(1); });
