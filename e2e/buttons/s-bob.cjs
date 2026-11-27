'use strict';
// A user who has only ever traded in test mode, with more closed positions (205) than History lists (200), and a
// copy saved by the site's first version.
const { planDialog, screenCheck, shown, matches, solNum, solStr, sleep, until } = require('./lib.cjs');
const ui = require('./ui.cjs');
const X = require('./expected.cjs');
const { checkDashboard, checkHistory } = require('./s-alice.cjs');

async function bob(env) {
  const { book, manifest } = env;
  const S = await env.open('bob', env.ip(3));
  const { page } = S;

  await env.scenario('bob: test-only account, Dashboard numbers', async () => {
    await ui.login(page, manifest.keys.bob.key);
    await sleep(400);
    const { d } = await checkDashboard(env, page, 'bob');
    book.ok("bob's dashboard: nothing open, and it says so", /Nothing open/.test(d.positionsEmpty || ''), d.positionsEmpty);
    await screenCheck(page, book, 'bob-dashboard');
  }, { always: true });

  await env.scenario('bob: History with 205 closed positions', async () => {
    const st = await ui.state(page);
    await ui.openTab(page, 'history');
    await sleep(300);
    const { E, h } = await checkHistory(env, page, 'bob');
    await screenCheck(page, book, 'bob-history', { ignoreInside: [/table-wrap/] });
    // The same account, two pages, one question: how much did all closed trades make?
    const m = /^Closed positions\s*(\d+)(?: test)? · total ([+−]?[\d.]+) SOL/.exec(h.closedHead) || [];
    const dayTrades = h.days.reduce((a, r) => a + Number(r[r.length - 3].text), 0);
    const daySum = h.days.reduce((a, r) => a + shown(r[r.length - 1].text), 0);
    book.ok('bob: History\'s heading, its own day table and the Dashboard agree on how many trades closed and what they made', Number(m[1]) === dayTrades && Math.abs(shown(m[2]) - st.pnl.test.allSol) < 0.0002,
      { historyHeading: h.closedHead, dayTableTrades: dayTrades, dayTableProfitSum: Number(daySum.toFixed(4)), dashboardAllTime: st.pnl.test.allSol, dashboardTrades: st.pnl.test.trades, seededTrades: E.modes.test.trades, seededProfit: solStr(E.modes.test.all) });
    book.ok('bob: when more positions closed than the table lists, the page says the list is cut', h.closed.length >= E.closed.length || /newest|latest|last 200|of 205|more/i.test(h.closedHead), { rowsListed: h.closed.length, closedInAll: E.closed.length, heading: h.closedHead });
    // The heading covers every closed position, not only the 200 rows listed under it (finding B2): all 205 of them,
    // their total, their winners and the platform fees they carried; they are test ones and it says so, and it says
    // the list holds the latest 200 of the 205 (second review).
    const all = E.modes.test;
    const hm = /^Closed positions\s*(\d+) test · total ([+−]?[\d.]+) SOL · (\d+)% winners(?: · platform fees ([\d.]+) SOL)? · the latest 200 of (\d+) are listed$/.exec(h.closedHead) || [];
    book.ok('bob: the History heading adds up all 205 closed positions, not only the 200 listed (count, total, winners %, platform fees), calls them test, and says the list holds the latest 200 of 205', hm[1] === String(all.trades) && matches(hm[2], solNum(all.all)) && hm[3] === String(Math.round((all.wins / all.trades) * 100)) && matches(hm[4], solNum(all.fees)) && hm[5] === String(all.trades), { shown: h.closedHead, closedInAll: all.trades, total: solStr(all.all), winners: `${Math.round((all.wins / all.trades) * 100)}%`, fees: solStr(all.fees) });
    await ui.openTab(page, 'dash');
  });

  await env.scenario('bob: a copy saved by the first version of the site (no tip, no sell fees, no "% of")', async () => {
    const legacy = manifest.copies.find((c) => c.key === 'bobLegacy');
    const d = await ui.readDash(page);
    const row = d.copies.find((c) => c.id === legacy.id);
    book.eq('old-format copy: its line on the dashboard has no blanks', [row.name, row.meta[0], row.tags], ['Legacy TEST', `${X.short(legacy.settings.leader)} · buy 0.05 SOL when they buy ≥ 0.5 SOL · fees 0.0005 SOL · slippage 25%`, ['Sell when they sell', '50% @ 10s', 'Stop −40% → 100%']]);
    await ui.openEdit(page, legacy.id);
    const ed = await ui.readEditor(page);
    book.eq('old-format copy: the editor fills the missing boxes sensibly (tip 0, sell fees as the buy fees, "% of what\'s left", "same %")', ui.editorVsSettings(ed, legacy.settings), []);
    await ui.closeEditor(page, 'cancel');
    await ui.hideToast(page);
    await page.locator(`[data-toggle="${legacy.id}"] + span`).click();
    const t = await ui.toast(page);
    const st = await ui.state(page);
    const now = st.copies.find((c) => c.id === legacy.id);
    book.ok('old-format copy: the pause switch works on it', !!t && t.text === 'Legacy paused' && now.enabled === false && now.sell.timed.length === 1 && now.sell.stopLoss.length === 1 && now.buySol === 0.05, { toast: t, now });
    await page.mouse.click(5, 300);
    await sleep(3300);
    // The switch when the server says no: it must flip back and say why.
    const main = manifest.copies.find((c) => c.key === 'bobMain');
    await page.route('**/api/copies/*', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'the server said no (staged by the suite)' }) }) : route.continue()));
    book.staged = true;
    try {
      await ui.hideToast(page);
      await page.locator(`[data-toggle="${main.id}"] + span`).click();
      const t2 = await ui.toast(page);
      const checked = await page.locator(`[data-toggle="${main.id}"]`).isChecked();
      book.ok('the pause switch, when the server refuses: it says why and flips back', !!t2 && t2.bad && t2.text === 'the server said no (staged by the suite)' && checked === true && (await ui.state(page)).copies.find((c) => c.id === main.id).enabled === true, { toast: t2, switchShows: checked });
    } finally {
      await page.unroute('**/api/copies/*').catch(() => undefined);
      book.staged = false;
      await page.mouse.click(5, 300);
    }
  });

  await env.scenario('bob: no position open, so the wallet can be removed and another imported', async () => {
    planDialog(page, { accept: true });
    await ui.hideToast(page);
    await page.locator('#remove-wallet').click();
    book.eq('Remove wallet with nothing open: removed', await ui.toast(page), { text: 'Wallet removed', bad: false });
    await page.locator('#wallet-form').waitFor();
    await page.locator('#wk').fill(manifest.imports.base58b.secret);
    await ui.hideToast(page);
    await page.locator('#wallet-form button[type=submit]').click();
    book.eq('another wallet imported in its place', await ui.toast(page), { text: 'Wallet imported', bad: false });
    await page.locator('.sol-big').waitFor();
    book.eq('the new wallet is the one shown', (await ui.readDash(page)).wallet.addr, manifest.imports.base58b.pubkey);
    manifest.users.bob.wallet = manifest.imports.base58b.pubkey;
  });

  // What the pages do with a balance the server could read (the answer is edited on its way to the page: offline
  // the server has none to give).
  await env.scenario('bob: how a wallet balance is printed (the server\'s answer edited on its way to the page)', async () => {
    let sol = 6.123456789;
    let live = false;
    await page.route('**/api/state*', async (route) => {
      const resp = await route.fetch();
      let json = null;
      try { json = await resp.json(); } catch { json = null; }
      if (!json || !json.server) return route.fulfill({ response: resp });
      if (json.wallet) json.wallet.sol = sol;
      if (live) { json.server.live = true; json.server.mode = 'live'; }
      await route.fulfill({ response: resp, json });
    });
    await page.mouse.click(5, 300);
    await sleep(3500);
    let d = await ui.readDash(page);
    book.eq('a balance of 6.123456789 SOL: 3 decimals on the top card, 4 on the wallet card', [d.stats[0].value, d.wallet.sol], ['6.123 SOL', '6.1235 SOL']);
    book.ok('a wallet holding more than 5 SOL gets the "keep only what you trade with" warning', d.wallet.notes.some((n) => /holds more than 5 SOL/.test(n)), d.wallet.notes);
    sol = 0.75;
    await sleep(3500);
    d = await ui.readDash(page);
    book.ok('a wallet holding 0.75 SOL: printed as is, no warning', d.stats[0].value === '0.75 SOL' && d.wallet.sol === '0.75 SOL' && d.wallet.notes.length === 0, { card: d.stats[0].value, wallet: d.wallet.sol, notes: d.wallet.notes });
    sol = 123.456789;
    await sleep(3500);
    d = await ui.readDash(page);
    book.eq('from 100 SOL up amounts are printed with 2 decimals', [d.stats[0].value, d.wallet.sol], ['123.46 SOL', '123.46 SOL']);
    await screenCheck(page, book, 'bob-wallet-balance');

    // And what a LIVE site looks like to a user (the server stays offline; only the page is told "live").
    live = true;
    await sleep(3500);
    d = await ui.readDash(page);
    book.ok('told the site is live: the top bar says LIVE and every copy is marked LIVE', d.top.pills[0].text === 'LIVE' && d.copies.every((c) => c.pill === 'LIVE'), { top: d.top.pills, copies: d.copies.map((c) => c.pill) });
    await ui.openNew(page);
    const ed = await ui.readEditor(page);
    book.eq('told the site is live: the editor warns that this copy trades real SOL', ed.modeHint, 'The site is live: this copy trades with real SOL from your wallet.');
    await page.locator('#f-leader').fill(manifest.imports.leaders[0]);
    await page.locator('#f-buy').fill('0.02');
    const posts = () => page.__api.filter((c) => c.method === 'POST' && /\/api\/copies$/.test(c.url)).length;
    const n0 = posts();
    planDialog(page, { accept: false });
    await ui.submitEditor(page);
    await sleep(500);
    book.ok('told the site is live: Start copying asks "this buys 0.02 SOL with your real wallet … Continue?"; "Cancel" sends nothing', page.__lastDialog.message === 'The site is live: this buys 0.02 SOL with your real wallet every time this wallet buys. Continue?' && posts() === n0 && (await ui.editorOpen(page)), page.__lastDialog);
    await ui.closeEditor(page, 'cancel');
    await page.unroute('**/api/state*');
    await sleep(3400);
    d = await ui.readDash(page);
    book.eq('back to the server\'s own answer: OFFLINE again', d.top.pills[0].text, 'OFFLINE');
  });
  await page.unroute('**/api/state*').catch(() => undefined);

  return S;
}

module.exports = { bob };
