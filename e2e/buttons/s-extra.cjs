'use strict';
// Things around the edges: other time zones, what the 3-second refresh does to a page someone is reading, and what
// ended up on disk.
const fs = require('node:fs');
const path = require('node:path');
const bs58mod = (() => { try { return require(path.join(__dirname, '..', '..', 'node_modules', 'bs58')); } catch { return null; } })();
const { screenCheck, sleep, until } = require('./lib.cjs');
const ui = require('./ui.cjs');
const X = require('./expected.cjs');
const { checkHistory, checkDashboard } = require('./s-alice.cjs');

async function extras(env, parts) {
  const { book, manifest, vp } = env;
  const K = manifest.keys;
  const alicePage = parts.alice && parts.alice.page;

  await env.scenario('time zones: "today" and the day table follow the viewer\'s clock', async () => {
    const state = alicePage ? await parts.alice.context.storageState() : null;
    for (const [n, tz] of [[70, 'America/Los_Angeles'], [71, 'Pacific/Auckland'], [72, 'Europe/Berlin'], [73, 'Asia/Kolkata']]) {
      const V = await env.open(`alice-${tz}`, env.ip(n), { tz, ...(state ? { storageState: state } : {}) });
      await ui.gotoApp(V.page, '/');
      if (await V.page.locator('.auth #l').count()) { await ui.enter(V.page, K.alice.key); await V.page.locator('.topbar').waitFor(); }
      await sleep(300);
      const offset = await V.page.evaluate(() => -new Date().getTimezoneOffset());
      const now = Date.now();
      const E = X.forUser(manifest, 'alice', { timeZone: tz, now });
      const st = await ui.state(V.page);
      const sol = (l) => Number(l) / 1e9;
      book.ok(`${tz} (UTC${offset >= 0 ? '+' : ''}${offset / 60}): Profit today and last 7 days are counted on the viewer's own days`, Math.abs(st.pnl.live.todaySol - sol(E.modes.live.today)) < 1e-9 && Math.abs(st.pnl.live.weekSol - sol(E.modes.live.week)) < 1e-9 && Math.abs(st.pnl.test.todaySol - sol(E.modes.test.today)) < 1e-9,
        { viewerToday: E.todayIso, shown: { liveToday: st.pnl.live.todaySol, liveWeek: st.pnl.live.weekSol, testToday: st.pnl.test.todaySol }, expected: { liveToday: sol(E.modes.live.today), liveWeek: sol(E.modes.live.week), testToday: sol(E.modes.test.today) } });
      await ui.openTab(V.page, 'history');
      await sleep(300);
      await checkHistory(env, V.page, 'alice', { timeZone: tz, label: `viewer in ${tz}`, skipHeading: true });
      await V.context.close();
    }
  });

  await env.scenario('the 3-second refresh and a page someone is reading', async () => {
    if (!alicePage) throw new Error('no page for Alice');
    await ui.gotoApp(alicePage, '/');
    if (await alicePage.locator('.auth #l').count()) { await ui.enter(alicePage, K.alice.key); await alicePage.locator('.topbar').waitFor(); }
    await sleep(500);
    const feed = await alicePage.evaluate(() => { const f = document.querySelector('.feed'); return { scrollHeight: f.scrollHeight, clientHeight: f.clientHeight }; });
    await alicePage.evaluate(() => { document.querySelector('.feed').scrollTop = 420; window.scrollTo(0, 260); });
    await sleep(300);
    const before = await alicePage.evaluate(() => ({ feed: document.querySelector('.feed').scrollTop, page: window.scrollY }));
    await sleep(3600);
    const after1 = await alicePage.evaluate(() => ({ feed: document.querySelector('.feed').scrollTop, page: window.scrollY }));
    book.ok('reading down the Activity list: it stays where it was scrolled to when the page refreshes itself', feed.scrollHeight > feed.clientHeight + 420 && after1.feed >= 400, { listHeight: feed, scrolledTo: before.feed, after3s: after1.feed });
    book.ok('the page itself stays where it was scrolled to when it refreshes', Math.abs(after1.page - before.page) < 5, { scrolledTo: before.page, after3s: after1.page });
    // Selecting text to copy it (an address, a number).
    await alicePage.evaluate(() => { const el = document.querySelector('.addr a'); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    const sel0 = await alicePage.evaluate(() => String(getSelection()));
    await sleep(3600);
    const sel1 = await alicePage.evaluate(() => String(getSelection()));
    book.ok('text selected on the page (to copy a wallet address) is still selected after the page refreshes itself', sel0.length > 30 && sel1 === sel0, { selected: sel0, after3s: sel1 });
    // The History tables on a narrow screen are scrolled sideways.
    await alicePage.evaluate(() => window.scrollTo(0, 0));
    await ui.openTab(alicePage, 'history');
    await sleep(400);
    const wrap = await alicePage.evaluate(() => { const w = [...document.querySelectorAll('.table-wrap')].pop(); return { scrollWidth: w.scrollWidth, clientWidth: w.clientWidth }; });
    if (wrap.scrollWidth > wrap.clientWidth + 150) {
      await alicePage.evaluate(() => { [...document.querySelectorAll('.table-wrap')].pop().scrollLeft = 140; });
      await sleep(3700);
      const left = await alicePage.evaluate(() => [...document.querySelectorAll('.table-wrap')].pop().scrollLeft);
      book.ok('History scrolled sideways (narrow screen): it stays where it was scrolled to when the page refreshes itself', left >= 120, { tableWidth: wrap, scrolledTo: 140, after3s: left });
    } else {
      book.note('History table fits this width without sideways scrolling', wrap);
    }
    await ui.openTab(alicePage, 'dash');
  });

  await env.scenario('a short outage (the site restarting for an update): nobody is thrown out', async () => {
    const P = (parts.bob || parts.alice).page;
    const key = parts.bob ? K.bob.key : K.alice.key;
    await ui.gotoApp(P, '/');
    if (await P.locator('.auth #l').count()) { await ui.enter(P, key); await P.locator('.topbar').waitFor(); }
    await P.mouse.click(5, 300);
    let mode = 'refused';
    book.staged = true;
    await P.route('**/api/**', (route) => (mode === 'refused' ? route.abort('connectionrefused') : mode === '502' ? route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }) : route.continue()));
    try {
      await ui.hideToast(P);
      const t1 = await ui.toast(P, 9000);
      book.ok('while the server cannot be reached the page stays on the dashboard (no key form)', (await P.locator('.topbar').count()) === 1 && (await P.locator('.auth').count()) === 0);
      book.ok('while the server cannot be reached the page says so in words a person understands', !!t1 && !/Failed to fetch|NetworkError|TypeError|Load failed/.test(t1.text), t1);
      mode = '502';
      await ui.hideToast(P);
      const t2 = await ui.toast(P, 9000);
      book.ok('while the proxy answers "502" (the app is restarting) the page says so in words a person understands', !!t2 && !/request failed \(502\)/.test(t2.text), t2);
      mode = 'refused';
      await P.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      const waiting = await P.waitForFunction(() => /Reconnecting…/.test(document.querySelector('#app').innerText), null, { timeout: 9000 }).then(() => true, () => false);
      book.ok('a reload in the middle of the outage shows "Reconnecting…", not the key form', waiting && (await P.locator('#l').count()) === 0, await P.locator('#app').innerText().catch(() => ''));
      mode = 'ok';
      const back = await P.locator('.topbar').waitFor({ timeout: 20_000 }).then(() => true, () => false);
      book.ok('when the server is back the page returns to the dashboard by itself, still logged in', back);
    } finally {
      mode = 'ok';
      await P.unroute('**/api/**').catch(() => undefined);
      await sleep(400);
      book.staged = false;
    }
  });

  await env.scenario('the fonts server (fonts.googleapis.com) does not answer', async () => {
    const V = await env.open('slow-fonts', env.ip(76));
    let release;
    const gate = new Promise((r) => { release = r; });
    let asked = 0;
    await V.context.route(/^https:\/\/fonts\.googleapis\.com\//, async (route) => { asked += 1; await gate; await route.fulfill({ status: 200, contentType: 'text/css', body: '' }).catch(() => undefined); });
    const t0 = Date.now();
    V.page.goto('/', { waitUntil: 'commit' }).catch(() => undefined);
    const early = await V.page.locator('.auth #l').waitFor({ timeout: 7000 }).then(() => true, () => false);
    const waited = Date.now() - t0;
    release();
    const late = await V.page.locator('.auth #l').waitFor({ timeout: 7000 }).then(() => true, () => false);
    book.ok('the key form appears without waiting for the fonts server', early, { fontsStylesheetAskedFor: asked, formShownWhileFontsHung: early, waitedMs: waited, formShownOnceFontsAnswered: late });
    await V.context.close();
  });

  await env.scenario('a browser that does not let pages write to the clipboard', async () => {
    const V = await env.open('no-clipboard', env.ip(75), { noClipboard: true });
    await V.context.clearPermissions().catch(() => undefined);
    await ui.gotoApp(V.page, '/');
    await ui.enter(V.page, K.bob.key);
    await V.page.locator('.topbar').waitFor();
    await V.page.locator('#copy-addr').waitFor();
    await ui.hideToast(V.page);
    await V.page.locator('#copy-addr').click();
    const t = await ui.toast(V.page);
    const wrote = await V.page.evaluate(() => navigator.clipboard.writeText('x').then(() => true, () => false));
    if (wrote) book.note('this browser allowed clipboard writes even without the permission; the fallback could not be shown', t);
    else book.ok('Copy address without clipboard access: the address is shown instead, to copy by hand', !!t && t.text === manifest.users.bob.wallet, t);
    await V.context.close();
  });

  await env.scenario('long names without a space (a wallet address pasted as a nickname)', async () => {
    const F = parts.fresh && parts.fresh.page;
    if (!F) throw new Error('no page for the new user');
    await ui.gotoApp(F, '/');
    if (await F.locator('.auth #l').count()) { await ui.enter(F, K.fresh.key); await F.locator('.topbar').waitFor(); }
    const st = await ui.state(F);
    const victim = st.copies.find((c) => /^Fill/.test(c.name)) || st.copies[st.copies.length - 1];
    const long = manifest.imports.leaders[0].slice(0, 40);
    await ui.openEdit(F, victim.id);
    await F.locator('#f-name').fill(long);
    await ui.hideToast(F);
    await ui.submitEditor(F);
    await ui.toast(F);
    await until(async () => !(await ui.editorOpen(F)));
    await sleep(500);
    const row = (await ui.readDash(F)).copies.find((c) => c.id === victim.id);
    book.eq('a 40-character nickname without a space is saved and shown whole', row && row.name, `${long} TEST`);
    await F.locator(`[data-edit="${victim.id}"]`).scrollIntoViewIfNeeded().catch(() => undefined);
    const before = book.layout.length;
    await screenCheck(F, book, 'user-dashboard-long-nickname');
    book.note('layout with a 40-character unbroken nickname', book.layout.length > before ? book.layout[book.layout.length - 1].offenders.slice(0, 4) : 'fits');
  });

  await env.scenario('the locks around the pages (cookies, headers, other people\'s things)', async () => {
    const A = parts.alice;
    const B = parts.bob;
    if (!A || !B) throw new Error('needs Alice and Bob logged in');
    for (const [who, S, key] of [['alice', A, K.alice.key], ['bob', B, K.bob.key]]) {
      await ui.gotoApp(S.page, '/');
      if (await S.page.locator('.auth #l').count()) { await ui.enter(S.page, key); await S.page.locator('.topbar').waitFor(); }
      void who;
    }
    const cookies = await A.context.cookies();
    const c = cookies.find((x) => x.name === 'ml_session');
    const days = c ? (c.expires - Date.now() / 1000) / 86400 : 0;
    book.ok('the login cookie cannot be read by scripts (HttpOnly), is not sent from other sites\' forms (SameSite=Lax) and lasts about 90 days', !!c && c.httpOnly && c.sameSite === 'Lax' && days > 88 && days < 91, c && { httpOnly: c.httpOnly, sameSite: c.sameSite, days: Math.round(days) });
    const resp = await A.context.request.get(`${env.base}/`);
    const h = resp.headers();
    book.ok('pages are served with the strict content policy (scripts only from this site), no framing, no sniffing', /script-src 'self'/.test(h['content-security-policy'] || '') && /frame-ancestors 'none'/.test(h['content-security-policy'] || '') && h['x-frame-options'] === 'DENY' && h['x-content-type-options'] === 'nosniff', { csp: h['content-security-policy'], frame: h['x-frame-options'] });
    const noHeader = await A.context.request.post(`${env.base}/api/logout`, { data: {} });
    book.eq('a change sent without the site\'s own request header (as a foreign form would) is refused', [noHeader.status(), (await noHeader.json()).error], [403, 'missing request header']);
    book.eq('…and did not log the user out', (await ui.state(A.page)).user.username, 'Alice');
    // Bob's things through Alice's session.
    const bobState = await ui.state(B.page);
    const bobCopy = bobState.copies[0];
    const aliceState = await ui.state(A.page);
    const H = { 'x-requested-with': 'motionlarp' };
    const put = await A.context.request.put(`${env.base}/api/copies/${bobCopy.id}`, { data: { ...bobCopy, name: 'hijacked' }, headers: H });
    const del = await A.context.request.delete(`${env.base}/api/copies/${bobCopy.id}`, { headers: H });
    const alicePos = aliceState.positions.find((p) => p.status === 'open');
    const sell = await B.context.request.post(`${env.base}/api/positions/${alicePos.id}/sell`, { data: {}, headers: H });
    const after = await ui.state(B.page);
    book.ok('one user cannot change or delete another user\'s copy, nor sell another user\'s position', put.status() === 404 && del.status() === 404 && sell.status() === 404 && after.copies.some((x) => x.id === bobCopy.id && x.name === bobCopy.name), { put: put.status(), del: del.status(), sell: sell.status() });
    const admin = await A.context.request.get(`${env.base}/api/admin/state`);
    book.eq('a user session cannot read the owner\'s data', admin.status(), 401);
    const names = new Set();
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { names.add(k); walk(x); } };
    walk(aliceState);
    const keyLike = [...names].filter((k) => /secret|private|enc_?key|pass_?hash|token/i.test(k));
    book.ok('what the server sends a user holds their wallet\'s address and nothing key-like', Object.keys(aliceState.wallet).sort().join() === 'pubkey,sol' && keyLike.length === 0, { wallet: Object.keys(aliceState.wallet), keyLike });
    // Paths that are not pages.
    const weird = await A.context.request.get(`${env.base}/../../etc/passwd`);
    const weird2 = await A.context.request.get(`${env.base}/%2e%2e/%2e%2e/package.json`);
    book.ok('asking for files outside the site gets the site\'s own page, never a file from the server', !/root:|"dependencies"/.test(await weird.text()) && !/"dependencies"/.test(await weird2.text()), [weird.status(), weird2.status()]);
  });

  await env.scenario('what is on disk: keys and secrets', async () => {
    const dbBytes = Buffer.concat([env.db, `${env.db}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)));
    const log = fs.readFileSync(path.join(env.out, `server-${vp.name}.log`), 'utf8');
    const imp = manifest.imports;
    const secrets = [imp.base58.secret, imp.base58b.secret];
    const jsonAsB58 = bs58mod && bs58mod.default ? bs58mod.default.encode(Uint8Array.from(JSON.parse(imp.json.secret))) : null;
    if (jsonAsB58) secrets.push(jsonAsB58);
    const inDb = secrets.filter((s) => dbBytes.includes(Buffer.from(s)));
    const rawInDb = secrets.filter((s) => { try { const raw = Buffer.from(bs58mod.default.decode(s)); return dbBytes.includes(raw); } catch { return false; } });
    book.ok('the database holds no imported private key in readable form (neither as text nor as raw bytes)', inDb.length === 0 && rawInDb.length === 0 && !dbBytes.includes(Buffer.from(imp.json.secret)), { asText: inDb.length, asBytes: rawInDb.length });
    const keys = Object.values(K).map((k) => k.key).filter(Boolean);
    book.ok('the database holds no license key in readable form (only its hash and last four characters)', !keys.some((k) => dbBytes.includes(Buffer.from(k))), keys.filter((k) => dbBytes.includes(Buffer.from(k))).length);
    book.ok('the server log holds no private key, no license key, no admin password and no master key', ![...secrets, ...keys, env.adminPassword, manifest.masterKey].some((s) => log.includes(s)));
    book.ok('the database does not hold the admin password or the master key', !dbBytes.includes(Buffer.from(env.adminPassword)) && !dbBytes.includes(Buffer.from(manifest.masterKey)));
    const errors = log.split('\n').filter((l) => /"level":"(error|warn)"/.test(l));
    book.ok('the server logged no error during the whole run (one warning about the missing RPC link is expected)', errors.filter((l) => !/no RPC link yet/.test(l)).length === 0, errors.filter((l) => !/no RPC link yet/.test(l)).slice(0, 5).map((l) => l.slice(0, 300)));
    book.note('server warnings and errors', errors.map((l) => l.slice(0, 200)));
  });
}

module.exports = { extras };
