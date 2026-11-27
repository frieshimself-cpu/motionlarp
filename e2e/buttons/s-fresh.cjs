'use strict';
// A brand-new user: getting in, the wallet, and every control of the copy editor.
const { planDialog, apiCalls, screenCheck, sleep, until } = require('./lib.cjs');
const ui = require('./ui.cjs');
const X = require('./expected.cjs');

const MIRROR_HINT = {
  same: 'They sell 40% of their bag, you sell 40% of yours.',
  all: 'Any sell of theirs, even a small one, sells your whole bag.',
  exit: 'They sell their whole bag in one go: you sell everything. They only take a part: nothing happens.',
};
const TIMED_HINT = {
  left: 'Each step sells a share of what you still hold at that moment.',
  bag: 'Each step sells a share of the coins your buy received, on its own clock. The last step always sells everything that is left.',
};
const OF = { left: "of what's left", bag: 'of the original bag' };

async function freshUser(env) {
  const { book, manifest, config, vp } = env;
  const S = await env.open('fresh', env.ip(1));
  const { page } = S;
  const K = manifest.keys;
  const imp = manifest.imports;
  const leaders = imp.leaders;
  const D = config.defaults;
  const preset = config.presets[0];
  const made = {}; // name -> { id, settings }

  const tryKey = async (key) => {
    const [resp] = await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === '/api/enter'), ui.enter(page, key)]);
    await sleep(200);
    return { status: resp.status(), err: (await page.locator('.err').count()) ? await page.locator('.err').textContent() : null };
  };

  await env.scenario('user: getting in with a license key', async () => {
    await page.goto('/');
    await page.locator('.auth').waitFor();
    book.eq('login page: the tab title', await page.title(), `${config.brand} — copy trading`);
    const f = await page.evaluate(() => { const q = (s) => document.querySelector(s); return { tagline: q('.tagline').textContent, label: q('label[for=l]').textContent, placeholder: q('#l').placeholder, button: q('#auth-form button').textContent, focused: document.activeElement === q('#l'), brand: q('.brand').textContent.trim(), brandHref: q('.brand').getAttribute('href') }; });
    book.eq('login page: brand, label, placeholder and button', { ...f, focused: undefined }, { tagline: "Copy any wallet's trades. Your size, your fees, your exits.", label: 'License key', placeholder: 'WM-XXXX-XXXX-XXXX-XXXX', button: 'Enter', focused: undefined, brand: config.brand, brandHref: '/' });
    book.ok('login page: the cursor is already in the key box', f.focused);
    const brand = await page.evaluate(() => { const b = document.querySelector('.auth .brand'); const r = b.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height), shownText: b.innerText.trim(), parts: [...b.children].map((c) => `${c.className || c.tagName}: ${getComputedStyle(c).display}`) }; });
    book.ok('login page: the logo and the site\'s name are on the screen', brand.width > 40 && brand.shownText === config.brand, brand);
    await screenCheck(page, book, 'user-login');

    const n0 = apiCalls(page, /^\/api\/enter$/).length;
    await page.locator('#auth-form button[type=submit]').click();
    await sleep(500);
    const msg = await page.evaluate(() => document.querySelector('#l').validationMessage);
    book.ok('login: Enter with an empty box sends nothing and the browser asks for the key', apiCalls(page, /^\/api\/enter$/).length === n0 && (await page.locator('.auth').count()) === 1 && !!msg, { sent: apiCalls(page, /^\/api\/enter$/).length - n0, msg });

    book.allow(403, /^\/api\/enter$/);
    let r = await tryKey('WM-AAAA-BBBB-CCCC-DDDD');
    book.eq('login: a made-up key is refused in plain words', r, { status: 403, err: 'that license key is not valid' });
    await screenCheck(page, book, 'user-login-refused');
    r = await tryKey(K.carol.key);
    book.eq('login: a revoked key (its user had an account) is refused in plain words', r, { status: 403, err: 'this license key was revoked: ask the owner' });
    r = await tryKey(K.revokedUnused.key);
    book.eq('login: a revoked key nobody used is refused in plain words', r, { status: 403, err: 'this license key was revoked: ask the owner' });
    book.ok('login: after a refusal the form is still there, empty, ready for another try', (await page.locator('#l').inputValue()) === '' && (await page.locator('.auth').count()) === 1);

    r = await tryKey(`  ${K.fresh.key.toLowerCase()}  `);
    await page.locator('.topbar').waitFor();
    book.eq('login: a good key typed in small letters with spaces around it gets in', r.status, 200);
    const d = await ui.readDash(page);
    book.eq('first visit: the account is named after the key, shown as text (its markup is not run)', { who: d.top.who, html: d.top.whoHtml.includes('<i>') }, { who: K.fresh.label, html: false });
    book.eq('first visit: who is shown only where there is room for it', d.top.whoShown, !vp.mobile);
    book.eq('first visit: the site says it is offline and shows the fee', d.top.pills.map((p) => p.text), ['OFFLINE', 'Fee 1%']);
    book.eq('first visit: Dashboard is the open tab', d.top.nav, [{ text: 'Dashboard', on: true }, { text: 'History', on: false }]);
    book.eq('first visit: the four cards of an empty account', d.stats.map((s) => [s.label, s.value, s.foot]), [
      ['Wallet balance', '—', 'no wallet yet'],
      ['Profit today test', '0 SOL', 'last 7 days 0'],
      ['Profit all time test', '0 SOL', '0 trades · no closed trades yet'],
      ['Open positions', '0', '0 SOL unrealized · copying 0 of 0'],
    ]);
    book.ok('first visit: wallet box, no copies, nothing open, empty feed', d.wallet.hasForm && /No copies yet/.test(d.copiesEmpty || '') && /Nothing open/.test(d.positionsEmpty || '') && d.feedEmpty === 'Nothing yet.', { wallet: d.wallet, copies: d.copiesEmpty, positions: d.positionsEmpty, feed: d.feedEmpty });
    book.eq('first visit: the buttons above the copies', d.copiesHead, ['Scharo preset', 'New copy']);
    await screenCheck(page, book, 'user-dashboard-empty');

    await ui.openTab(page, 'history');
    const h = await ui.readHistory(page);
    book.ok('History of an empty account: two empty tables with a sentence each', /No closed trades yet/.test(h.dayEmpty || '') && /No closed positions yet/.test(h.closedEmpty || '') && /^Closed positions\s*0 · total 0 SOL · 0% winners$/.test(h.closedHead), h);
    await screenCheck(page, book, 'user-history-empty');
    await ui.openTab(page, 'dash');
  }, { always: true });

  await env.scenario('user: reload, log out, come back', async () => {
    await page.reload();
    await page.locator('#app .auth, #app .topbar').first().waitFor();
    book.ok('the session survives a reload', (await page.locator('.topbar').count()) === 1);
    planDialog(page, { accept: false });
    await page.locator('#logout').click();
    await sleep(400);
    book.eq('Log out asks first', page.__lastDialog && { type: page.__lastDialog.type, message: page.__lastDialog.message }, { type: 'confirm', message: 'Log out on this device? You will need your license key to get back in.' });
    book.ok('Log out, answered "Cancel": still in', (await page.locator('.topbar').count()) === 1);
    planDialog(page, { accept: true });
    await page.locator('#logout').click();
    await page.locator('.auth').waitFor();
    book.ok('Log out, answered "OK": the key form is back', true);
    const st = await ui.state(page);
    book.eq('after logging out the session is dead on the server too', st.__status, 401);
    await page.reload();
    await page.locator('#app .auth, #app .topbar').first().waitFor();
    book.ok('after logging out a reload still shows the key form', (await page.locator('.auth').count()) === 1);
    // The way most people do it: paste the key, press the Enter key.
    await page.locator('#l').fill(K.fresh.key);
    const [resp] = await Promise.all([page.waitForResponse((x) => new URL(x.url()).pathname === '/api/enter'), page.locator('#l').press('Enter')]);
    const drawn = await page.locator('.topbar').waitFor({ timeout: 7000 }).then(() => true, () => false);
    const st2 = await ui.state(page);
    const where = await page.evaluate(() => ({ focusIsIn: document.activeElement ? (document.activeElement.id ? '#' + document.activeElement.id : document.activeElement.tagName) : null, keyStillInBox: document.querySelector('#l') ? document.querySelector('#l').value.length > 0 : null, formStillShown: !!document.querySelector('#auth-form') }));
    book.ok('the key sent with the Enter KEY (not the button) opens the dashboard', resp.status() === 200 && drawn, { serverAnswered: resp.status(), serverNowSaysLoggedInAs: st2.user ? st2.user.username : st2.__status, after7sThePageShows: drawn ? 'the dashboard' : 'still the key form', ...where });
    if (!drawn) {
      await screenCheck(page, book, 'user-login-stuck-after-enter-key');
      // Take the cursor out of the box: the next 3-second refresh then draws the dashboard.
      await page.mouse.click(8, 8);
      const later = await page.locator('.topbar').waitFor({ timeout: 6000 }).then(() => true, () => false);
      book.note('logged in with the Enter key: the dashboard appeared only after a click outside the key box', later);
      if (!later) { await page.reload(); await page.locator('.topbar').waitFor(); }
    }
    const d = await ui.readDash(page);
    book.ok('the same key later returns to the same account', d.top.who === K.fresh.label, { who: d.top.who });
  });

  await env.scenario('user: the trading wallet (import, refuse an address, copy, remove)', async () => {
    const sendWallet = async (text) => {
      await page.locator('#wk').fill(text);
      await ui.hideToast(page);
      const [resp] = await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === '/api/wallet'), page.locator('#wallet-form button[type=submit]').click()]);
      return { status: resp.status(), toast: await ui.toast(page) };
    };
    book.eq('wallet: the key box hides what is typed', await page.evaluate(() => getComputedStyle(document.querySelector('#wk')).webkitTextSecurity), 'disc');
    const n0 = apiCalls(page, /^\/api\/wallet$/).length;
    await page.locator('#wallet-form button[type=submit]').click();
    await sleep(400);
    book.ok('wallet: Import with an empty box sends nothing', apiCalls(page, /^\/api\/wallet$/).length === n0);

    book.allow(400, /^\/api\/wallet$/);
    let r = await sendWallet(imp.address);
    book.eq('wallet: a wallet ADDRESS pasted instead of a key is refused, and says why', r, { status: 400, toast: { text: 'that is a wallet address, not a private key: export the private key from your wallet', bad: true } });
    await screenCheck(page, book, 'user-wallet-refused');
    book.eq('wallet: nothing was saved by the refused paste', (await ui.state(page)).wallet, null);
    r = await sendWallet('this is not a key');
    book.ok('wallet: nonsense is refused with a message', r.status === 400 && r.toast && r.toast.bad && /not a valid private key|private key has/.test(r.toast.text), r);
    r = await sendWallet('[1, 2, 3');
    book.eq('wallet: a broken byte list is refused with a message', r, { status: 400, toast: { text: 'that looks like a byte array but is not valid JSON', bad: true } });
    r = await sendWallet(imp.seed32);
    book.ok('wallet: a 32-number list (not a full key) is refused with a message', r.status === 400 && r.toast && r.toast.bad, r);
    book.note('wallet: what a 32-number seed list is told', r.toast && r.toast.text);

    r = await sendWallet(imp.base58.secret);
    book.eq('wallet: a base58 private key is taken', r, { status: 200, toast: { text: 'Wallet imported', bad: false } });
    await page.locator('.sol-big').waitFor();
    let d = await ui.readDash(page);
    book.eq('wallet: the card shows the address that key belongs to, linked to Solscan', { addr: d.wallet.addr, href: d.wallet.addrHref }, { addr: imp.base58.pubkey, href: `https://solscan.io/account/${imp.base58.pubkey}` });
    book.eq('wallet: Copy address and Remove are offered', d.wallet.buttons, ['Copy address', 'Remove']);
    book.eq('wallet: the top card names the wallet', d.stats[0].foot, X.short(imp.base58.pubkey));
    book.eq('wallet: the feed says it was imported', d.feed[0] && { kind: d.feed[0].kind, icon: d.feed[0].icon, msg: d.feed[0].msg }, { kind: 'info', icon: 'i', msg: `Wallet ${X.short(imp.base58.pubkey)} imported` });
    const st = await ui.state(page);
    book.eq('wallet (offline): the server could not read the balance and says so (null)', st.wallet, { pubkey: imp.base58.pubkey, sol: null });
    book.ok('wallet: a balance that could not be read is not shown as "0 SOL"', !/^0 SOL$/.test(d.wallet.sol) && !/^0 SOL$/.test(d.stats[0].value), { walletCard: d.wallet.sol, topCard: d.stats[0].value, serverSaid: st.wallet });
    const leaked = page.__api.filter((c) => c.body.includes(imp.base58.secret)).map((c) => c.url);
    book.ok('wallet: the private key never comes back from the server or into the page', leaked.length === 0 && !(await page.content()).includes(imp.base58.secret), leaked);
    await screenCheck(page, book, 'user-wallet-imported');

    await ui.hideToast(page);
    await page.locator('#copy-addr').click();
    const t = await ui.toast(page);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard: ${e}`);
    book.eq('wallet: Copy address puts the address on the clipboard and says so', { toast: t, clip }, { toast: { text: 'Address copied', bad: false }, clip: imp.base58.pubkey });

    planDialog(page, { accept: false });
    await page.locator('#remove-wallet').click();
    await sleep(400);
    book.eq('wallet: Remove asks first, in words that say the coins stay', page.__lastDialog.message, 'Remove this wallet from the site? Your coins and SOL stay in it — only the stored key is deleted.');
    book.ok('wallet: Remove answered "Cancel" keeps the wallet', (await ui.state(page)).wallet !== null);
    planDialog(page, { accept: true });
    await ui.hideToast(page);
    await page.locator('#remove-wallet').click();
    book.eq('wallet: Remove answered "OK" removes it and says so', await ui.toast(page), { text: 'Wallet removed', bad: false });
    await page.locator('#wallet-form').waitFor();
    d = await ui.readDash(page);
    book.ok('wallet: after removing, the import box is back and the feed has a line', (await ui.state(page)).wallet === null && d.feed[0].msg === 'Wallet removed from the server', d.feed[0]);

    r = await sendWallet(imp.json.secret);
    book.eq('wallet: the [12, 34, …] list form of a key is taken', r, { status: 200, toast: { text: 'Wallet imported', bad: false } });
    await page.locator('.sol-big').waitFor();
    d = await ui.readDash(page);
    book.eq('wallet: the list form gives the right address', d.wallet.addr, imp.json.pubkey);
  });

  // ── the copy editor ────────────────────────────────────────────────────
  const maxBuy = () => ui.state(page).then((s) => s.server.maxSolPerBuy);

  await env.scenario('editor: a new copy starts at the defaults; every switch, button and hint', async () => {
    const max = await maxBuy();
    await ui.openNew(page);
    let ed = await ui.readEditor(page);
    book.eq('new copy: title, buttons, and a box for several wallets', { title: ed.title, submit: ed.submit, hasDelete: ed.hasDelete, tag: ed.leaderTag, label: ed.leaderLabel, presets: ed.presetButtons }, { title: 'New copy', submit: 'Start copying', hasDelete: false, tag: 'TEXTAREA', label: 'Wallets to copy', presets: [{ id: 'scharo', text: 'Scharo', primary: false }] });
    book.eq('new copy: every box starts at the site defaults', {
      leader: ed.leader, name: ed.name, buy: Number(ed.buy), min: Number(ed.min), prio: Number(ed.prio), tip: Number(ed.tip), sprio: Number(ed.sprio), stip: Number(ed.stip), slip: Number(ed.slip),
      mirror: ed.mirror.on, mirrorMode: ed.mirrorMode, timed: ed.timed.on, timedOf: ed.timedOf, stop: ed.stop.on, dead: ed.dead.on, idle: Number(ed.idle), once: ed.once,
    }, {
      leader: '', name: '', buy: D.buySol, min: D.minLeaderBuySol, prio: D.priorityFeeSol, tip: D.tipSol, sprio: D.sellPriorityFeeSol, stip: D.sellTipSol, slip: D.slippagePct,
      mirror: D.sell.mirror.enabled, mirrorMode: [D.sell.mirror.mode], timed: false, timedOf: [D.sell.timedOf], stop: false, dead: D.sell.deadCoin.enabled, idle: D.sell.deadCoin.idleSec, once: D.oncePerCoin,
    });
    book.eq('new copy: under "Your buy" the site limit and the platform fee', { text: ed.buyHint, cls: ed.buyHintClass }, { text: `Site limit ${max} SOL per buy · platform fee 1%`, cls: 'hint' });
    book.eq('new copy: rules that are off keep their boxes folded away', [ed.mirror.bodyShown, ed.timed.bodyShown, ed.stop.bodyShown, ed.dead.bodyShown], [true, false, false, false]);
    book.eq('new copy: says the site is in test mode', ed.modeHint, 'The site is in test mode: trades are simulated, nothing is sent.');
    await screenCheck(page, book, 'editor-new');

    // "Your buy" against the site limit
    await page.locator('#f-buy').fill(String(max + 2));
    ed = await ui.readEditor(page);
    book.eq('buy above the site limit: a red warning that these buys are skipped', { text: ed.buyHint, cls: ed.buyHintClass }, { text: `Above the site limit of ${max} SOL per buy: these buys are skipped until the owner raises "Max per buy" on the admin page.`, cls: 'hint down' });
    await page.locator('#f-buy').fill(String(max));
    ed = await ui.readEditor(page);
    book.eq('buy exactly at the site limit: no warning', ed.buyHintClass, 'hint');
    await page.locator('#f-buy').fill(String(max + 0.000001));
    book.eq('buy a hair above the site limit: warning', (await ui.readEditor(page)).buyHintClass, 'hint down');
    await page.locator('#f-buy').fill('0.05');

    // Sell when they sell: three modes
    for (const v of ['all', 'exit', 'same']) {
      await page.locator(`#f-mirror-mode [data-v=${v}]`).click();
      ed = await ui.readEditor(page);
      book.eq(`sell when they sell: "${v}" is marked alone and its sentence follows`, { on: ed.mirrorMode, hint: ed.mirrorHint }, { on: [v], hint: MIRROR_HINT[v] });
    }
    await ui.setRule(page, 'mirror', false);
    book.eq('sell when they sell: the switch folds the rule away', (await ui.readEditor(page)).mirror, { on: false, bodyShown: false, title: 'Sell when they sell', desc: 'When the wallet sells, you sell.' });
    await ui.setRule(page, 'mirror', true);

    // Timed sells
    await ui.setRule(page, 'timed', true);
    ed = await ui.readEditor(page);
    book.eq('timed sells: switched on, three starting steps', ed.timedRows.map((r) => [r.a, r.b]), [['3', '25'], ['6', '50'], ['9', '100']]);
    book.eq('timed sells: starts as "% of what\'s left" with its sentence', { of: ed.timedOf, hint: ed.timedHint, rest: ed.timedRows.map((r) => r.rest) }, { of: ['left'], hint: TIMED_HINT.left, rest: [OF.left, OF.left, OF.left] });
    book.note('timed sells: is the "of what\'s left" text of each row visible at this width', ed.timedRows.map((r) => r.restShown));
    await page.locator('#f-timed-of [data-v=bag]').click();
    ed = await ui.readEditor(page);
    book.eq('timed sells: "% of the original bag" — every row and the sentence follow', { of: ed.timedOf, hint: ed.timedHint, rest: ed.timedRows.map((r) => r.rest) }, { of: ['bag'], hint: TIMED_HINT.bag, rest: [OF.bag, OF.bag, OF.bag] });
    await screenCheck(page, book, 'editor-timed-bag');
    await page.locator('[data-add=timed]').click();
    ed = await ui.readEditor(page);
    book.eq('timed sells: Add step adds a row (empty seconds, 100 %) that follows the mode', ed.timedRows.map((r) => [r.a, r.b, r.rest]), [['3', '25', OF.bag], ['6', '50', OF.bag], ['9', '100', OF.bag], ['', '100', OF.bag]]);
    await page.locator('#f-timed-of [data-v=left]').click();
    ed = await ui.readEditor(page);
    book.eq('timed sells: back to "% of what\'s left" — every row follows, the added one too', { of: ed.timedOf, hint: ed.timedHint, rest: ed.timedRows.map((r) => r.rest) }, { of: ['left'], hint: TIMED_HINT.left, rest: [OF.left, OF.left, OF.left, OF.left] });
    await page.locator('#timed-rows .stage [data-remove]').nth(1).click();
    ed = await ui.readEditor(page);
    book.eq('timed sells: ✕ removes that row only', ed.timedRows.map((r) => [r.a, r.b]), [['3', '25'], ['9', '100'], ['', '100']]);
    for (const [btn, rows] of [['25,50,100@3', [['3', '25'], ['6', '50'], ['9', '100']]], ['50,100@10', [['10', '50'], ['20', '100']]], ['100@30', [['30', '100']]]]) {
      await page.locator(`[data-preset="${btn}"]`).click();
      ed = await ui.readEditor(page);
      book.eq(`timed sells: the ladder button ${btn} fills its steps`, ed.timedRows.map((r) => [r.a, r.b]), rows);
    }
    await page.locator('#f-timed-of [data-v=bag]').click();
    await page.locator('[data-preset="50,100@10"]').click();
    ed = await ui.readEditor(page);
    book.eq('timed sells: a ladder button pressed in "original bag" mode makes rows that say so', ed.timedRows.map((r) => r.rest), [OF.bag, OF.bag]);
    await page.locator('#f-timed-of [data-v=left]').click();

    // Stop loss
    await ui.setRule(page, 'stop', true);
    ed = await ui.readEditor(page);
    book.eq('stop loss: switched on, one starting level (−30 % → 100 %)', ed.stopRows.map((r) => [r.a, r.b]), [['30', '100']]);
    await page.locator('[data-add=stop]').click();
    book.eq('stop loss: Add level adds a row', (await ui.readEditor(page)).stopRows.map((r) => [r.a, r.b]), [['30', '100'], ['', '100']]);
    await page.locator('#stop-rows .stage [data-remove]').first().click();
    book.eq('stop loss: ✕ removes that level only', (await ui.readEditor(page)).stopRows.map((r) => [r.a, r.b]), [['', '100']]);

    // Dead coin, once
    await ui.setRule(page, 'dead', true);
    ed = await ui.readEditor(page);
    book.eq('dead coin: switched on, 120 seconds to start', { shown: ed.dead.bodyShown, idle: ed.idle }, { shown: true, idle: '120' });
    await page.locator('#f-once + span').click();
    book.eq('"Buy each coin only once": the switch turns off', (await ui.readEditor(page)).once, false);
    await page.locator('#f-once + span').click();
    book.eq('"Buy each coin only once": and on again', (await ui.readEditor(page)).once, true);
    await screenCheck(page, book, 'editor-all-rules-open');

    // Four ways out, none of which saves anything
    const before = (await ui.state(page)).copies.length;
    await ui.closeEditor(page, 'cancel');
    book.ok('Cancel closes the editor', !(await ui.editorOpen(page)));
    for (const how of ['x', 'escape', 'backdrop']) {
      await ui.openNew(page);
      await page.locator('#f-leader').fill(leaders[0]);
      await ui.closeEditor(page, how);
      book.ok(`the editor closes by ${how === 'x' ? 'its ✕' : how === 'escape' ? 'the Escape key' : 'a click beside it'}`, !(await ui.editorOpen(page)));
    }
    book.ok('closing the editor saves nothing and gives the page its scrolling back', (await ui.state(page)).copies.length === before && (await page.evaluate(() => document.body.style.overflow)) === '');
  });

  await env.scenario('editor: Start copying with a wrong or missing wallet address', async () => {
    const before = (await ui.state(page)).copies.length;
    await ui.openNew(page);
    await ui.hideToast(page);
    const posts0 = apiCalls(page, /^\/api\/copies$/).length;
    await ui.submitEditor(page);
    await sleep(900);
    const t = await page.evaluate(() => { const el = document.querySelector('#toast'); return el.hidden ? null : el.textContent; });
    const open = await ui.editorOpen(page);
    const after = (await ui.state(page)).copies.length;
    book.ok('Start copying with NO wallet address: it is refused and says an address is needed (it must not say "Copying started")', open && t !== 'Copying started', { editorStillOpen: open, toast: t, copiesBefore: before, copiesAfter: after, requestsSent: apiCalls(page, /^\/api\/copies$/).length - posts0, error: open ? (await ui.readEditor(page)).err : null });
    if (!open) await ui.openNew(page);

    book.allow(400, /^\/api\/copies$/);
    await page.locator('#f-leader').fill('not-a-wallet');
    await ui.submitEditor(page);
    await page.locator('#form-err .err').waitFor();
    book.eq('Start copying with a wrong address: refused in words, the editor stays open', { err: (await ui.readEditor(page)).err, open: await ui.editorOpen(page) }, { err: 'enter the wallet address to copy (a Solana wallet address)', open: true });
    await page.locator('#f-leader').fill(imp.base58.secret.slice(0, 60));
    await ui.submitEditor(page);
    await sleep(500);
    book.eq('Start copying with a too-long string: refused the same way', (await ui.readEditor(page)).err, 'enter the wallet address to copy (a Solana wallet address)');
    await screenCheck(page, book, 'editor-bad-address');

    // Numbers out of range are refused by the server in words (the form itself lets them through).
    const bad = [
      [{ buy: 101 }, 'buy amount must be above 0 and at most 100 SOL'],
      [{ buy: 0 }, 'buy amount must be above 0 and at most 100 SOL'],
      [{ slip: 0.1 }, 'slippage must be between 0.5 % and 100 %'],
      [{ slip: 101 }, 'slippage must be between 0.5 % and 100 %'],
      [{ prio: 0.2 }, 'priority fee must be between 0 and 0.1 SOL'],
      [{ tip: 0.6 }, 'tip must be between 0 and 0.5 SOL'],
      [{ sprio: 0.2 }, 'sell priority fee must be between 0 and 0.1 SOL'],
      [{ stip: 0.6 }, 'sell tip must be between 0 and 0.5 SOL'],
      [{ min: -1 }, /^(the minimum leader buy cannot be negative|Only when they buy at least: "-1" is not a number)$/],
      [{ timed: { on: true, rows: [[5, 0]] } }, 'timed sell 1: the percent to sell must be above 0 and at most 100'],
      [{ timed: { on: true, rows: [[5, 101]] } }, 'timed sell 1: the percent to sell must be above 0 and at most 100'],
      [{ timed: { on: true, rows: [[-1, 50]] } }, /^(timed sell 1: seconds must be 0 or more \(at most 7 days\)|seconds: "-1" is not a number)$/],
      [{ timed: { on: true, rows: Array.from({ length: 11 }, (_, i) => [i + 1, 10]) } }, 'at most 10 timed sells'],
      [{ stop: { on: true, rows: [[100, 50]] } }, 'stop loss 1: the loss must be between 0 % and 100 %'],
      [{ stop: { on: true, rows: [[30, 0]] } }, 'stop loss 1: the percent to sell must be above 0 and at most 100'],
      [{ dead: { on: true, idle: 3 } }, 'dead coin: seconds without trades must be at least 5'],
    ];
    const got = [];
    for (const [patch, want] of bad) {
      await ui.closeEditor(page, 'cancel');
      await ui.openNew(page);
      await page.locator('#f-leader').fill(leaders[0]);
      await ui.fillEditor(page, patch);
      const [resp] = await Promise.all([page.waitForResponse((r2) => new URL(r2.url()).pathname === '/api/copies', { timeout: 4000 }).catch(() => null), ui.submitEditor(page)]);
      await sleep(150);
      const e = (await ui.editorOpen(page)) ? (await ui.readEditor(page)).err : '(the editor closed)';
      if (want instanceof RegExp ? !want.test(e) : e !== want) got.push({ typed: patch, said: e, expected: String(want), status: resp && resp.status() });
    }
    book.ok(`every out-of-range number (${bad.length} tried) is refused with its own sentence and nothing is saved`, got.length === 0 && (await ui.state(page)).copies.length === after, got);
    await ui.closeEditor(page, 'cancel');
  });

  /** Types a copy, starts it, checks the row, the server's copy, and the editor re-opened. */
  async function createAndVerify(label, spec, leader, nick) {
    await ui.openNew(page);
    await ui.fillEditor(page, { ...spec, leaderText: leader, name: nick });
    await ui.hideToast(page);
    await ui.submitEditor(page);
    const t = await ui.toast(page);
    book.ok(`${label}: Start copying says it started`, !!t && t.text === 'Copying started' && !t.bad, { toast: t, formError: (await ui.editorOpen(page)) ? (await ui.readEditor(page)).err : null, lastRequest: (apiCalls(page, /^\/api\/copies$/).pop() || {}).sent, boxNow: (await ui.editorOpen(page)) ? (await ui.readEditor(page)).leader : null });
    await until(async () => !(await ui.editorOpen(page)));
    const name = nick || X.short(leader);
    const want = ui.settingsOf(spec, leader, name);
    const st = await ui.state(page);
    const saved = st.copies.find((c) => c.name === name && c.leader === leader);
    book.ok(`${label}: the server holds exactly what was typed (every field)`, !!saved && JSON.stringify(ui.stripCopy(saved)) === JSON.stringify(want), { saved: saved && ui.stripCopy(saved), typed: want });
    if (!saved) return null;
    made[label] = { id: saved.id, settings: want, name };
    await page.locator(`[data-edit="${saved.id}"]`).waitFor();
    const d = await ui.readDash(page);
    const row = d.copies.find((c) => c.id === saved.id);
    book.eq(`${label}: its line on the dashboard (who, buy, minimum, fees, slippage)`, row.meta[0], `${X.short(leader)} · buy ${want.buySol} SOL when they buy ≥ ${want.minLeaderBuySol} SOL · ${X.feeText(want)} SOL · slippage ${want.slippagePct}%`);
    book.eq(`${label}: its sell rules as tags`, row.tags, X.sellTags(want.sell));
    book.eq(`${label}: its counters start at nothing, switch on, marked TEST, links to the wallet`, { stats: row.meta[1], on: row.on, pill: row.pill, href: row.leaderHref, paused: row.paused }, { stats: '0 open · 0 closed · 0 SOL', on: true, pill: 'TEST', href: `https://solscan.io/account/${leader}`, paused: false });
    await ui.openEdit(page, saved.id);
    const ed = await ui.readEditor(page);
    book.eq(`${label}: re-opened, the editor is in "edit" form`, { title: ed.title, submit: ed.submit, hasDelete: ed.hasDelete, tag: ed.leaderTag, presetBar: ed.presetBar }, { title: `Edit ${name}`, submit: 'Save changes', hasDelete: true, tag: 'INPUT', presetBar: null });
    book.eq(`${label}: re-opened, every value is what was saved (sell fees, "% of", sell-when-they-sell mode, minimum leader buy, …)`, ui.editorVsSettings(ed, want), []);
    await ui.closeEditor(page, 'x');
    return saved;
  }

  const SPEC_A = { buy: 0.25, min: 0.75, prio: 0.0011, tip: 0.0022, sprio: 0.0033, stip: 0.0044, slip: 33.5, mirror: { on: true, mode: 'same' }, timed: { on: true, of: 'left', rows: [[2.5, 20], [5, 35], [12, 100]] }, stop: { on: true, rows: [[15, 40], [45, 100]] }, dead: { on: true, idle: 45 }, once: true };
  const SPEC_B = { buy: 1.5, min: 0, prio: 0.004, tip: 0, sprio: 0.004, stip: 0, slip: 100, mirror: { on: true, mode: 'all' }, timed: { on: true, of: 'bag', rows: [[4, 60], [8, 100]] }, stop: { on: false, rows: [[30, 100]] }, dead: { on: false, idle: 120 }, once: false };
  const SPEC_C = { buy: 0.011, min: 0.123456789, prio: 0, tip: 0.000005, sprio: 0.1, stip: 0.5, slip: 0.5, mirror: { on: true, mode: 'exit' }, timed: { on: false, of: 'left', rows: [[3, 25]] }, stop: { on: true, rows: [[99, 100]] }, dead: { on: true, idle: 5 }, once: true };
  const SPEC_D = { buy: 100, min: 2, prio: 0.0005, tip: 0, sprio: 0.0005, stip: 0, slip: 25, mirror: { on: false, mode: 'same' }, timed: { on: false, of: 'left', rows: [[3, 25]] }, stop: { on: false, rows: [[30, 100]] }, dead: { on: false, idle: 120 }, once: true };

  await env.scenario('editor: create copies of every kind and re-open each (round trip)', async () => {
    await createAndVerify('copy A (same %, timed of what is left, two stop levels, dead coin)', SPEC_A, leaders[0], 'Alpha');
    await createAndVerify('copy B (sell everything, timed of the original bag, no stop, no dead coin, buy again)', SPEC_B, leaders[1], 'Beta');
    await createAndVerify('copy C (only their full exit, stop loss, dead coin; smallest and largest allowed fees)', SPEC_C, leaders[2], '');
    await createAndVerify('copy D (no automatic sell at all, 100 SOL buy)', SPEC_D, leaders[3], 'Delta');
    await screenCheck(page, book, 'user-dashboard-copies');
    const d = await ui.readDash(page);
    book.eq('the top card counts the copies', d.stats[3].foot, '0 SOL unrealized · copying 4 of 4');

    // A comma typed as the decimal point, and a number so small the page prints it as "5e-7".
    const dl = made['copy D (no automatic sell at all, 100 SOL buy)'];
    if (dl) {
      await ui.openEdit(page, dl.id);
      await page.locator('#f-buy').fill('0,25');
      await page.locator('#f-stip').fill('0.0000005');
      await ui.hideToast(page);
      await ui.submitEditor(page);
      const t = await ui.toast(page, 4000);
      await until(async () => !(await ui.editorOpen(page)), { timeout: 3000 });
      let now = (await ui.state(page)).copies.find((c) => c.id === dl.id);
      book.ok('"0,25" typed with a comma is saved as 0.25 SOL (never 25, never 0)', !!t && t.text === 'Saved' && now.buySol === 0.25, { toast: t, savedBuy: now.buySol, formError: (await ui.editorOpen(page)) ? (await ui.readEditor(page)).err : null });
      if (await ui.editorOpen(page)) await ui.closeEditor(page, 'cancel');
      book.eq('a sell tip of 0.0000005 SOL is saved as typed', now.sellTipSol, 0.0000005);
      await ui.openEdit(page, dl.id);
      const ed = await ui.readEditor(page);
      await ui.hideToast(page);
      await ui.submitEditor(page);
      const t2 = await ui.toast(page, 4000);
      const stuck = await ui.editorOpen(page);
      book.ok('a copy holding a very small number (shown by the editor as "5e-7") can be opened and saved again untouched', !!t2 && t2.text === 'Saved' && !stuck, { theBoxShows: ed.stip, toast: t2, editorSays: stuck ? (await ui.readEditor(page)).err : null });
      if (stuck) await ui.closeEditor(page, 'cancel');
      const row = (await ui.readDash(page)).copies.find((c) => c.id === dl.id);
      book.note('how the dashboard prints a 0.0000005 SOL tip', row && row.meta[0]);
      // back to what the later checks expect
      await ui.openEdit(page, dl.id);
      await page.locator('#f-buy').fill('100');
      await page.locator('#f-stip').fill('0');
      await ui.submitEditor(page);
      await until(async () => !(await ui.editorOpen(page)), { timeout: 4000 });
      if (await ui.editorOpen(page)) await ui.closeEditor(page, 'cancel');
    }
    const c = made['copy C (only their full exit, stop loss, dead coin; smallest and largest allowed fees)'];
    if (c) book.eq('a copy without a nickname is named after the wallet', c.name, X.short(leaders[2]));
  });

  await env.scenario('editor: the Scharo preset, from the dashboard and from inside the editor', async () => {
    const P = preset.settings;
    const full = { ...D, ...P, sell: P.sell };
    const max = await maxBuy();
    await ui.openPreset(page);
    let ed = await ui.readEditor(page);
    book.eq('Scharo preset (dashboard button): every box equals the preset (wallet, 7 SOL, ≥ 1 SOL, fees 0.001+0.005 / 0.001+0.001, 100 % slippage, only their full exit, 40 % @ 2 s · 30 % @ 4 s · rest @ 6 s of the original bag, no stop loss, no dead coin, buy again)', ui.editorVsSettings(ed, full), []);
    book.eq('Scharo preset: the exact numbers on screen', { leader: ed.leader, name: ed.name, buy: ed.buy, min: ed.min, prio: ed.prio, tip: ed.tip, sprio: ed.sprio, stip: ed.stip, slip: ed.slip, mode: ed.mirrorMode, of: ed.timedOf, rows: ed.timedRows.map((r) => [r.a, r.b]), stop: ed.stop.on, dead: ed.dead.on, once: ed.once },
      { leader: 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih', name: 'Scharo', buy: '7', min: '1', prio: '0.001', tip: '0.005', sprio: '0.001', stip: '0.001', slip: '100', mode: ['exit'], of: ['bag'], rows: [['2', '40'], ['4', '30'], ['6', '100']], stop: false, dead: false, once: false });
    book.eq('Scharo preset: the bar says it is filled in, its button is lit', { bar: /Scharo is filled in below\. Check the buy amount and press Start copying\./.test(ed.presetBar || ''), btn: ed.presetButtons }, { bar: true, btn: [{ id: 'scharo', text: 'Scharo', primary: true }] });
    book.eq(`Scharo preset: 7 SOL against a site limit of ${max} SOL shows the warning`, ed.buyHintClass, max < 7 ? 'hint down' : 'hint');
    book.eq('Scharo preset: the cursor waits in "Your buy"', ed.focus, 'f-buy');
    await screenCheck(page, book, 'editor-scharo');
    await ui.closeEditor(page, 'cancel');

    // From inside the editor, over whatever was typed.
    await ui.openNew(page);
    await ui.fillEditor(page, { ...SPEC_A, leaderText: leaders[5], name: 'typed before' });
    await ui.usePreset(page);
    ed = await ui.readEditor(page);
    book.eq('Scharo preset (button inside the editor): replaces everything typed with the preset', ui.editorVsSettings(ed, full), []);
    await ui.hideToast(page);
    await ui.submitEditor(page);
    book.eq('Scharo preset: Start copying says it started', await ui.toast(page), { text: 'Copying started', bad: false });
    await until(async () => !(await ui.editorOpen(page)));
    const st = await ui.state(page);
    const saved = st.copies.find((c) => c.name === 'Scharo');
    const seeded = manifest.copies.find((c) => c.key === 'scharo').settings;
    book.ok('Scharo preset: the saved copy is the preset, field for field', !!saved && JSON.stringify(ui.stripCopy(saved)) === JSON.stringify(seeded), { saved: saved && ui.stripCopy(saved), preset: seeded });
    if (saved) {
      made.scharo = { id: saved.id, settings: seeded, name: 'Scharo' };
      await page.locator(`[data-edit="${saved.id}"]`).waitFor();
      const row = (await ui.readDash(page)).copies.find((c) => c.id === saved.id);
      book.eq('Scharo preset: its line on the dashboard', { meta: row.meta[0], tags: row.tags }, { meta: 'wtb3…ksih · buy 7 SOL when they buy ≥ 1 SOL · fees buy 0.001 + 0.005 tip · sell 0.001 + 0.001 tip SOL · slippage 100%', tags: ['Sell all when they sell all', '40% @ 2s → 30% @ 4s → rest @ 6s · of the bag'] });
      await ui.openEdit(page, saved.id);
      book.eq('Scharo preset: re-opened after saving, every value is unchanged', ui.editorVsSettings(await ui.readEditor(page), seeded), []);
      await ui.closeEditor(page, 'cancel');
    }
  });

  await env.scenario('editor: Save changes, the pause switch, Delete', async () => {
    const a = made['copy A (same %, timed of what is left, two stop levels, dead coin)'];
    const b = made['copy B (sell everything, timed of the original bag, no stop, no dead coin, buy again)'];
    if (!a || !b) throw new Error('the copies this needs were not created');
    // Save changes: every field changed.
    const NEW = { buy: 0.3, min: 1.25, prio: 0.0009, tip: 0.0008, sprio: 0.0007, stip: 0.0006, slip: 44, mirror: { on: true, mode: 'exit' }, timed: { on: true, of: 'bag', rows: [[1, 10], [2, 20], [3, 100]] }, stop: { on: true, rows: [[25, 50]] }, dead: { on: false, idle: 77 }, once: false };
    await ui.openEdit(page, a.id);
    await ui.fillEditor(page, { ...NEW, leaderText: leaders[4], name: 'Alpha 2' });
    await ui.hideToast(page);
    await ui.submitEditor(page);
    book.eq('Save changes says it saved', await ui.toast(page), { text: 'Saved', bad: false });
    await until(async () => !(await ui.editorOpen(page)));
    const want = ui.settingsOf(NEW, leaders[4], 'Alpha 2');
    let st = await ui.state(page);
    let saved = st.copies.find((c) => c.id === a.id);
    book.ok('Save changes: the server holds every changed field (and the copy keeps its id)', !!saved && JSON.stringify(ui.stripCopy(saved)) === JSON.stringify(want), { saved: saved && ui.stripCopy(saved), typed: want });
    await page.locator(`[data-edit="${a.id}"]`).waitFor();
    await sleep(200);
    let row = (await ui.readDash(page)).copies.find((c) => c.id === a.id);
    book.eq('Save changes: the dashboard line follows', { name: row.name, meta: row.meta[0], tags: row.tags }, { name: 'Alpha 2 TEST', meta: `${X.short(leaders[4])} · buy 0.3 SOL when they buy ≥ 1.25 SOL · ${X.feeText(want)} SOL · slippage 44%`, tags: X.sellTags(want.sell) });
    await ui.openEdit(page, a.id);
    book.eq('Save changes: re-opened, every changed value is there', ui.editorVsSettings(await ui.readEditor(page), want), []);
    // Opened and saved again without touching anything: nothing may move.
    await ui.hideToast(page);
    await ui.submitEditor(page);
    await ui.toast(page);
    await until(async () => !(await ui.editorOpen(page)));
    st = await ui.state(page);
    saved = st.copies.find((c) => c.id === a.id);
    book.ok('Save changes with nothing touched changes nothing', JSON.stringify(ui.stripCopy(saved)) === JSON.stringify(want), { saved: ui.stripCopy(saved), before: want });
    a.settings = want; a.name = 'Alpha 2';

    // A wrong wallet in the edit form.
    await ui.openEdit(page, a.id);
    book.allow(400, /^\/api\/copies\/\d+$/);
    await page.locator('#f-leader').fill('');
    await ui.submitEditor(page);
    await page.locator('#form-err .err').waitFor();
    book.eq('Save changes with the wallet box emptied: refused in words', (await ui.readEditor(page)).err, 'enter the wallet address to copy (a Solana wallet address)');
    await ui.closeEditor(page, 'cancel');

    // The pause switch.
    const total = st.copies.length;
    const enabledBefore = st.copies.filter((c) => c.enabled).length;
    await ui.hideToast(page);
    await page.locator(`[data-toggle="${b.id}"] + span`).click();
    book.eq('the pause switch says the copy is paused', await ui.toast(page), { text: 'Beta paused', bad: false });
    st = await ui.state(page);
    book.eq('the pause switch pauses the copy on the server', st.copies.find((c) => c.id === b.id).enabled, false);
    const draws0 = await page.evaluate(() => { window.__marker = document.querySelector('.stats'); return true; });
    await sleep(7000); // two refreshes of the page
    let d = await ui.readDash(page);
    row = d.copies.find((c) => c.id === b.id);
    const focus = await page.evaluate(() => (document.activeElement ? `${document.activeElement.tagName}${document.activeElement.dataset.toggle ? '[data-toggle]' : ''}` : ''));
    const redrawn = await page.evaluate(() => window.__marker !== document.querySelector('.stats'));
    const followed = row.paused && row.switchTitle === 'Resume' && d.stats[3].foot === `0 SOL unrealized · copying ${enabledBefore - 1} of ${total}`;
    book.ok('after pausing, the page follows: the line is dimmed, its switch reads "Resume", the top card counts one copy less', followed, { sevenSecondsAfterTheSwitch: { lineDimmed: row.paused, switchTitle: row.switchTitle, topCard: d.stats[3].foot, shouldBe: `copying ${enabledBefore - 1} of ${total}`, pageRedrawnAtAll: redrawn && draws0, focusIsOn: focus } });
    if (!followed) {
      await page.mouse.click(5, 300); // take the focus off the switch
      await sleep(3600);
      const d2 = await ui.readDash(page);
      const r2 = d2.copies.find((c) => c.id === b.id);
      book.note('after pausing: the page caught up only once something else was clicked', { lineDimmed: r2.paused, topCard: d2.stats[3].foot });
    }
    await ui.hideToast(page);
    await page.locator(`[data-toggle="${b.id}"] + span`).click();
    book.eq('the pause switch, pressed again, says it copies again', await ui.toast(page), { text: 'Copying Beta', bad: false });
    st = await ui.state(page);
    book.eq('the pause switch resumes the copy on the server (its other settings untouched)', ui.stripCopy(st.copies.find((c) => c.id === b.id)), b.settings);
    await page.locator('.topbar .brand').focus().catch(() => undefined);
    await page.mouse.click(5, 300);
    await sleep(3400);

    // Delete.
    await ui.openEdit(page, b.id);
    planDialog(page, { accept: false });
    await page.locator('#delete-copy').click();
    await sleep(300);
    book.eq('Delete asks first, and says open positions keep their rules', page.__lastDialog.message, 'Stop copying Beta? Open positions keep their sell rules until they close.');
    book.ok('Delete answered "Cancel": the copy stays, the editor stays', (await ui.editorOpen(page)) && (await ui.state(page)).copies.some((c) => c.id === b.id));
    planDialog(page, { accept: true });
    await ui.hideToast(page);
    await page.locator('#delete-copy').click();
    book.eq('Delete answered "OK" says it deleted', await ui.toast(page), { text: 'Copy deleted', bad: false });
    await until(async () => !(await ui.editorOpen(page)));
    st = await ui.state(page);
    await sleep(300);
    d = await ui.readDash(page);
    book.ok('Delete: the copy is gone from the server and from the page', !st.copies.some((c) => c.id === b.id) && !d.copies.some((c) => c.id === b.id));
    delete made['copy B (sell everything, timed of the original bag, no stop, no dead coin, buy again)'];
  });

  await env.scenario('editor: several wallet addresses at once', async () => {
    let st = await ui.state(page);
    const before = st.copies.length;
    await ui.openNew(page);
    await ui.fillEditor(page, { ...SPEC_B, leaderText: `${leaders[6]}\n${leaders[7]}, ${leaders[6]}   ${leaders[8]};`, name: 'Trio' });
    await ui.hideToast(page);
    await ui.submitEditor(page);
    book.eq('three addresses (one typed twice; new lines, commas, spaces, a semicolon between them): says three wallets', await ui.toast(page), { text: 'Copying 3 wallets', bad: false });
    await until(async () => !(await ui.editorOpen(page)));
    st = await ui.state(page);
    const trio = st.copies.filter((c) => /^Trio \d$/.test(c.name));
    book.eq('three addresses: one copy each, numbered, the address typed twice only once', trio.map((c) => [c.name, c.leader]), [['Trio 1', leaders[6]], ['Trio 2', leaders[7]], ['Trio 3', leaders[8]]]);
    book.ok('three addresses: each copy has the same settings', trio.every((c) => JSON.stringify(ui.stripCopy(c)) === JSON.stringify(ui.settingsOf(SPEC_B, c.leader, c.name))), trio.map(ui.stripCopy));
    book.eq('three addresses: nothing else was added', st.copies.length, before + 3);

    // One wrong address in the middle.
    await ui.openNew(page);
    book.allow(400, /^\/api\/copies$/);
    await ui.fillEditor(page, { leaderText: `${leaders[9]}\nnot-a-wallet-address\n${leaders[10]}`, name: 'Mix' });
    await ui.submitEditor(page);
    await page.locator('#form-err .err').waitFor();
    let ed = await ui.readEditor(page);
    book.eq('a wrong address among three: says which one and how many were added', ed.err, 'Wallet 2 (not-…ress): enter the wallet address to copy (a Solana wallet address) 1 of 3 were added.');
    await screenCheck(page, book, 'editor-partial-add');
    st = await ui.state(page);
    book.eq('a wrong address among three: the one before it was added, the one after it was not', st.copies.filter((c) => /^Mix/.test(c.name)).map((c) => [c.name, c.leader]), [['Mix 1', leaders[9]]]);
    // The natural next step: correct the typo and press Start copying again.
    await page.locator('#f-leader').fill(`${leaders[9]}\n${leaders[11]}\n${leaders[10]}`);
    await ui.hideToast(page);
    await ui.submitEditor(page);
    await ui.toast(page);
    await until(async () => !(await ui.editorOpen(page)), { timeout: 4000 });
    st = await ui.state(page);
    const mix = st.copies.filter((c) => /^Mix/.test(c.name));
    const dup = mix.filter((c) => c.leader === leaders[9]).length;
    book.ok('after correcting the typo and pressing Start copying again, the wallet that was already added is not added a second time', dup === 1, { copiesOfTheFirstWallet: dup, copies: mix.map((c) => [c.id, c.name, X.short(c.leader)]) });
    if (await ui.editorOpen(page)) await ui.closeEditor(page, 'cancel');
  });

  await env.scenario('editor: odd inputs (empty seconds, markup in a nickname, the same wallet twice, the 20-copy limit)', async () => {
    // A timed step whose seconds box was left empty.
    await ui.openNew(page);
    await page.locator('#f-leader').fill(leaders[5]);
    await page.locator('#f-name').fill('Blank step');
    await ui.setRule(page, 'timed', true);
    await page.locator('[data-preset="100@30"]').click();
    await page.locator('[data-add=timed]').click(); // seconds empty, 100 %
    await ui.hideToast(page);
    book.allow(400, /^\/api\/copies$/);
    const [resp] = await Promise.all([page.waitForResponse((r) => new URL(r.url()).pathname === '/api/copies', { timeout: 4000 }).catch(() => null), ui.submitEditor(page)]);
    await sleep(400);
    let st = await ui.state(page);
    const blank = st.copies.find((c) => c.name === 'Blank step');
    book.ok('a timed step with its seconds left empty is refused (it must not be saved as "sell 100 % after 0 seconds")', !blank, { status: resp && resp.status(), savedTimedSteps: blank && blank.sell.timed, tagsOnDashboard: blank ? (await ui.readDash(page).catch(() => ({ copies: [] }))).copies.filter((c) => c.id === blank.id).map((c) => c.tags) : null });
    if (await ui.editorOpen(page)) {
      const said = (await ui.readEditor(page)).err;
      book.ok('a timed step with its seconds left empty: the refusal names the step and what is missing', /timed sell 2/.test(said) && /second/i.test(said), said);
      // The same for an empty stop-loss box and an empty percent.
      await ui.setRule(page, 'timed', false);
      await ui.setRule(page, 'stop', true);
      await page.locator('[data-add=stop]').click();
      await ui.submitEditor(page);
      await sleep(500);
      const saidStop = (await ui.readEditor(page)).err;
      book.ok('a stop-loss level with its loss box left empty is refused in words', /stop loss 2/.test(saidStop), saidStop);
      await ui.closeEditor(page, 'cancel');
    }

    // Markup in a nickname must show as text.
    const evil = '<img src=x onerror=alert(1)>';
    await ui.openNew(page);
    await ui.fillEditor(page, { leaderText: leaders[2], name: evil });
    await ui.hideToast(page);
    await ui.submitEditor(page);
    await ui.toast(page);
    await until(async () => !(await ui.editorOpen(page)));
    st = await ui.state(page);
    const x = st.copies.find((c) => c.name === evil);
    await page.locator(`[data-edit="${x.id}"]`).waitFor();
    const row = (await ui.readDash(page)).copies.find((c) => c.id === x.id);
    book.ok('a nickname with markup in it is shown as text on the dashboard, nothing runs', row.name === `${evil} TEST` && !/<img/i.test(row.nameHtml) && (await page.locator('#app img').count()) === 0, { name: row.name, html: row.nameHtml });
    await ui.openEdit(page, x.id);
    book.eq('a nickname with markup: the editor title and box show it as text', { title: (await ui.readEditor(page)).title, name: (await ui.readEditor(page)).name, imgs: await page.locator('#modal img').count() }, { title: `Edit ${evil}`, name: evil, imgs: 0 });
    await ui.closeEditor(page, 'cancel');

    // The same wallet a second time: is anything said?
    const sameBefore = st.copies.filter((c) => c.leader === preset.settings.leader).length;
    await ui.openPreset(page);
    await ui.hideToast(page);
    await ui.submitEditor(page);
    const t = await ui.toast(page);
    await until(async () => !(await ui.editorOpen(page)), { timeout: 3000 });
    st = await ui.state(page);
    const sameAfter = st.copies.filter((c) => c.leader === preset.settings.leader).length;
    book.note('the Scharo preset saved a second time', { toast: t, copiesOfThatWalletBefore: sameBefore, after: sameAfter });
    book.ok('a second copy of a wallet already being copied is refused or at least warned about', sameAfter === sameBefore || (t && t.bad), { toast: t, copiesOfThatWalletBefore: sameBefore, after: sameAfter });
    if (await ui.editorOpen(page)) await ui.closeEditor(page, 'cancel');

    // Twenty copies per account.
    st = await ui.state(page);
    const room = 20 - st.copies.length;
    const fresh = manifest.fillers.slice(0, room + 2);
    await ui.openNew(page);
    book.allow(409, /^\/api\/copies$/);
    await ui.fillEditor(page, { leaderText: fresh.join('\n'), name: 'Fill' });
    await ui.submitEditor(page);
    await page.locator('#form-err .err').waitFor({ timeout: 15000 });
    const ed = await ui.readEditor(page);
    book.eq('the 21st copy is refused: says which wallet and how many were added', ed.err, `Wallet ${room + 1} (${X.short(fresh[room])}): at most 20 copies per account ${room} of ${room + 2} were added.`);
    book.eq('twenty copies is the most an account holds', (await ui.state(page)).copies.length, 20);
    await ui.closeEditor(page, 'cancel');
    await sleep(300);
    await screenCheck(page, book, 'user-dashboard-20-copies');
  });

  return { ...S, made };
}

module.exports = { freshUser, MIRROR_HINT, TIMED_HINT, OF };
