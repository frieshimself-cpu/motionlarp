'use strict';
// The owner's page: first a look at a freshly seeded site (every number against the seed), later every control,
// with what each one does to the users who are logged in next door.
const { planDialog, apiCalls, screenCheck, shown, matches, solNum, solStr, agoMatches, sleep, until } = require('./lib.cjs');
const ui = require('./ui.cjs');
const X = require('./expected.cjs');
const { spawnSync } = require('node:child_process');

const KEY_RE = /^WM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const licRow = (a, label) => a.licenses.find((l) => l.label === label);
const userRow = (a, name) => a.users.find((u) => u.name === name);

async function adminFirstLook(env) {
  const { book, manifest, config } = env;
  const S = await env.open('admin', env.ip(9));
  const { page } = S;

  await env.scenario('admin: wrong password, then in', async () => {
    await page.goto('/admin');
    await page.locator('#admin-login').waitFor();
    let a = await ui.readAdmin(page);
    book.eq('admin login page: title, "Owner area", a way back to the site', [await page.title(), a.tagline, a.foot, a.footHref], [`${config.brand} — admin`, 'Owner area', 'Back to the site', '/']);
    const brand = await page.evaluate(() => { const b = document.querySelector('.auth .brand'); const r = b.getBoundingClientRect(); return { width: Math.round(r.width), shownText: b.innerText.trim() }; });
    book.ok('admin login page: the logo and the site\'s name are on the screen', brand.width > 40 && brand.shownText === config.brand, brand);
    await screenCheck(page, book, 'admin-login');
    const n0 = apiCalls(page, /^\/api\/admin\/login$/).length;
    await page.locator('#admin-login button[type=submit]').click();
    await sleep(400);
    book.ok('admin login: an empty password sends nothing', apiCalls(page, /^\/api\/admin\/login$/).length === n0);
    book.allow(401, /^\/api\/admin\/login$/);
    await page.locator('#ap').fill('not-the-password');
    await page.locator('#admin-login button[type=submit]').click();
    await page.locator('.err').waitFor();
    a = await ui.readAdmin(page);
    book.eq('admin login: a wrong password is refused in words', a.err, 'wrong password');
    book.eq('admin login: the password box hides what is typed', await page.locator('#ap').getAttribute('type'), 'password');
    await page.locator('#ap').fill(env.adminPassword);
    await page.locator('#admin-login button[type=submit]').click();
    await page.locator('.topbar').waitFor();
    book.ok('admin login: the right password opens the page', true);
  }, { always: true });

  await env.scenario('admin: a freshly seeded site, every number against the seed', async () => {
    // The connection check runs right after login: wait for its banner.
    await until(async () => (await ui.readAdmin(page)).banner, { timeout: 12_000 });
    const now = Date.now();
    const a = await ui.readAdmin(page);
    book.eq('admin: tabs, state pill, link to the site, log out', a.top, { nav: [{ text: 'Admin', on: true, dot: false }, { text: 'Status', on: false, dot: true }], pills: ['OFFLINE'], openSite: '/', logout: true });
    book.eq('admin (offline): a banner says which connection needs attention', a.banner, 'A connection needs attention: Helius RPC — the Helius link is not set on the server. Open Status.');

    const per = Object.fromEntries(Object.keys(manifest.users).map((k) => [k, X.forUser(manifest, k, { now })]));
    const feesLive = sum(Object.values(per).map((u) => u.fees.live));
    const feesTest = sum(Object.values(per).map((u) => u.fees.test));
    const openAll = Object.values(per).reduce((n, u) => n + u.open.length, 0);
    const unused = Object.values(manifest.keys).filter((k) => k.status === 'unused').length;
    const s = a.stats;
    book.eq('admin cards: users and unused keys', [s[0].label, s[0].value, s[0].foot], ['Users', String(Object.keys(manifest.users).length), `${unused} unused keys`]);
    book.eq('admin cards: open positions across the site, wallets watched (none offline)', [s[1].label, s[1].value, s[1].foot], ['Open positions', String(openAll), 'watching 0 wallets']);
    const fm = /^real trades · test mode would have: ([\d.]+)$/.exec(s[2].foot) || [];
    book.ok('admin cards: fees earned = platform fees of every real fill; test fees shown apart', s[2].label === 'Fees earned' && matches(s[2].value, solNum(feesLive)) && / SOL$/.test(s[2].value) && matches(fm[1], solNum(feesTest)), { shown: s[2], realFees: solStr(feesLive), testFees: solStr(feesTest) });
    book.eq('admin cards: trading state', [s[3].label, s[3].value, s[3].foot], ['Trading', 'Offline', 'the Helius link is not set on the server']);

    // License keys, newest first.
    const keys = Object.values(manifest.keys).sort((x, y) => y.id - x.id);
    const wantLic = keys.map((k) => ({
      label: k.label, key: `WM-····-${k.hint}`, status: { unused: 'Unused', active: 'Active', revoked: 'Revoked' }[k.status], account: k.username ?? '—',
      fee: k.feeBps === null ? 'Default (1%)' : `${k.feeBps / 100}%`,
      buttons: ['Set fee', 'New key', k.status === 'revoked' ? 'Restore' : 'Revoke', ...(k.status === 'unused' ? ['Delete'] : [])],
    }));
    book.eq('admin: the license table (who, masked key, state, account, fee, the right buttons for each state)', a.licenses.map(({ label, key, status, account, fee, buttons }) => ({ label, key, status, account, fee, buttons })), wantLic);
    book.ok('admin: each key says how long ago it was made', a.licenses.every((l, i) => agoMatches(l.created, keys[i].createdAt, now)), a.licenses.map((l, i) => [l.created, new Date(keys[i].createdAt).toISOString()]));
    book.ok('admin: a key label with markup in it is shown as text', !a.licenses.some((l) => /<i>/.test(l.labelHtml)) && a.licenses.some((l) => l.label === manifest.keys.fresh.label), a.licenses.map((l) => l.labelHtml).filter((h) => /Erin/.test(h)));
    const stateJson = JSON.stringify(await ui.adminState(page));
    book.ok('admin: no full license key is in what the server sends (only the last four characters)', !Object.values(manifest.keys).some((k) => stateJson.includes(k.key)));
    book.ok('admin: no wallet private key and no master key is in what the server sends', !stateJson.includes(manifest.masterKey) && !/enc_key|encKey|v1:[A-Za-z0-9+/=]{10,}:/.test(stateJson));

    // Users.
    const names = Object.keys(manifest.users).sort((x, y) => manifest.users[x].id - manifest.users[y].id);
    book.eq('admin: one row per user, in the order they joined the site', a.users.map((u) => u.name), names.map((k) => manifest.users[k].name));
    for (const k of names) {
      const U = manifest.users[k];
      const e = per[k];
      const row = userRow(a, U.name);
      if (!row) continue;
      const copies = manifest.copies.filter((c) => c.user === k && c.settings.enabled).length;
      book.eq(`admin users: ${U.name}: state, fee, license, wallet`, [row.disabled, / · fee ([\d.]+)%$/.exec(row.sub)?.[1], row.license, row.wallet, row.walletHref], [U.disabled, String(U.feeBps / 100), U.licensed ? U.name : '—', U.wallet ? X.short(U.wallet) : 'none', U.wallet ? `https://solscan.io/account/${U.wallet}` : null]);
      book.ok(`admin users: ${U.name}: joined when`, agoMatches(row.sub, U.createdAt, now), row.sub);
      book.eq(`admin users: ${U.name}: active copies, open and closed positions`, [row.copies, row.open, row.closed], [String(copies), String(e.open.length), String(e.closed.length)]);
      book.ok(`admin users: ${U.name}: fees paid = platform fees of their real fills`, matches(row.fees, solNum(e.fees.live)), { shown: row.fees, exact: solStr(e.fees.live) });
      const live = e.modes.live.all, test = e.modes.test.all;
      if (test !== 0n) book.ok(`admin users: ${U.name}: "Profit" is real money only (test results are not added to it)`, matches(row.profit, solNum(live), 3), { shown: row.profit, realTradesOnly: solStr(live), testTradesOnly: solStr(test), bothAdded: solStr(live + test) });
      else book.ok(`admin users: ${U.name}: profit`, matches(row.profit, solNum(live), 3), { shown: row.profit, exact: solStr(live) });
      book.eq(`admin users: ${U.name}: buttons`, row.buttons, [...(U.licensed ? [] : ['Create key']), U.disabled ? 'Enable' : 'Disable']);
    }
    book.eq('admin: Settings show what was saved (fee, fee wallet, max per buy, live off)', a.settings, { fee: '1', wallet: manifest.owner.feeWallet, max: '5', live: false, liveText: 'Test mode', liveClass: 'muted', msg: '', msgClass: 'muted' });
    book.eq('admin: the "their fee" box of a new key names the default', a.licFeePlaceholder, 'default 1');
    await screenCheck(page, book, 'admin-first-look', { ignoreInside: [/table-wrap/] });

    await page.reload();
    await page.locator('#admin-login, .topbar').first().waitFor();
    book.ok('admin: the login survives a reload', (await page.locator('.topbar').count()) === 1);
  });

  return S;
}

