'use strict';
// The owner's page while the owner is typing, tabbing or tapping (third review). What a redraw must never do: wipe a
// half-typed number or send it as 0, drop the keyboard's place, stop redrawing after a word typed with an input method,
// leave an old note after a new login, forget what was typed while Status was looked at, or let a tap act on a row the
// redraw moved under the finger. Each check failed on the page before its fix.
//
// The page runs on a clock the suite moves (Playwright's): its 5 s refresh is fired at once instead of waited for.
const { planDialog, apiCalls, sleep, until } = require('./lib.cjs');
const ui = require('./ui.cjs');

const HEADERS = { 'content-type': 'application/json', 'x-requested-with': 'motionlarp' };

async function adminTyping(env) {
  const { book, vp } = env;
  const S = await env.open('owner-typing', env.ip(90));
  const P = S.page;
  const clock = S.context.clock;
  await clock.install();

  /** The page's own 5 s refresh, now; then whether its answer was drawn (false: the redraw waits, or never came). */
  const refresh = async ({ wait = 6000 } = {}) => {
    await P.evaluate(() => { window.__drawnBefore = document.querySelector('#app > main, #app > .auth'); });
    const answered = P.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/state' && r.request().method() === 'GET', { timeout: 8000 }).catch(() => null);
    await clock.fastForward(5100);
    await answered;
    return !!(await until(() => P.evaluate(() => !document.contains(window.__drawnBefore)), { timeout: wait, every: 50 }));
  };
  const server = () => ui.adminState(P);
  const badInput = (sel) => P.evaluate((s) => document.querySelector(s).validity.badInput, sel);
  /** Types into a number box from the keyboard (Playwright's fill() refuses text a number box cannot read). */
  const typeInto = async (sel, text, { replace = true } = {}) => {
    await P.locator(sel).focus();
    if (replace) { await P.keyboard.press('Control+A'); await P.keyboard.press('Backspace'); }
    await P.keyboard.type(text);
  };
  const api = (method, path, body) => P.evaluate(async ([m, p, b, h]) => { const r = await fetch(p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, [method, path, body, HEADERS]);
  const deleteKey = async (label) => { const l = (await server()).licenses.find((x) => x.label === label); if (l && l.status === 'unused') await api('DELETE', `/api/admin/licenses/${l.id}`); };
  /** Back to a clean page: nothing typed, the latest figures. */
  const fresh = async () => { await P.reload(); await P.locator('.topbar').waitFor(); await sleep(200); };
  const loginThroughTheForm = async () => {
    await P.locator('#admin-login').waitFor({ timeout: 8000 });
    await P.locator('#ap').fill(env.adminPassword);
    await P.locator('#admin-login button[type=submit]').click();
    await P.locator('.topbar').waitFor();
    await sleep(200);
  };

  await env.scenario('admin while typing: the owner\'s page on the suite\'s clock', async () => {
    await ui.adminLogin(P, env.adminPassword);
    await sleep(300);
    book.ok('owner page on a moved clock: its 5 s refresh draws the page again at once', await refresh());
  }, { always: true });

  // ── C1: a number box holding text it cannot read ("1e", "-", "."), or a half-typed "0." ──
  await env.scenario('admin while typing: a half-typed number is never wiped by a redraw, nor sent as 0', async () => {
    await fresh();
    const st0 = (await server()).settings;
    const settingsSent = () => apiCalls(P, /^\/api\/admin\/settings$/).length;
    // "1e" in the Fee box, the cursor in another box.
    await typeInto('#set-fee', '1e');
    const typed = await badInput('#set-fee');
    await P.locator('#set-wallet').click();
    await refresh();
    const kept = await badInput('#set-fee');
    let n0 = settingsSent();
    await P.locator('#settings button[type=submit]').click();
    await sleep(600);
    let st = (await server()).settings;
    book.ok('Fee "1e", the cursor elsewhere: a redraw keeps the unreadable text, and Save sends nothing (the fee stays)', typed && kept && settingsSent() === n0 && st.feePercent === st0.feePercent,
      { badInputBeforeTheRedraw: typed, afterIt: kept, settingsSent: settingsSent() - n0, feeBefore: st0.feePercent, feeAfter: st.feePercent });
    // The same with the cursor in the box.
    await typeInto('#set-fee', '1e');
    await refresh();
    const keptFocused = await badInput('#set-fee');
    n0 = settingsSent();
    await P.locator('#settings button[type=submit]').click();
    await sleep(600);
    st = (await server()).settings;
    book.ok('Fee "1e", the cursor in it: a redraw keeps the unreadable text, and Save sends nothing (the fee stays)', keptFocused && settingsSent() === n0 && st.feePercent === st0.feePercent,
      { badInputAfterTheRedraw: keptFocused, settingsSent: settingsSent() - n0, feeAfter: st.feePercent });
    // An empty Fee box.
    await typeInto('#set-fee', '');
    n0 = settingsSent();
    await P.locator('#settings button[type=submit]').click();
    await sleep(600);
    st = (await server()).settings;
    book.ok('Fee left empty: Save sends nothing (it sent 0, and every user\'s fee became 0 %)', settingsSent() === n0 && st.feePercent === st0.feePercent, { settingsSent: settingsSent() - n0, feeAfter: st.feePercent });
    await fresh();

    // "0." then a redraw, then "5": 0.5 (it became "05", and Save sent 5).
    for (const sel of ['#set-max', '#set-fee', '#lic-fee']) {
      await typeInto(sel, '0.');
      const drawn = await refresh();
      await P.keyboard.type('5');
      const v = await P.locator(sel).inputValue();
      book.ok(`${sel}: "0." typed, the page drawn again, then "5": the box holds 0.5`, drawn && v === '0.5', { redrawn: drawn, box: v });
      await fresh();
    }

    // "Their fee" holding "-" while the name is typed: Create key must not quietly give the key the default fee.
    const keysSent = () => apiCalls(P, /^\/api\/admin\/licenses$/).length;
    await P.locator('#lic-label').fill('Typing Tom');
    await typeInto('#lic-fee', '-');
    await P.locator('#lic-label').click();
    await refresh();
    const licKept = await badInput('#lic-fee');
    n0 = keysSent();
    await P.locator('#new-license button[type=submit]').click();
    await sleep(600);
    const made = (await server()).licenses.find((l) => l.label === 'Typing Tom');
    book.ok('"Their fee" holding "-", the cursor back in the name: a redraw keeps it, and Create key makes no key (it made one with the default fee)', licKept && keysSent() === n0 && !made,
      { badInputAfterTheRedraw: licKept, keysSent: keysSent() - n0, keyMade: made ? { label: made.label, feePercent: made.feePercent } : null });
    if (made) await deleteKey('Typing Tom');
    await fresh();
  });

  // ── C5: the keyboard's place on the two submit buttons ──
  await env.scenario('admin while typing: the keyboard stays on Create key and Save settings through a redraw', async () => {
    await fresh();
    await P.locator('#lic-label').fill('Keyboard Kim');
    await P.locator('#lic-label').focus();
    await P.keyboard.press('Tab');
    await P.keyboard.press('Tab');
    const on = await P.evaluate(() => document.activeElement.textContent);
    await refresh();
    const after = await P.evaluate(() => (document.activeElement === document.body ? 'BODY' : document.activeElement.textContent));
    let n0 = apiCalls(P, /^\/api\/admin\/licenses$/).length;
    await P.keyboard.press('Enter');
    const sent = await until(() => apiCalls(P, /^\/api\/admin\/licenses$/).length > n0, { timeout: 3000 });
    book.ok('Tab, Tab to "Create key", a redraw, Enter: the key is made (the keyboard\'s place went to the top of the page and Enter did nothing)', on === 'Create key' && after === 'Create key' && !!sent, { focusBefore: on, focusAfterTheRedraw: after, keySent: !!sent });
    await until(async () => !!(await server()).licenses.find((l) => l.label === 'Keyboard Kim'), { timeout: 3000 });
    await deleteKey('Keyboard Kim');
    await fresh();

    const max0 = (await server()).settings.maxSolPerBuy;
    await P.locator('#set-max').fill(String(max0 === 4 ? 3 : 4));
    await P.locator('#settings button[type=submit]').focus();
    const on2 = await P.evaluate(() => document.activeElement.textContent);
    await refresh();
    const after2 = await P.evaluate(() => (document.activeElement === document.body ? 'BODY' : document.activeElement.textContent));
    n0 = apiCalls(P, /^\/api\/admin\/settings$/).length;
    await P.keyboard.press('Enter');
    const sent2 = await until(() => apiCalls(P, /^\/api\/admin\/settings$/).length > n0, { timeout: 3000 });
    book.ok('the keyboard on "Save settings", a redraw, Enter: the settings are saved', on2 === 'Save settings' && after2 === 'Save settings' && !!sent2, { focusBefore: on2, focusAfterTheRedraw: after2, saved: !!sent2 });
    await sleep(500);
    if ((await server()).settings.maxSolPerBuy !== max0) {
      await fresh();
      await P.locator('#set-max').fill(String(max0));
      await P.locator('#settings button[type=submit]').click();
      await until(async () => (await server()).settings.maxSolPerBuy === max0, { timeout: 4000 });
    }
    await fresh();
  });

  // ── C4: a word typed with an input method (Chinese, Japanese, Korean; an Android keyboard) ──
  await env.scenario('admin while typing: after a word of an input method was cut off, the page still redraws', async () => {
    await fresh();
    const cdp = await S.context.newCDPSession(P);
    // A redraw that does not wait (after Create key) lands while a word is being composed in "Paid to wallet".
    await P.locator('#lic-label').fill('Input method');
    let release;
    const held = new Promise((r) => { release = r; });
    await P.route((u) => u.pathname === '/api/admin/licenses', async (route) => { await held; await route.continue(); });
    await P.locator('#new-license button[type=submit]').click();
    await P.locator('#set-wallet').click();
    await P.keyboard.press('End');
    await cdp.send('Input.imeSetComposition', { text: 'かな', selectionStart: 2, selectionEnd: 2 });
    release();
    await until(() => P.evaluate(() => !!document.querySelector('.ok-note')), { timeout: 6000 });
    await P.unroute((u) => u.pathname === '/api/admin/licenses');
    await sleep(200);
    const drew = await refresh({ wait: 3000 });
    book.ok('a redraw after Create key moved "Paid to wallet" mid-word: the 5 s refresh still draws the page (it stopped for good, with no sign)', drew);
    await deleteKey('Input method');
    await fresh();

    // The session ends while a word is being composed; the owner logs in again through the form.
    await P.locator('#set-wallet').click();
    await P.keyboard.press('End');
    await cdp.send('Input.imeSetComposition', { text: 'かな', selectionStart: 2, selectionEnd: 2 });
    await api('POST', '/api/admin/logout');
    await refresh();
    await loginThroughTheForm();
    const drew2 = await refresh({ wait: 3000 });
    book.ok('the session ended while a word was being composed, then a login through the form: the 5 s refresh draws the page', drew2);
    await cdp.detach().catch(() => undefined);
    await fresh();
  });

  // ── C7: the Settings note after the session ends ──
  await env.scenario('admin while typing: after a new login the Settings card shows no old note', async () => {
    await fresh();
    const wallet0 = (await server()).settings.feeWallet;
    book.allow(400, /^\/api\/admin\/settings$/);
    await P.locator('#set-wallet').fill('not-a-wallet');
    await P.locator('#settings button[type=submit]').click();
    await until(() => P.evaluate(() => document.querySelector('#settings-msg').className === 'down'), { timeout: 5000 });
    const refused = (await ui.readAdmin(P)).settings.msg;
    await api('POST', '/api/admin/logout');
    await refresh();
    await loginThroughTheForm();
    let a = await ui.readAdmin(P);
    book.ok('a refused Save, the session ends, a login through the form: the refusal is gone, the saved wallet shown', refused === 'the fee wallet must be a Solana wallet address' && a.settings.msg === '' && a.settings.wallet === wallet0, { refusedWith: refused, noteAfterTheLogin: a.settings.msg, wallet: a.settings.wallet });

    // A Save whose "admin login needed" comes back after the password form is already on the screen.
    book.allow(401, /^\/api\/admin\/settings$/);
    await P.locator('#set-max').fill('3');
    let release;
    const held = new Promise((r) => { release = r; });
    await P.route((u) => u.pathname === '/api/admin/settings', async (route) => { await held; await route.continue(); });
    await P.locator('#settings button[type=submit]').click();
    await sleep(200);
    await api('POST', '/api/admin/logout');
    await refresh();
    await P.locator('#admin-login').waitFor({ timeout: 6000 });
    const answered = P.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/settings', { timeout: 6000 }).catch(() => null);
    release();
    await answered;
    await sleep(200);
    await P.unroute((u) => u.pathname === '/api/admin/settings');
    await loginThroughTheForm();
    a = await ui.readAdmin(P);
    book.ok('a Save answered "admin login needed" after the password form came up, then a login: no old note', a.settings.msg === '', { noteAfterTheLogin: a.settings.msg });
    await fresh();
  });

  // ── C8: the Status tab and back ──
  await env.scenario('admin while typing: what was typed is still there after a look at Status', async () => {
    await fresh();
    await P.locator('#lic-label').fill('Ann');
    await P.locator('#set-max').fill('2');
    await typeInto('#set-fee', '1e');
    planDialog(P, { accept: true });
    await P.locator('#set-live + span').click();
    await sleep(200);
    await P.locator('.topbar .nav [data-tab=connections]').click();
    await until(() => P.evaluate(() => { const b = document.querySelector('#conn-check'); return !!b && b.textContent === 'Check again'; }), { timeout: 12_000 });
    await P.locator('.topbar .nav [data-tab=admin]').click();
    await P.locator('#lic-label').waitFor();
    const back = await P.evaluate(() => ({ name: document.querySelector('#lic-label').value, max: document.querySelector('#set-max').value, feeUnreadable: document.querySelector('#set-fee').validity.badInput, live: document.querySelector('#set-live').checked, liveText: document.querySelector('#live-text').textContent }));
    book.eq('typed, then Status, then Admin: the name, Max per buy, the unreadable Fee and the live switch are as they were left', back, { name: 'Ann', max: '2', feeUnreadable: true, live: true, liveText: 'Live trading will be ON after saving' });
    await fresh();
  });

  // ── C6: a tap while a redraw that moves the rows waits ──
  await env.scenario('admin while typing: a tap acts on the row tapped, and the dialog names it', async () => {
    await fresh();
    const touch = !!vp.mobile;
    const cdp = touch ? await S.context.newCDPSession(P) : null;
    const trials = touch ? 4 : 1;
    const results = [];
    for (let i = 1; i <= trials; i++) {
      const target = `Target ${i}`;
      const other = `Made in another tab ${i}`;
      await api('POST', '/api/admin/licenses', { label: target });
      await refresh();
      // Its Revoke on the screen (on a phone the table scrolls sideways), and the page as the finger will find it.
      await P.evaluate((t) => { const tr = [...document.querySelectorAll('tbody tr')].find((x) => x.querySelector('td b')?.textContent === t); tr.querySelector('[data-revoke]').scrollIntoView({ block: 'center', inline: 'center' }); }, target);
      await refresh();
      const at = await P.evaluate((t) => { const tr = [...document.querySelectorAll('tbody tr')].find((x) => x.querySelector('td b')?.textContent === t); const r = tr.querySelector('[data-revoke]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }, target);
      await P.evaluate(() => {
        window.__tap = [];
        if (window.__tapWatched) return;
        window.__tapWatched = true;
        const row = (el) => { const b = el && el.closest ? el.closest('button') : null; const tr = b && b.closest('tr'); return tr ? `[${b.textContent.trim()}] ${tr.querySelector('td b').textContent}` : el ? el.tagName : '?'; };
        for (const t of ['pointerup', 'click']) document.addEventListener(t, (e) => window.__tap.push([t, performance.now(), row(e.target)]), { capture: true, passive: true });
        new MutationObserver(() => window.__tap.push(['redraw', performance.now()])).observe(document.querySelector('#app'), { childList: true });
      });
      // The next refresh is held until the finger is down and a key has been made meanwhile (it goes on top).
      let hold;
      const holding = new Promise((r) => { hold = r; });
      let route = null;
      await P.route((u) => u.pathname === '/api/admin/state', async (r) => { if (route === null && r.request().method() === 'GET') { route = r; hold(); return; } return r.continue(); });
      await clock.fastForward(5100);
      await holding;
      if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
      else { await P.mouse.move(at.x, at.y); await P.mouse.down(); }
      await api('POST', '/api/admin/licenses', { label: other });
      const req = route.request();
      await route.continue();
      const resp = await req.response();
      if (resp) await resp.finished();
      await sleep(40);
      planDialog(P, { accept: false });
      const d0 = book.dialogs.length;
      if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      else await P.mouse.up();
      await until(() => book.dialogs.length > d0, { timeout: 3000 });
      await sleep(300);
      await P.unroute((u) => u.pathname === '/api/admin/state');
      const log = await P.evaluate(() => window.__tap);
      const up = log.find((l) => l[0] === 'pointerup');
      const click = log.find((l) => l[0] === 'click');
      const dialog = book.dialogs.slice(d0)[0];
      results.push({ tapped: `[Revoke] ${target}`, clickReached: click ? click[2] : 'no click', redrawBetweenLiftAndClick: !!(up && click && log.some((l) => l[0] === 'redraw' && l[1] > up[1] && l[1] < click[1])), dialog: dialog ? dialog.message : null });
      await deleteKey(target);
      await deleteKey(other);
      P.__dialogPlan = []; // a try whose click made no dialog leaves its plan behind
    }
    const want = (t) => `Revoke the key for ${t}? Its user is locked out and gets no new copies; open positions still sell by their rules.`;
    book.ok(`${touch ? 'a tap' : 'a press'} on Revoke while a redraw that moves the rows waits: the click acts on the row pressed, and the dialog names it (${results.length} ${results.length > 1 ? 'tries' : 'try'})`,
      results.every((r, i) => r.clickReached === `[Revoke] Target ${i + 1}` && !r.redrawBetweenLiftAndClick && r.dialog === want(`Target ${i + 1}`)), results);
    if (cdp) await cdp.detach().catch(() => undefined);
    await fresh();
  });

  await S.context.close();
}

module.exports = { adminTyping };