async function adminEverything(env, parts) {
  const { book, manifest, stub } = env;
  const S = parts['admin-first'];
  const { page } = S;
  const K = manifest.keys;
  const A = () => ui.readAdmin(page);
  /** Reads the page once it has caught up with an action. */
  const after = async (fn, timeout = 6000) => until(async () => { const a = await A(); return !a.login && !a.status && fn(a) ? a : null; }, { timeout });
  /** A second visitor, to try a key. */
  const tryLogin = async (tag, ip, key) => {
    const V = await env.open(tag, ip);
    await ui.gotoApp(V.page, '/');
    book.allow(403, /^\/api\/enter$/);
    const [resp] = await Promise.all([V.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/enter'), ui.enter(V.page, key)]);
    await sleep(300);
    const err = (await V.page.locator('.err').count()) ? await V.page.locator('.err').textContent() : null;
    const who = resp.status() === 200 ? (await V.page.evaluate(async () => (await (await fetch('/api/state')).json()).user.username)) : null;
    return { V, status: resp.status(), err, who };
  };
  let visitor = 20;
  const nextIp = () => env.ip(visitor++);

  await env.scenario('admin: back on the page after the users did their part', async () => {
    await page.goto('/admin');
    await page.locator('.topbar').waitFor();
    const a = await A();
    book.ok('admin: the users who joined meanwhile are listed', a.users.some((u) => u.name === K.fresh.label), a.users.map((u) => u.name));
    const erin = userRow(a, K.fresh.label);
    book.ok('admin: a user name with markup in it is shown as text', !!erin && !/<i>/.test(erin.nameHtml), erin && erin.nameHtml);
  }, { always: true });

  await env.scenario('admin: create a key (with and without its own fee), see it once, copy it', async () => {
    let a = await A();
    const unused0 = Number(/^(\d+) unused/.exec(a.stats[0].foot)[1]);
    const n0 = apiCalls(page, /^\/api\/admin\/licenses$/).length;
    await page.locator('#new-license button[type=submit]').click();
    await sleep(400);
    book.ok('Create key with no name: nothing is sent', apiCalls(page, /^\/api\/admin\/licenses$/).length === n0);
    await page.locator('#lic-label').fill('Zed');
    await page.locator('#lic-fee').fill('11');
    await page.locator('#new-license button[type=submit]').click();
    await sleep(400);
    book.ok('Create key with a fee above 10 %: the browser stops it, nothing is sent', apiCalls(page, /^\/api\/admin\/licenses$/).length === n0, await page.evaluate(() => document.querySelector('#lic-fee').validationMessage));
    await page.locator('#lic-fee').fill('');
    await page.locator('#new-license button[type=submit]').click();
    a = await after((x) => x.newKey);
    const zed = a.newKey.key;
    book.ok('Create key (no fee of its own): the key is shown, in the WM-XXXX-XXXX-XXXX-XXXX form', /^Key for Zed — copy it now, it is not shown again:/.test(a.newKey.text) && KEY_RE.test(zed), a.newKey);
    book.eq('Create key: its row (masked key, Unused, nobody, the default fee, all four buttons)', (({ label, key, status, account, fee, buttons }) => ({ label, key, status, account, fee, buttons }))(licRow(a, 'Zed')), { label: 'Zed', key: `WM-····-${zed.slice(-4)}`, status: 'Unused', account: '—', fee: 'Default (1%)', buttons: ['Set fee', 'New key', 'Revoke', 'Delete'] });
    book.eq('Create key: the unused-keys count goes up', a.stats[0].foot, `${unused0 + 1} unused keys`);
    book.eq('Create key: the form is empty again', a.licLabel, '');
    await ui.hideToast(page);
    await page.locator('#copy-key').click();
    const t = await ui.toast(page);
    book.eq('Copy key: the key is on the clipboard and the page says so', [t, await page.evaluate(() => navigator.clipboard.readText()).catch((e) => String(e))], [{ text: 'Key copied', bad: false }, zed]);
    await screenCheck(page, book, 'admin-key-created', { ignoreInside: [/table-wrap/] });
    book.ok('Create key: the server never sends the key again', !JSON.stringify(await ui.adminState(page)).includes(zed));
    await sleep(5500); // one background refresh
    book.ok('the new key stays on screen through a background refresh', ((await A()).newKey || {}).key === zed);
    await page.reload();
    await page.locator('.topbar').waitFor();
    a = await A();
    book.ok('the new key is shown once: after a reload it is gone, only its last four characters remain', a.newKey === null && licRow(a, 'Zed').key === `WM-····-${zed.slice(-4)}` && !(await page.content()).includes(zed));
    K.zed = { key: zed, label: 'Zed' };

    await page.locator('#lic-label').fill('Yan');
    await page.locator('#lic-fee').fill('2.5');
    await page.locator('#new-license button[type=submit]').click();
    a = await after((x) => x.newKey && /Yan/.test(x.newKey.text));
    book.eq('Create key with its own fee (2.5 %): the row shows that fee', licRow(a, 'Yan').fee, '2.5%');
    K.yan = { key: a.newKey.key, label: 'Yan' };
    await page.locator('#lic-label').fill('Free rider');
    await page.locator('#lic-fee').fill('0');
    await page.locator('#new-license button[type=submit]').click();
    a = await after((x) => x.newKey && /Free rider/.test(x.newKey.text));
    book.eq('Create key with a fee of 0 %: the row shows 0 %, not "Default"', licRow(a, 'Free rider').fee, '0%');
    K.free = { key: a.newKey.key, label: 'Free rider' };

    // The keys work: first use opens an account named after the key.
    const z = await tryLogin('zed', nextIp(), zed);
    book.eq('a key made on the admin page gets its owner in, into an account named after it', [z.status, z.who], [200, 'Zed']);
    const zd = await ui.readDash(z.V.page);
    book.eq('a key without its own fee pays the site fee', zd.top.pills.map((p) => p.text), ['OFFLINE', 'Fee 1%']);
    await z.V.context.close();
    const f = await tryLogin('free', nextIp(), K.free.key);
    const fd = await ui.readDash(f.V.page);
    book.eq('a key with a 0 % fee shows no fee to its user', fd.top.pills.map((p) => p.text), ['OFFLINE']);
    await f.V.context.close();
    a = await after((x) => licRow(x, 'Zed').status === 'Active');
    book.ok('once used, the key reads Active with its account, and can no longer be deleted', !!a && licRow(a, 'Zed').account === 'Zed' && !licRow(a, 'Zed').buttons.includes('Delete'), a && licRow(a, 'Zed'));
  });

  await env.scenario('admin: Set fee', async () => {
    const id = licRow(await A(), 'Yan').id;
    const setFee = async (answer) => {
      const n0 = apiCalls(page, /^\/api\/admin\/licenses\/\d+$/).length;
      planDialog(page, answer === null ? { accept: false } : { accept: true, text: answer });
      await ui.hideToast(page);
      await page.locator(`[data-fee="${id}"]`).click();
      await sleep(900);
      const tEl = await page.evaluate(() => { const t = document.querySelector('#toast'); return t.hidden ? null : { text: t.textContent, bad: t.classList.contains('bad') }; });
      return { fee: licRow(await A(), 'Yan').fee, sent: apiCalls(page, /^\/api\/admin\/licenses\/\d+$/).length - n0, toast: tEl };
    };
    let r = await setFee('0.75');
    book.eq('Set fee asks in a box; 0.75 gives the key 0.75 %', [page.__lastDialog.type, page.__lastDialog.message, r.fee], ['prompt', 'Fee for this license in % (leave empty to use the default fee):', '0.75%']);
    r = await setFee(null);
    book.eq('Set fee, "Cancel": nothing sent, nothing changed', [r.sent, r.fee], [0, '0.75%']);
    book.allow(400, /^\/api\/admin\/licenses\/\d+$/);
    r = await setFee('11');
    book.eq('Set fee 11: refused in words, the fee stays', [r.toast, r.fee], [{ text: 'a license fee must be between 0 and 10 %', bad: true }, '0.75%']);
    r = await setFee('0,5');
    book.ok('Set fee "0,5" (a comma, as many keyboards type it): it becomes 0.5 % or is refused — it must not silently fall back to the default fee', r.fee === '0.5%' || (r.fee === '0.75%' && r.toast && r.toast.bad), r);
    await setFee('0.75');
    r = await setFee('abc');
    book.ok('Set fee "abc": refused — it must not silently fall back to the default fee', r.fee === '0.75%' && r.toast && r.toast.bad, r);
    await setFee('0.75');
    r = await setFee('2%');
    book.ok('Set fee "2%" (with the sign): 2 % or refused — not silently the default fee', r.fee === '2%' || (r.fee === '0.75%' && r.toast && r.toast.bad), r);
    r = await setFee('');
    book.eq('Set fee left empty: back to the default fee', r.fee, 'Default (1%)');

    // On a key in use: its user sees the change.
    const bobId = licRow(await A(), 'Bob').id;
    planDialog(page, { accept: true, text: '3' });
    await page.locator(`[data-fee="${bobId}"]`).click();
    const a = await after((x) => licRow(x, 'Bob').fee === '3%');
    book.ok('Set fee on a key in use: the key and its user both show 3 %', !!a && / · fee 3%$/.test(userRow(a, 'Bob').sub), a && userRow(a, 'Bob').sub);
    const bobPage = parts.bob && parts.bob.page;
    if (bobPage) {
      await bobPage.mouse.click(5, 300);
      const pill = await until(async () => { const d = await ui.readDash(bobPage); return d.top.pills.some((p) => p.text === 'Fee 3%') ? d.top.pills : null; }, { timeout: 8000 });
      book.ok('Set fee on a key in use: that user\'s own page shows "Fee 3%" within a refresh', !!pill, (await ui.readDash(bobPage)).top.pills);
    }
    planDialog(page, { accept: true, text: '' });
    await page.locator(`[data-fee="${bobId}"]`).click();
    await after((x) => licRow(x, 'Bob').fee === 'Default (1%)');
  });

  await env.scenario('admin: New key (the old one stops working)', async () => {
    let a = await A();
    const id = licRow(a, 'Alice').id;
    const oldHint = licRow(a, 'Alice').key;
    const n0 = apiCalls(page, /\/reissue$/).length;
    planDialog(page, { accept: false });
    await page.locator(`[data-reissue="${id}"]`).click();
    await sleep(400);
    book.eq('New key asks first; "Cancel" changes nothing', [page.__lastDialog.message, apiCalls(page, /\/reissue$/).length - n0, licRow(await A(), 'Alice').key], ['Make a new key for this account? The old key stops working.', 0, oldHint]);
    planDialog(page, { accept: true });
    await page.locator(`[data-reissue="${id}"]`).click();
    a = await after((x) => x.newKey && /Key for Alice/.test(x.newKey.text));
    const fresh = a.newKey.key;
    book.ok('New key: a new key for Alice is shown, the row carries its last four characters, the key still belongs to Alice', KEY_RE.test(fresh) && fresh !== K.alice.key && licRow(a, 'Alice').key === `WM-····-${fresh.slice(-4)}` && licRow(a, 'Alice').account === 'Alice' && licRow(a, 'Alice').status === 'Active', { row: licRow(a, 'Alice') });
    const oldTry = await tryLogin('alice-old-key', nextIp(), K.alice.key);
    book.eq('New key: the OLD key no longer gets in', [oldTry.status, oldTry.err], [403, 'that license key is not valid']);
    await oldTry.V.context.close();
    const newTry = await tryLogin('alice-new-key', nextIp(), fresh);
    const nd = newTry.status === 200 ? await ui.state(newTry.V.page) : null;
    book.ok('New key: the NEW key gets into the same account (same wallet, same copies)', newTry.status === 200 && newTry.who === 'Alice' && nd.wallet.pubkey === manifest.users.alice.wallet && nd.copies.some((c) => c.name === 'Scharo'), { status: newTry.status, who: newTry.who });
    await newTry.V.context.close();
    // The reason to replace a key is that it leaked: whoever got in with the old key should be out.
    const alicePage = parts.alice && parts.alice.page;
    if (alicePage) {
      await sleep(3500);
      const st = await ui.state(alicePage);
      book.ok('New key: a browser that got in with the OLD key is logged out (a leaked key is replaced to lock its finder out)', st.__status === 401, { oldKeysBrowserStillGets: st.__status === 401 ? 'logged out' : `its data (user ${st.user && st.user.username}, ${st.copies && st.copies.length} copies, wallet ${st.wallet && st.wallet.pubkey.slice(0, 4)}…)` });
    }
    K.alice.oldKey = K.alice.key;
    K.alice.key = fresh;
  });

  await env.scenario('admin: Revoke and Restore (the user is locked out and let back in)', async () => {
    let a = await A();
    const id = licRow(a, 'Bob').id;
    const bobPage = parts.bob && parts.bob.page;
    const n0 = apiCalls(page, /^\/api\/admin\/licenses\/\d+$/).length;
    planDialog(page, { accept: false });
    await page.locator(`[data-revoke="${id}"]`).click();
    await sleep(400);
    book.eq('Revoke asks first; "Cancel" changes nothing', [page.__lastDialog.message, apiCalls(page, /^\/api\/admin\/licenses\/\d+$/).length - n0], ['Revoke this key? Its user is locked out and gets no new copies; open positions still sell by their rules.', 0]);
    planDialog(page, { accept: true });
    await page.locator(`[data-revoke="${id}"]`).click();
    a = await after((x) => licRow(x, 'Bob').status === 'Revoked');
    book.ok('Revoke: the key reads Revoked with a Restore button, and its user reads Disabled', !!a && licRow(a, 'Bob').buttons.includes('Restore') && !licRow(a, 'Bob').buttons.includes('Revoke') && userRow(a, 'Bob').disabled && userRow(a, 'Bob').buttons.includes('Enable'), a && [licRow(a, 'Bob'), userRow(a, 'Bob')]);
    if (bobPage) {
      const out = await until(async () => (await bobPage.locator('.auth #l').count()) === 1, { timeout: 9000 });
      book.ok('Revoke: the user\'s open page is back at the key form within one refresh (their session ended)', !!out);
      await screenCheck(bobPage, book, 'bob-locked-out');
    }
    let v = await tryLogin('bob-revoked', nextIp(), K.bob.key);
    book.eq('Revoke: the key no longer gets in, and says why', [v.status, v.err], [403, 'this license key was revoked: ask the owner']);
    await v.V.context.close();
    await page.locator(`[data-restore="${id}"]`).click();
    a = await after((x) => licRow(x, 'Bob').status === 'Active');
    book.ok('Restore: the key reads Active again and its user is enabled', !!a && !userRow(a, 'Bob').disabled, a && userRow(a, 'Bob'));
    if (bobPage) {
      await ui.enter(bobPage, K.bob.key);
      const back = await bobPage.locator('.topbar').waitFor({ timeout: 6000 }).then(() => true, () => false);
      const st = back ? await ui.state(bobPage) : null;
      book.ok('Restore: the user gets back in with the same key and finds everything as it was', back && st.user.username === 'Bob' && st.copies.length === 2 && st.pnl.test.trades === 205, st && { user: st.user, copies: st.copies.length, trades: st.pnl.test.trades });
    }
  });

  await env.scenario('admin: Disable and Enable a user (their session ends)', async () => {
    let a = await A();
    const id = userRow(a, 'Alice').id;
    const alicePage = parts.alice && parts.alice.page;
    if (alicePage) {
      // Make sure Alice is in before she is thrown out.
      if ((await ui.state(alicePage)).__status === 401) { await ui.gotoApp(alicePage, '/'); await ui.enter(alicePage, K.alice.key); await alicePage.locator('.topbar').waitFor(); }
      await alicePage.mouse.click(5, 300);
    }
    const n0 = apiCalls(page, /^\/api\/admin\/users\/\d+$/).length;
    planDialog(page, { accept: false });
    await page.locator(`[data-disable="${id}"]`).click();
    await sleep(400);
    book.eq('Disable asks first; "Cancel" changes nothing', [page.__lastDialog.message, apiCalls(page, /^\/api\/admin\/users\/\d+$/).length - n0], ['Disable this user? They are logged out and get no new copies.', 0]);
    planDialog(page, { accept: true });
    await page.locator(`[data-disable="${id}"]`).click();
    a = await after((x) => userRow(x, 'Alice').disabled);
    book.ok('Disable: the user reads Disabled with an Enable button; their key still reads Active', !!a && userRow(a, 'Alice').buttons.includes('Enable') && licRow(a, 'Alice').status === 'Active', a && [userRow(a, 'Alice'), licRow(a, 'Alice')]);
    if (alicePage) {
      const out = await until(async () => (await alicePage.locator('.auth #l').count()) === 1, { timeout: 9000 });
      book.ok('Disable: the user\'s open page is back at the key form within one refresh (their session ended)', !!out);
      book.allow(403, /^\/api\/enter$/);
      const [resp] = await Promise.all([alicePage.waitForResponse((r) => new URL(r.url()).pathname === '/api/enter'), ui.enter(alicePage, K.alice.key)]);
      await sleep(300);
      book.eq('Disable: their key is refused, and says why', [resp.status(), await alicePage.locator('.err').textContent()], [403, 'this account is disabled: ask the owner']);
    }
    await page.locator(`[data-enable="${id}"]`).click();
    a = await after((x) => !userRow(x, 'Alice').disabled);
    book.ok('Enable: the user is enabled again', !!a);
    if (alicePage) {
      await ui.enter(alicePage, K.alice.key);
      const back = await alicePage.locator('.topbar').waitFor({ timeout: 6000 }).then(() => true, () => false);
      const st = back ? await ui.state(alicePage) : null;
      const wantTrades = X.forUser(manifest, 'alice').modes.live.trades;
      book.ok('Enable: the user gets back in and finds their positions and history', back && st.positions.length === 4 && st.pnl.live.trades === wantTrades, st && { positions: st.positions.length, trades: st.pnl.live.trades, wantTrades });
    }

    // Two switches for one thing: a revoked key whose user is then enabled from the Users table.
    const bobKey = licRow(a, 'Bob').id;
    const bobUser = userRow(a, 'Bob').id;
    planDialog(page, { accept: true });
    await page.locator(`[data-revoke="${bobKey}"]`).click();
    await after((x) => licRow(x, 'Bob').status === 'Revoked' && userRow(x, 'Bob').disabled);
    await page.locator(`[data-enable="${bobUser}"]`).click();
    a = await after((x) => !userRow(x, 'Bob').disabled);
    const v = await tryLogin('bob-revoked-enabled', nextIp(), K.bob.key);
    await v.V.context.close();
    const st = await ui.adminState(page);
    const bu = st.users.find((u) => u.username === 'Bob');
    // What the copy engine itself would do for the wallet Bob copies, asked of the product's own Store.
    const bobLeader = manifest.copies.find((c) => c.key === 'bobMain').settings.leader;
    const probe = spawnSync('npx', ['tsx', 'e2e/buttons/probe.ts', env.db, bobLeader], { cwd: env.root, encoding: 'utf8', env: { ...process.env, RPC_URL: '', LOG_LEVEL: 'error' } });
    let engine = null;
    try { engine = JSON.parse(probe.stdout.trim().split('\n').pop()); } catch { engine = { probeFailed: (probe.stderr || '').slice(0, 200) }; }
    book.ok('a revoked key and its user stay in step: after "Enable" on the user of a revoked key, either the key works again or the user is still stopped', !(licRow(a, 'Bob').status === 'Revoked' && !bu.disabled && v.status === 403),
      { licenseTable: licRow(a, 'Bob').status, usersTable: bu.disabled ? 'Disabled' : `enabled, ${bu.copies} active copies`, theUserTryingToLogIn: `${v.status} ${v.err}`, theCopyEngineForTheWalletHeCopies: engine });
    await page.locator(`[data-restore="${bobKey}"]`).click();
    await after((x) => licRow(x, 'Bob').status === 'Active');
    if (parts.bob && parts.bob.page) {
      const bp = parts.bob.page;
      await ui.gotoApp(bp, '/');
      if (await bp.locator('.auth #l').count()) { await ui.enter(bp, K.bob.key); await bp.locator('.topbar').waitFor({ timeout: 6000 }).catch(() => undefined); }
    }
  });

  await env.scenario('admin: Delete an unused key; a key for an account that has none', async () => {
    let a = await A();
    const id = licRow(a, 'Spare one').id;
    const n0 = apiCalls(page, /^\/api\/admin\/licenses\/\d+$/).length;
    planDialog(page, { accept: false });
    await page.locator(`[data-delete="${id}"]`).click();
    await sleep(400);
    book.eq('Delete (unused key) asks first; "Cancel" keeps it', [page.__lastDialog.message, apiCalls(page, /^\/api\/admin\/licenses\/\d+$/).length - n0, !!licRow(await A(), 'Spare one')], ['Delete this unused key?', 0, true]);
    planDialog(page, { accept: true });
    await page.locator(`[data-delete="${id}"]`).click();
    a = await after((x) => !licRow(x, 'Spare one'));
    book.ok('Delete (unused key): the key is gone from the table', !!a);
    const v = await tryLogin('deleted-key', nextIp(), K.spare1.key);
    book.eq('Delete (unused key): the deleted key gets nobody in', [v.status, v.err], [403, 'that license key is not valid']);
    await v.V.context.close();
    book.ok('a key that was revoked before anyone used it offers Restore but no Delete', JSON.stringify(licRow(a, 'Old key').buttons) === JSON.stringify(['Set fee', 'New key', 'Restore']), licRow(a, 'Old key').buttons);

    // Dave: an account from before license keys.
    const dave = userRow(a, 'Dave');
    book.eq('an account without a key: the Users table offers "Create key"', dave.buttons, ['Create key', 'Disable']);
    await page.locator(`[data-userkey="${dave.id}"]`).click();
    a = await after((x) => x.newKey && /Key for Dave/.test(x.newKey.text));
    const key = a && a.newKey.key;
    book.ok('Create key (Users table): a key for Dave is shown; his row now names his license and the button is gone; the key table has an Active row for him', !!a && KEY_RE.test(key) && userRow(a, 'Dave').license === 'Dave' && !userRow(a, 'Dave').buttons.includes('Create key') && licRow(a, 'Dave').status === 'Active' && licRow(a, 'Dave').account === 'Dave', a && [userRow(a, 'Dave'), licRow(a, 'Dave')]);
    if (key) {
      const d = await tryLogin('dave', nextIp(), key);
      book.eq('Create key (Users table): the key gets Dave into his own account', [d.status, d.who], [200, 'Dave']);
      await d.V.context.close();
    }
  });

  await env.scenario('admin: Settings (platform fee, fee wallet, max per buy, the live switch)', async () => {
    const save = async () => {
      await ui.hideToast(page);
      const [resp] = await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/settings', { timeout: 4000 }).catch(() => null), page.locator('#settings button[type=submit]').click()]);
      await sleep(500);
      const t = await page.evaluate(() => { const el = document.querySelector('#toast'); return el.hidden ? null : el.textContent; });
      return { status: resp ? resp.status() : null, toast: t, a: await A() };
    };
    const fresh = parts.fresh && parts.fresh.page;
    const bobPage = parts.bob && parts.bob.page;
    const alicePage = parts.alice && parts.alice.page;

    // Platform fee.
    await page.locator('#set-fee').fill('2.5');
    let r = await save();
    book.eq('Settings: fee 2.5 % saved and shown', [r.status, r.toast, r.a.settings.fee, r.a.licFeePlaceholder], [200, 'Settings saved', '2.5', 'default 2.5']);
    book.ok('Settings: keys without their own fee now read "Default (2.5%)"; keys with their own fee keep it', licRow(r.a, 'Bob').fee === 'Default (2.5%)' && licRow(r.a, 'Alice').fee === '0.5%' && / · fee 2\.5%$/.test(userRow(r.a, 'Bob').sub) && / · fee 0\.5%$/.test(userRow(r.a, 'Alice').sub), [licRow(r.a, 'Bob').fee, licRow(r.a, 'Alice').fee, userRow(r.a, 'Bob').sub, userRow(r.a, 'Alice').sub]);
    if (bobPage) {
      await bobPage.mouse.click(5, 300);
      const ok = await until(async () => (await ui.readDash(bobPage)).top.pills.some((p) => p.text === 'Fee 2.5%'), { timeout: 8000 });
      book.ok('Settings: a user on the default fee sees "Fee 2.5%" on their page within a refresh', !!ok, (await ui.readDash(bobPage)).top.pills);
    }
    if (alicePage) book.eq('Settings: a user whose key has its own fee still sees theirs', (await ui.readDash(alicePage)).top.pills.map((p) => p.text), ['OFFLINE', 'Fee 0.5%']);
    await page.locator('#set-fee').fill('11');
    r = await save();
    book.ok('Settings: a fee above 10 % is stopped (by the browser or the server) and not saved', (r.status === null || r.status === 400) && (await ui.adminState(page)).settings.feePercent === 2.5, { status: r.status, msg: r.a.settings.msg });
    await page.locator('#set-fee').fill('1');

    // Fee wallet.
    book.allow(400, /^\/api\/admin\/settings$/);
    await page.locator('#set-wallet').fill('not-a-wallet');
    r = await save();
    book.eq('Settings: a fee wallet that is not an address is refused in words', [r.status, r.a.settings.msg, r.a.settings.msgClass], [400, 'the fee wallet must be a Solana wallet address', 'down']);
    let st = await ui.adminState(page);
    book.eq('Settings: the refused save changed nothing (not the wallet, and not the fee typed with it)', [st.settings.feeWallet, st.settings.feePercent], [manifest.owner.feeWallet, 2.5]);
    await screenCheck(page, book, 'admin-settings-refused', { ignoreInside: [/table-wrap/] });
    const newWallet = manifest.imports.leaders[0];
    await page.locator('#set-wallet').fill(`  ${newWallet} `);
    r = await save();
    book.eq('Settings: a real address (with spaces around it) is saved as the fee wallet, with the fee back at 1 %', [r.status, r.a.settings.wallet, r.a.settings.fee], [200, newWallet, '1']);

    // Max per buy.
    await page.locator('#set-max').fill('10');
    r = await save();
    book.eq('Settings: max per buy 10 saved', [r.status, r.a.settings.max], [200, '10']);
    if (fresh) {
      await fresh.mouse.click(5, 300);
      await sleep(3400);
      await ui.openPreset(fresh);
      let ed = await ui.readEditor(fresh);
      book.eq('Max per buy raised to 10: the user\'s editor says "Site limit 10 SOL" and the 7 SOL Scharo preset no longer warns', [ed.buyHint, ed.buyHintClass], ['Site limit 10 SOL per buy · platform fee 1%', 'hint']);
      await ui.closeEditor(fresh, 'cancel');
      await page.locator('#set-max').fill('6.5');
      r = await save();
      await sleep(3400);
      await ui.openPreset(fresh);
      ed = await ui.readEditor(fresh);
      book.eq('Max per buy lowered to 6.5: the Scharo preset warns that its 7 SOL buys are skipped', [ed.buyHint, ed.buyHintClass], ['Above the site limit of 6.5 SOL per buy: these buys are skipped until the owner raises "Max per buy" on the admin page.', 'hint down']);
      await ui.closeEditor(fresh, 'cancel');
    }
    await page.locator('#set-max').fill('');
    r = await save();
    book.eq('Settings: an empty max per buy keeps the value it had', [r.status, (await ui.adminState(page)).settings.maxSolPerBuy], [200, 6.5]);
    await page.locator('#set-max').fill('2000');
    r = await save();
    book.ok('Settings: a max per buy of 2000 is refused with the real reason (the limit is 1000), not "must be above 0"', r.status === 400 && /1000|at most/.test(r.a.settings.msg), { status: r.status, said: r.a.settings.msg });
    await page.locator('#set-max').fill('0');
    r = await save();
    book.ok('Settings: a max per buy of 0 is stopped and not saved', (r.status === null || r.status === 400) && (await ui.adminState(page)).settings.maxSolPerBuy === 6.5, { status: r.status, msg: r.a.settings.msg });
    await page.locator('#set-max').fill('5');
    r = await save();

    // The live switch.
    planDialog(page, { accept: false });
    await page.locator('#set-live + span').click();
    await sleep(300);
    let a = await A();
    book.eq('Live trading switch asks first; "Cancel" leaves it off', [page.__lastDialog.message, a.settings.live, a.settings.liveText], ['Turn live trading ON? Every enabled copy on the site will then buy and sell with real SOL.', false, 'Test mode']);
    planDialog(page, { accept: true });
    await page.locator('#set-live + span').click();
    await sleep(300);
    a = await A();
    book.eq('Live trading switch, confirmed: on, and says it takes effect after saving', [a.settings.live, a.settings.liveText], [true, 'Live trading will be ON after saving']);
    r = await save();
    book.eq('Live trading, offline: Save is refused with a reason a person can read', [r.status, r.a.settings.msg, r.a.settings.msgClass], [400, 'the Helius link is not set on the server yet: live trading needs it', 'down']);
    st = await ui.adminState(page);
    book.eq('Live trading, offline: the site stays in test/offline (nothing was switched)', [st.settings.liveTrading, st.server.live, st.server.mode], [false, false, 'offline']);
    await screenCheck(page, book, 'admin-live-refused', { ignoreInside: [/table-wrap/] });
    await page.reload();
    await page.locator('.topbar').waitFor();
    a = await A();
    book.eq('Live trading, offline: after a reload the switch is off again', [a.settings.live, a.settings.liveText], [false, 'Test mode']);
    r = await save();
    book.eq('Settings: Save with nothing changed says it saved', [r.status, r.toast], [200, 'Settings saved']);
  });

  await env.scenario('admin: the Status tab (read-only)', async () => {
    await page.locator('.topbar .nav [data-tab=connections]').click();
    let a = await until(async () => { const x = await A(); return x.status && x.cards[0].pill !== 'Checking…' && x.buttons[0] && x.buttons[0].text === 'Check again' ? x : null; }, { timeout: 12_000 });
    book.ok('Status: opens and finishes its checks', !!a);
    if (!a) return;
    book.eq('Status: nothing to type into, one button', [a.inputs, a.buttons.map((b) => b.text)], [0, ['Check again']]);
    book.eq('Status (offline): headline and where each key comes from', a.cards.map((c) => [(/^(Status|Helius|Jupiter)/.exec(c.head) || [])[1], c.pill]), [['Status', 'Needs attention'], ['Helius', 'Not set on the server'], ['Jupiter', 'Not set on the server']]);
    const rows = Object.fromEntries(a.cards.flatMap((c) => c.rows).map((r) => [r.name, r]));
    book.eq('Status (offline): Helius RPC red, stream and Sender amber, each with the reason', [rows['Helius RPC'], rows['Helius stream'], rows['Helius Sender']].map((r) => r && [r.dot, r.detail]), [['bad', 'the Helius link is not set on the server'], ['warn', 'the Helius link is not set on the server'], ['warn', 'the Helius link is not set on the server']]);
    book.ok('Status: the Jupiter row is a real request made just now (answered here by the local stand-in), green, timed', !!rows.Jupiter && rows.Jupiter.dot === 'good' && /^real quote in \d+ ms, with no key \(the free, slower lane\)$/.test(rows.Jupiter.detail), rows.Jupiter);
    await screenCheck(page, book, 'admin-status');
    const hits0 = stub.hits;
    const n0 = apiCalls(page, /^\/api\/admin\/connections$/).length;
    await page.locator('#conn-check').click();
    const busy = await page.locator('#conn-check').evaluate((b) => ({ text: b.textContent, disabled: b.disabled })).catch(() => null);
    await until(async () => apiCalls(page, /^\/api\/admin\/connections$/).length > n0, { timeout: 8000 });
    book.ok('Status: "Check again" runs the checks again (the button shows "Checking…" meanwhile)', apiCalls(page, /^\/api\/admin\/connections$/).length === n0 + 1 && stub.hits > hits0 && !!busy && busy.text === 'Checking…' && busy.disabled, { busy, requests: apiCalls(page, /^\/api\/admin\/connections$/).length - n0, standInHits: stub.hits - hits0 });
    stub.mode = 'down';
    await sleep(300);
    await page.locator('#conn-check').click();
    a = await until(async () => { const x = await A(); const j = x.status && x.cards.flatMap((c) => c.rows).find((r2) => r2.name === 'Jupiter'); return j && j.dot === 'bad' ? x : null; }, { timeout: 10_000 });
    const j = a && a.cards.flatMap((c) => c.rows).find((r2) => r2.name === 'Jupiter');
    book.ok('Status: when Jupiter does not answer its row turns red and says what came back', !!j && /stand-in says: no route today/.test(j.detail), j);
    await page.locator('.topbar .nav [data-tab=admin]').click();
    a = await after((x) => x.banner);
    book.ok('Admin tab: the banner names both connections that need attention', !!a && /Helius RPC — the Helius link is not set on the server/.test(a.banner) && /Jupiter — /.test(a.banner), a && a.banner);
    stub.mode = 'ok';
  });

  await env.scenario('admin: small things (a half-typed name, Open site, logging out)', async () => {
    await page.locator('#lic-label').fill('Half typed');
    await page.locator('.stats').click({ position: { x: 5, y: 5 } });
    await sleep(6000);
    const kept = await page.locator('#lic-label').inputValue();
    book.ok('a name typed into "Who is it for" is still there a few seconds later (the background refresh does not wipe it)', kept === 'Half typed', { typed: 'Half typed', after6s: kept });
    book.eq('admin: "Open site" and the logo both lead to the site', [await page.locator('.topbar a.btn').getAttribute('href'), await page.locator('.topbar .brand').getAttribute('href')], ['/', '/']);
    await page.locator('.topbar a.btn').click();
    await page.locator('#app .auth, #app .topbar').first().waitFor();
    book.eq('admin: "Open site" opens the users\' site', new URL(page.url()).pathname, '/');
    await page.goto('/admin');
    await page.locator('.topbar').waitFor();
    book.ok('admin: coming back from the site, the owner is still logged in', (await page.locator('#admin-logout').count()) === 1);
    if (await page.locator('.topbar .brand').isVisible()) {
      await page.locator('.topbar .brand').click();
      await page.locator('#app .auth, #app .topbar').first().waitFor();
      book.eq('admin: the logo opens the users\' site too', new URL(page.url()).pathname, '/');
    } else {
      book.ok('admin: the logo is on the screen', false, await page.locator('.topbar .brand').evaluate((el) => ({ width: el.getBoundingClientRect().width, parts: [...el.children].map((c) => `${c.className || c.tagName}: ${getComputedStyle(c).display}`) })));
    }
    await page.goto('/admin');
    await page.locator('.topbar').waitFor();
    await page.locator('#admin-logout').click();
    await page.locator('#admin-login').waitFor();
    book.eq('admin: Log out shows the password form and ends the session on the server', (await ui.adminState(page)).__status, 401);
    await page.reload();
    await page.locator('#admin-login, .topbar').first().waitFor();
    book.ok('admin: logged out stays logged out after a reload', (await page.locator('#admin-login').count()) === 1);
    await page.locator('.auth .foot a').click();
    await page.locator('#app .auth #l, #app .topbar').first().waitFor();
    book.eq('admin login page: "Back to the site" leads to the users\' site', new URL(page.url()).pathname, '/');
    // A user's session is not an admin session.
    const alicePage = parts.alice && parts.alice.page;
    if (alicePage) {
      await alicePage.goto('/admin');
      await alicePage.locator('#admin-login, .topbar').first().waitFor();
      const a = await ui.readAdmin(alicePage);
      book.ok('a logged-in user who opens /admin gets the owner\'s password form, not the owner\'s page', a.login === true && a.tagline === 'Owner area', a);
      await ui.gotoApp(alicePage, '/');
    }
  });

  await env.scenario('limits on logging in', async () => {
    // The owner, with the right password, a few times in a row.
    const O = await env.open('owner-again', env.ip(60));
    const said = [];
    for (let i = 1; i <= 6; i++) {
      await O.page.goto('/admin');
      await O.page.locator('#admin-login').waitFor();
      await O.page.locator('#ap').fill(env.adminPassword);
      book.allow(429, /^\/api\/admin\/login$/);
      const [resp] = await Promise.all([O.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/login'), O.page.locator('#admin-login button[type=submit]').click()]);
      await sleep(300);
      said.push(resp.status() === 200 ? 'in' : `${resp.status()} ${(await O.page.locator('.err').count()) ? await O.page.locator('.err').textContent() : ''}`);
      if (resp.status() === 200) { await O.page.locator('#admin-logout').click(); await O.page.locator('#admin-login').waitFor(); }
    }
    book.ok('the owner can log in and out six times in a row with the right password', said.every((s) => s === 'in'), said);
    await O.context.close();
    // A user, with a good key, a few times in a row (same address).
    const U = await env.open('user-again', env.ip(61));
    const res = [];
    for (let i = 1; i <= 11; i++) {
      const r = await U.context.request.post(`${env.base}/api/enter`, { data: { license: manifest.keys.zed.key }, headers: { 'x-requested-with': 'motionlarp' } });
      res.push(r.status() === 200 ? 'in' : `${r.status()} ${(await r.json().catch(() => ({}))).error || ''}`);
    }
    book.ok('a good license key works eleven times in a row from one address (only wrong keys should count against the limit)', res.every((s) => s === 'in'), res);
    // Wrong keys are limited.
    const W = await env.open('guesser', env.ip(62));
    const g = [];
    for (let i = 1; i <= 11; i++) {
      const r = await W.context.request.post(`${env.base}/api/enter`, { data: { license: `WM-AAAA-AAAA-AAAA-AA${String(i).padStart(2, 'A')}` }, headers: { 'x-requested-with': 'motionlarp' } });
      g.push(r.status());
    }
    book.ok('guessing keys is cut off after ten tries from one address', g.slice(0, 10).every((s) => s === 403) && g[10] === 429, g);
    await U.context.close();
    await W.context.close();
  });

  return S;
}

module.exports = { adminFirstLook, adminEverything };
