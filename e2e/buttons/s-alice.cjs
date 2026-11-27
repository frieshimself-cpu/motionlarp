'use strict';
// A user with a full record (Alice): every number on the Dashboard and in History against the seeded fills,
// then the controls that need positions: Sell now, the blocked wallet removal, deleting a copy that holds a coin.
const { planDialog, apiCalls, screenCheck, shown, signOf, matches, solNum, solStr, agoMatches, sleep, until } = require('./lib.cjs');
const ui = require('./ui.cjs');
const X = require('./expected.cjs');

const signWord = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

/** One printed amount against the exact lamports: the number, its sign, and (when asked) its colour. */
function amount(text, lamports, d, colour) {
  const exact = solNum(lamports);
  const okNum = matches(text, exact, d);
  const n = shown(text);
  const okSign = n === 0 ? true : signOf(text) === signWord(exact) || (exact < 0 && signOf(text) === '-');
  return okNum && okSign && (colour === undefined || colour === cls(n === 0 ? 0 : exact));
}

async function checkDashboard(env, page, who, opts = {}) {
  const { book, manifest } = env;
  const timeZone = opts.timeZone || 'UTC';
  const now = Date.now();
  const E = X.forUser(manifest, who, { timeZone, now });
  const C = X.forCopies(manifest, who);
  const U = manifest.users[who];
  const d = await ui.readDash(page);
  const P = `${who}'s dashboard`;
  const main = E.modes[E.primary];
  const otherName = E.primary === 'live' ? 'test' : 'live';
  const other = E.modes[otherName];
  const tag = E.primary === 'test' ? ' test' : '';

  book.eq(`${P}: fee pill`, d.top.pills.map((p) => p.text), ['OFFLINE', ...(U.feeBps ? [`Fee ${U.feeBps / 100}%`] : [])]);

  // ── the four cards ──
  const [c0, c1, c2, c3] = d.stats;
  book.eq(`${P}: card 1 names the wallet`, [c0.label, c0.foot], ['Wallet balance', X.short(U.wallet)]);
  book.eq(`${P}: card 2 is "Profit today"${tag ? ' marked test (no real trades yet)' : ' (real trades)'}`, c1.label, `Profit today${tag}`);
  book.ok(`${P}: Profit today = SOL returned − SOL spent of the positions closed today (${E.primary}), 3 decimals, signed and coloured`, amount(c1.value, main.today, 3, c1.valueClass), { shown: c1.value, colour: c1.valueClass, exact: solStr(main.today) });
  const f1 = /^last 7 days ([+−]?[\d.]+)(?: · (test|live): ([+−]?[\d.]+))?$/.exec(c1.foot) || [];
  book.ok(`${P}: "last 7 days" = today and the six days before (${E.primary})`, amount(f1[1], main.week, 3), { shown: c1.foot, exact: solStr(main.week) });
  if (other.trades) book.ok(`${P}: the other kind (${otherName}) is shown apart for today`, f1[2] === otherName && amount(f1[3], other.today, 3), { shown: c1.foot, exact: solStr(other.today) });
  else book.ok(`${P}: no "${otherName}" note when there are no ${otherName} trades`, f1[2] === undefined, c1.foot);
  book.eq(`${P}: card 3 is "Profit all time"`, c2.label, `Profit all time${tag}`);
  book.ok(`${P}: Profit all time (${E.primary})`, amount(c2.value, main.all, 3, c2.valueClass), { shown: c2.value, colour: c2.valueClass, exact: solStr(main.all) });
  const winRate = main.trades ? `${Math.round((main.wins / main.trades) * 100)}% winners` : 'no closed trades yet';
  const f2 = /^(\d+) trades · (.+?)(?: · (test|live): ([+−]?[\d.]+))?$/.exec(c2.foot) || [];
  book.eq(`${P}: trades and winners of the ${E.primary} trades only`, [f2[1], f2[2]], [String(main.trades), winRate]);
  if (other.trades) book.ok(`${P}: the other kind (${otherName}) all time, apart`, f2[3] === otherName && amount(f2[4], other.all, 3), { shown: c2.foot, exact: solStr(other.all) });
  const enabled = Object.values(C).filter((c) => c.settings.enabled).length;
  // "<real> SOL unrealized · test: <test> · copying N of M" (the test part only when both kinds are open; with test
  // positions alone the card is marked test, as the profit cards are).
  const f3 = /^([+−]?[\d.]+) SOL unrealized(?: · test: ([+−]?[\d.]+))? · copying (\d+) of (\d+)$/.exec(c3.foot) || [];
  const anyLive = E.open.some((p) => p.mode === 'live');
  const anyTest = E.open.some((p) => p.mode === 'test');
  book.eq(`${P}: card 4 counts open positions and copies`, [c3.label, c3.value, f3[3], f3[4]], [`Open positions${anyTest && !anyLive ? ' test' : ''}`, String(E.open.length), String(opts.enabled ?? enabled), String(opts.copies ?? Object.keys(C).length)]);
  const openLive = sum(E.open.filter((p) => p.mode === 'live').map((p) => p.pnl));
  const openTest = sum(E.open.filter((p) => p.mode === 'test').map((p) => p.pnl));
  if (anyLive && anyTest) {
    book.ok(`${P}: the P/L of open positions keeps real and test apart (it is real money only, or two numbers)`, amount(f3[1], openLive, 4) && amount(f3[2], openTest, 4), { shown: c3.foot, realPositionsOnly: solStr(openLive), testPositionsOnly: solStr(openTest), bothAdded: solStr(openLive + openTest) });
  } else {
    book.ok(`${P}: the P/L of open positions`, amount(f3[1], openLive + openTest, 4) && f3[2] === undefined, { shown: c3.foot, exact: solStr(openLive + openTest) });
  }

  // ── wallet card ──
  book.eq(`${P}: the wallet card shows the address, linked to Solscan`, [d.wallet.addr, d.wallet.addrHref], [U.wallet, `https://solscan.io/account/${U.wallet}`]);

  // ── copies ──
  const keys = Object.keys(C).sort((a, b) => C[a].id - C[b].id);
  book.eq(`${P}: one line per copy, in the order they were made`, d.copies.map((r) => r.id), keys.map((k) => C[k].id));
  for (const [i, k] of keys.entries()) {
    const c = C[k];
    const s = c.settings;
    const row = d.copies[i];
    if (!row) continue;
    book.eq(`${P}: copy "${s.name}": name, wallet, buy, minimum, fees, slippage`, [row.name, row.meta[0], row.leaderHref], [`${s.name} TEST`, `${X.short(s.leader)} · buy ${s.buySol} SOL when they buy ≥ ${s.minLeaderBuySol} SOL · ${X.feeText(s)} SOL · slippage ${s.slippagePct}%`, `https://solscan.io/account/${s.leader}`]);
    book.eq(`${P}: copy "${s.name}": sell rules as tags`, row.tags, X.sellTags(s.sell));
    book.eq(`${P}: copy "${s.name}": switch ${s.enabled ? 'on' : 'off (line dimmed)'}`, [row.on, row.paused, row.switchTitle], [s.enabled, !s.enabled, s.enabled ? 'Pause' : 'Resume']);
    // Closed positions and their profit are of one kind, as on the profit cards: real ones once the account has any,
    // test ones until then (the count and the profit then describe the same positions).
    const m = /^(\d+) open · (\d+) closed · ([+−]?[\d.]+) SOL$/.exec(row.meta[1]) || [];
    book.eq(`${P}: copy "${s.name}": open and closed counts (closed: the ${E.primary} ones)`, [m[1], m[2]], [String(c.open), String(c.closedOf[E.primary])]);
    if (c.live !== 0n && c.test !== 0n) {
      book.ok(`${P}: copy "${s.name}": its profit keeps real and test apart`, amount(m[3], c[E.primary], 3, row.pnlClass), { shown: row.meta[1], realTradesOnly: solStr(c.live), testTradesOnly: solStr(c.test), bothAdded: solStr(c.live + c.test) });
    } else {
      book.ok(`${P}: copy "${s.name}": its profit`, amount(m[3], c[E.primary], 3, row.pnlClass), { shown: row.meta[1], exact: solStr(c[E.primary]) });
    }
  }

  // ── open positions ──
  book.eq(`${P}: one block per open position`, d.positions.map((p) => p.coin), E.open.map((p) => X.short(p.mint)));
  for (const [i, p] of E.open.entries()) {
    const row = d.positions[i];
    if (!row) continue;
    const N = `${P}: position ${p.key}`;
    book.eq(`${N}: coin link, copy, real/test mark`, [row.coinHref, row.via, row.pill], [`https://dexscreener.com/solana/${p.mint}`, `via ${p.copyName}`, p.mode === 'live' ? 'LIVE' : 'TEST']);
    const line = Object.fromEntries(row.line.map((t) => { const m = /^(Cost|Value|Sold|P\/L) (.*)$/.exec(t); return m ? [m[1], m[2]] : ['held', t]; }));
    book.ok(`${N}: Cost = SOL spent on the buy`, matches(line.Cost, solNum(p.cost)), { shown: line.Cost, exact: solStr(p.cost) });
    book.ok(`${N}: Sold = SOL returned so far`, matches(line.Sold, solNum(p.returned)), { shown: line.Sold, exact: solStr(p.returned) });
    if (p.value === null) book.eq(`${N}: Value is a dash while there is no price yet`, line.Value, '—');
    else book.ok(`${N}: Value = last quote × share still held`, matches(line.Value, solNum(p.value)), { shown: line.Value, exact: solStr(p.value) });
    book.ok(`${N}: P/L = sold + value − cost, signed and coloured`, amount(line['P/L'], p.pnl, 4, row.plClass), { shown: line['P/L'], colour: row.plClass, exact: solStr(p.pnl) });
    book.ok(`${N}: P/L % of the cost`, Math.abs(shown(row.big) - p.pnlPct) <= 0.0501 && row.bigClass === cls(shown(row.big) === 0 ? 0 : p.pnlPct), { shown: row.big, colour: row.bigClass, exact: p.pnlPct });
    book.ok(`${N}: % held (text and bar)`, /^\d+% held$/.test(line.held) && Math.abs(parseFloat(line.held) - p.heldPct) <= 0.5 && Math.abs(parseFloat(row.bar) - p.heldPct) < 0.011, { shown: line.held, bar: row.bar, exact: p.heldPct });
    if (p.status === 'opening') {
      book.ok(`${N}: a buy still in flight says "buying…" and has no Sell now`, /^buying…/.test(row.sub) && row.sell === null, { sub: row.sub, sell: row.sell });
      book.ok(`${N}: a buy still in flight does not already count down to a sell`, row.sub === 'buying…', row.sub);
    } else {
      book.ok(`${N}: says when it opened, and has Sell now`, agoMatches(row.sub, p.openedAt, now) && row.sell === String(p.id) && row.sellText === 'Sell now', { sub: row.sub, sell: row.sell });
      const copy = C[p.copy].settings;
      const next = copy.sell.timed.map((t, idx) => ({ ...t, idx })).filter((t) => !p.firedTimed.includes(t.idx)).sort((a, b) => a.afterSec - b.afterSec)[0];
      const m = / · next sell ([\d.]+)% in (\d+)s$/.exec(row.sub);
      if (next) book.ok(`${N}: names the next timed sell (${next.percent}% at +${next.afterSec}s)`, !!m && Number(m[1]) === next.percent, row.sub);
      else book.ok(`${N}: no "next sell" when no timed sell is left`, !m, row.sub);
    }
  }

  // ── the feed ──
  const events = manifest.events.filter((e) => e.user === who).slice().reverse();
  const want = events.slice(0, 80);
  const ICON = { buy: '↗', sell: '↘', skip: '–', error: '!', info: 'i' };
  const feed = d.feed.slice(opts.newFeedLines || 0);
  const wrong = [];
  for (const [i, e] of want.slice(0, feed.length).entries()) {
    const f = feed[i];
    if (f.msg !== e.message || f.kind !== e.kind || f.icon !== ICON[e.kind] || (e.signature ? f.link !== `https://solscan.io/tx/${encodeURIComponent(e.signature)}` || f.linkText !== 'view' : f.link !== null) || !agoMatches(f.when, e.at, now)) wrong.push({ line: i, shown: f, seeded: e });
  }
  book.ok(`${P}: the feed lists the latest ${Math.min(80, events.length)} lines, newest first, each with its words, its icon, its age, and a Solscan link only when there is a transaction`, wrong.length === 0 && feed.length === Math.min(80 - (opts.newFeedLines || 0), want.length), { lines: feed.length, expected: want.length, firstWrong: wrong.slice(0, 2) });
  const kinds = new Set(feed.map((f) => f.kind));
  book.ok(`${P}: the feed shows every kind of line (buy, sell, skip, error, info)`, ['buy', 'sell', 'skip', 'error', 'info'].every((k) => kinds.has(k)) || !['buy', 'sell', 'skip', 'error', 'info'].every((k) => events.some((e) => e.kind === k)), [...kinds]);
  return { E, C, d };
}

async function checkHistory(env, page, who, opts = {}) {
  const { book, manifest } = env;
  const timeZone = opts.timeZone || 'UTC';
  const now = Date.now();
  const E = X.forUser(manifest, who, { timeZone, now });
  const h = await ui.readHistory(page);
  const P = `${who}'s History${opts.label ? ` (${opts.label})` : ''}`;
  const both = E.modes.live.trades > 0 && E.modes.test.trades > 0;

  // ── profit by day ──
  book.eq(`${P}: day table columns`, h.dayCols, both ? ['Day', '', 'Trades', 'Winners', 'Profit'] : ['Day', 'Trades', 'Winners', 'Profit']);
  const wantDays = E.days.slice(0, 60).map((d) => [X.dayLabel(d.iso, opts.locale || 'en-US'), ...(both ? [d.mode === 'live' ? 'LIVE' : 'test'] : []), String(d.trades), `${Math.round((d.wins / d.trades) * 100)}%`]);
  const gotDays = h.days.map((r) => r.slice(0, -1).map((c) => c.text));
  book.ok(`${P}: one row per day and kind (real and test apart), the viewer's own days, newest first: day, trades, winners`, JSON.stringify(gotDays) === JSON.stringify(wantDays), () => {
    const i = gotDays.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(wantDays[k]));
    return { rows: gotDays.length, expectedRows: wantDays.length, firstDifferentRow: i, shown: gotDays[i], expected: wantDays[i] ?? null, shownAll: gotDays.slice(0, 12), expectedAll: wantDays.slice(0, 12) };
  });
  const badDay = [];
  for (const [i, d] of E.days.slice(0, 60).entries()) {
    const cell = h.days[i] && h.days[i][h.days[i].length - 1];
    if (!cell || !amount(cell.text, d.pnl, 4, cell.cls.replace('num', '').trim()) || !/ SOL$/.test(cell.text)) badDay.push({ day: d.iso, mode: d.mode, shown: cell && cell.text, colour: cell && cell.cls, exact: solStr(d.pnl) });
  }
  book.ok(`${P}: each day's profit = SOL returned − SOL spent of the positions closed that day, signed and coloured`, badDay.length === 0, badDay.slice(0, 5));

  // ── the heading of the closed positions ──
  // It counts EVERY closed position of the kind the profit cards show (real ones once there are any, test ones until
  // then), not just the rows listed under it, and says so when the list holds only the latest 200 (findings B1, B2).
  const m = /^Closed positions\s*(\d+) · total ([+−]?[\d.]+) SOL · (\d+)% winners(?: · platform fees ([\d.]+) SOL)?( · the latest (\d+) are listed)?$/.exec(h.closedHead) || [];
  const live = E.modes.live, test = E.modes.test;
  const all = { trades: live.trades + test.trades, pnl: live.all + test.all, wins: live.wins + test.wins, fees: live.fees + test.fees };
  const shownKind = E.primary === 'live' ? live : test;
  const winners = (b) => (b.trades ? Math.round((b.wins / b.trades) * 100) : 0);
  if (opts.skipHeading) {
    // judged once, in the viewer's main time zone
  } else if (both) {
    book.ok(`${P}: the heading's total keeps real and test apart (${live.trades} real trades, ${solStr(live.all)} SOL; ${test.trades} test trades, ${solStr(test.all)} SOL)`,
      m[1] === String(live.trades) && amount(m[2], live.all, 4) && m[3] === String(winners(live)) && (live.fees === 0n ? m[4] === undefined : matches(m[4], solNum(live.fees))), { shown: h.closedHead, realOnly: { trades: live.trades, total: solStr(live.all), winners: `${winners(live)}%`, platformFees: solStr(live.fees) }, testOnly: { trades: test.trades, total: solStr(test.all), winners: `${winners(test)}%`, platformFees: solStr(test.fees) }, bothAdded: { trades: all.trades, total: solStr(all.pnl), winners: `${winners(all)}%`, platformFees: solStr(all.fees) } });
  } else {
    book.ok(`${P}: the heading counts every closed position (${all.trades}) and totals them (${solStr(all.pnl)} SOL, ${winners(all)}% winners, platform fees ${solStr(all.fees)} SOL)`,
      m[1] === String(all.trades) && amount(m[2], all.pnl, 4) && m[3] === String(winners(all)) && (all.fees === 0n ? m[4] === undefined : matches(m[4], solNum(all.fees))),
      { shown: h.closedHead, expected: { trades: all.trades, total: solStr(all.pnl), winners: `${winners(all)}%`, platformFees: solStr(all.fees) } });
  }

  if (!opts.skipHeading) {
    const listed = Math.min(200, E.closed.length);
    book.ok(`${P}: the heading says when the list under it holds only the latest ${listed} of the ${E.closed.length} closed positions (and only then)`, E.closed.length > 200 ? m[6] === String(listed) : m[5] === undefined, { shown: h.closedHead, closed: E.closed.length, listed, headingCounts: shownKind.trades });
  }

  // ── each closed position ──
  book.eq(`${P}: closed table columns`, h.closedCols, ['Coin', 'Copy', 'Sells', 'Cost', 'Returned', 'P/L', 'Closed']);
  const wantClosed = E.closed.slice(0, opts.maxRows ?? 200);
  book.ok(`${P}: the closed positions, newest first${E.closed.length > 200 ? ' (the newest 200 of them)' : ''}`, JSON.stringify(h.closed.map((r) => r.coin)) === JSON.stringify(wantClosed.map((p) => X.short(p.mint))), { rows: h.closed.length, expected: wantClosed.length });
  const badRows = [];
  for (const [i, p] of wantClosed.entries()) {
    const r = h.closed[i];
    if (!r) break;
    const why = [];
    if (r.coinHref !== `https://dexscreener.com/solana/${p.mint}`) why.push('coin link');
    if (r.test !== (p.mode === 'test')) why.push('test mark');
    if (r.copy !== p.copyName) why.push('copy name');
    if (!matches(r.cost, solNum(p.cost))) why.push(`cost ${r.cost} vs ${solStr(p.cost)}`);
    if (!matches(r.returned, solNum(p.returned))) why.push(`returned ${r.returned} vs ${solStr(p.returned)}`);
    if (!amount(r.pnl, p.pnl, 4, r.pnlClass.replace('num', '').trim())) why.push(`P/L ${r.pnl} (${r.pnlClass}) vs ${solStr(p.pnl)}`);
    if (!(Math.abs(shown(r.pnlPct) - p.pnlPct) <= 0.0501)) why.push(`P/L % ${r.pnlPct} vs ${p.pnlPct}`);
    if (!agoMatches(r.closed, p.closedAt, now)) why.push(`closed "${r.closed}"`);
    if (r.sells.length !== p.sells.length) why.push(`sells ${r.sells.length} vs ${p.sells.length}`);
    for (const [k, s] of p.sells.entries()) {
      const t = r.sells[k];
      if (!t) break;
      const after = s.afterMs >= 0 && s.afterMs < 600_000 ? `+${(s.afterMs / 1000).toFixed(1)}s ` : '';
      const mm = /^(\+[\d.]+s )?([a-z ]+) (-?−?[\d.]+)$/.exec(t.text) || [];
      if ((mm[1] || '') !== after) why.push(`sell ${k + 1}: time after buy "${mm[1] || ''}" vs "${after}"`);
      if (mm[2] !== s.reason.replace('_', ' ')) why.push(`sell ${k + 1}: reason "${mm[2]}" vs "${s.reason}"`);
      if (!matches(mm[3], solNum(s.lamports))) why.push(`sell ${k + 1}: amount "${mm[3]}" vs ${solStr(s.lamports)}`);
      if (s.simulated ? t.link !== null : t.link !== `https://solscan.io/tx/${encodeURIComponent(s.signature)}`) why.push(`sell ${k + 1}: link`);
    }
    if (why.length) badRows.push({ position: p.key, why, shown: r });
  }
  book.ok(`${P}: every closed position shows its copy, cost, SOL returned, P/L and %, when it closed, and each sell with its reason, its SOL, its time after the buy and (real ones) a Solscan link`, badRows.length === 0, badRows.slice(0, 3));
  return { E, h };
}

async function alice(env) {
  const { book, manifest } = env;
  const S = await env.open('alice', env.ip(2));
  const { page } = S;
  const K = manifest.keys.alice;

  await env.scenario('alice: every number on the Dashboard against the seeded fills', async () => {
    await ui.login(page, K.key);
    await sleep(400);
    const { E, d } = await checkDashboard(env, page, 'alice');
    book.eq("alice's dashboard: who is logged in", d.top.who, 'Alice');
    await screenCheck(page, book, 'alice-dashboard');
    S.E = E;
    // The negative sell in the feed, as the engine words it.
    const neg = d.feed.find((f) => /for -0\.0004 SOL/.test(f.msg));
    book.ok("alice's feed: the sell that did not cover its fees shows as a negative amount", !!neg, d.feed.filter((f) => /Sold all/.test(f.msg)).map((f) => f.msg).slice(0, 3));
  }, { always: true });

  await env.scenario('alice: every number in History against the seeded fills', async () => {
    await ui.openTab(page, 'history');
    await sleep(200);
    const { h, E } = await checkHistory(env, page, 'alice');
    await screenCheck(page, book, 'alice-history', { ignoreInside: [/table-wrap/] });
    const negPos = E.closed.findIndex((p) => p.key === 'H3-live-negative-sell');
    const row = h.closed[negPos];
    book.note('alice: how the sell with negative proceeds is printed in History', row && row.sells.map((s) => s.text));
    book.ok('alice: History prints the negative sell with a minus sign', !!row && /[-−]0\.0004$/.test(row.sells[2].text), row && row.sells);
    book.ok('alice: History uses one minus sign everywhere (the sells and "Returned" printed "-" next to the P/L\'s "−")', !!row && !row.sells.some((s) => /-\d/.test(s.text)), row && { sells: row.sells.map((s) => s.text), pnl: row.pnl });
    const even = h.closed[E.closed.findIndex((p) => p.key === 'H8-live-even-40d')];
    book.eq('alice: a position that came out exactly even shows 0 and 0.0% with no colour', even && [even.pnl, even.pnlPct, even.pnlClass.replace('num', '').trim()], ['0', '0.0%', '']);
    // Both tabs still answer after going back and forth.
    await ui.openTab(page, 'dash');
    await ui.openTab(page, 'history');
    book.ok('alice: switching Dashboard ↔ History keeps working', !(await ui.readHistory(page)).loading);
    await ui.openTab(page, 'dash');
  });

  await env.scenario('alice: links that leave the site, and the logo', async () => {
    const read = () => page.evaluate(() => [...document.querySelectorAll('#app a[href]')].map((a) => ({ host: a.hostname, href: a.getAttribute('href'), target: a.target, rel: a.rel, own: a.hostname === location.hostname })));
    let links = await read();
    await ui.openTab(page, 'history');
    links = links.concat(await read());
    await ui.openTab(page, 'dash');
    const out = links.filter((l) => !l.own);
    book.ok('every link that leaves the site (Solscan, DexScreener) opens in a new tab and hands the site nothing (target=_blank, rel=noopener)', out.length > 20 && out.every((l) => l.target === '_blank' && /noopener/.test(l.rel) && /^(solscan\.io|dexscreener\.com)$/.test(l.host)), { links: out.length, hosts: [...new Set(out.map((l) => l.host))], bad: out.filter((l) => l.target !== '_blank' || !/noopener/.test(l.rel)).slice(0, 3) });
    const logo = await page.locator('.topbar .brand').evaluate((el) => { const r = el.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height), parts: [...el.children].map((c) => `${c.className || c.tagName}: ${getComputedStyle(c).display}`) }; });
    book.ok('the logo is on the screen (top left)', logo.width > 10 && logo.height > 10, logo);
    if (logo.width > 10) await page.locator('.topbar .brand').click(); else await page.goto('/');
    await page.locator('#app .auth, #app .topbar').first().waitFor();
    book.ok('the logo leads to the dashboard, still logged in', new URL(page.url()).pathname === '/' && (await page.locator('.topbar').count()) === 1);
    await sleep(300);
  });

  await env.scenario('alice: each seeded copy opens in the editor with its saved values, and saving untouched changes nothing', async () => {
    const st0 = await ui.state(page);
    for (const c of manifest.copies.filter((x) => x.user === 'alice')) {
      await ui.openEdit(page, c.id);
      const ed = await ui.readEditor(page);
      book.eq(`alice: copy "${c.settings.name}" in the editor shows exactly its saved values`, ui.editorVsSettings(ed, c.settings), []);
      await ui.hideToast(page);
      await ui.submitEditor(page);
      const t = await ui.toast(page);
      await until(async () => !(await ui.editorOpen(page)));
      const st = await ui.state(page);
      const now = st.copies.find((x) => x.id === c.id);
      book.ok(`alice: copy "${c.settings.name}" saved untouched is unchanged on the server`, !!t && t.text === 'Saved' && JSON.stringify(ui.stripCopy(now)) === JSON.stringify(c.settings), { toast: t, now: ui.stripCopy(now), before: c.settings });
    }
    const st1 = await ui.state(page);
    book.ok('alice: saving copies does not touch positions or profit figures', JSON.stringify(st0.positions.map((p) => [p.id, p.costSol, p.proceedsSol, p.heldPct])) === JSON.stringify(st1.positions.map((p) => [p.id, p.costSol, p.proceedsSol, p.heldPct])) && JSON.stringify(st0.pnl) === JSON.stringify(st1.pnl));
  });

  await env.scenario('alice: Sell now, offline', async () => {
    const st = await ui.state(page);
    const open = st.positions.filter((p) => p.status === 'open');
    const live = open.find((p) => p.mode === 'live' && p.heldPct < 100);
    const test = open.find((p) => p.mode === 'paper');
    book.allow(502, /^\/api\/positions\/\d+\/sell$/);
    for (const [what, p] of [['a position bought with real SOL', live], ['a test position', test]]) {
      if (!p) { book.ok(`Sell now: found ${what} to press it on`, false); continue; }
      const btn = page.locator(`[data-sell="${p.id}"]`);
      const n0 = apiCalls(page, /^\/api\/positions\/\d+\/sell$/).length;
      planDialog(page, { accept: false });
      await btn.click();
      await sleep(400);
      book.ok(`Sell now on ${what}: asks first; "Cancel" sends nothing`, page.__lastDialog.message === 'Sell the whole position now?' && apiCalls(page, /^\/api\/positions\/\d+\/sell$/).length === n0, page.__lastDialog);
      planDialog(page, { accept: true });
      await ui.hideToast(page);
      const t0 = Date.now();
      await page.locator(`[data-sell="${p.id}"]`).click();
      const busy = await page.locator(`[data-sell="${p.id}"]`).evaluate((b) => ({ text: b.textContent, disabled: b.disabled })).catch(() => null);
      const t = await ui.toast(page, 20_000);
      const took = Date.now() - t0;
      book.ok(`Sell now on ${what}: while it works the button says "Selling…" and cannot be pressed twice`, !!busy && busy.text === 'Selling…' && busy.disabled, busy);
      book.note(`Sell now on ${what}, offline: what the page says`, t && t.text);
      book.ok(`Sell now on ${what}, offline: fails with a message a person can read (no setting names, no code)`, !!t && t.bad && t.text.length > 8 && !/RPC_URL|LIVE_TRADING|undefined|null|\bat \w+ \(|Error:/.test(t.text), { toast: t, seconds: (took / 1000).toFixed(1) });
      await page.locator(`[data-sell="${p.id}"]`).waitFor();
      await sleep(500);
      const after = await page.locator(`[data-sell="${p.id}"]`).evaluate((b) => ({ text: b.textContent, disabled: b.disabled }));
      const st2 = await ui.state(page);
      const same = st2.positions.find((x) => x.id === p.id);
      book.ok(`Sell now on ${what}, offline: the position is untouched and the button is back`, after.text === 'Sell now' && !after.disabled && !!same && same.heldPct === p.heldPct && same.proceedsSol === p.proceedsSol && same.status === 'open', { after, same });
      const d = await ui.readDash(page);
      book.ok(`Sell now on ${what}, offline: the feed gets one line saying it failed and why`, d.feed[0].kind === 'error' && /you pressed Sell now\) failed: /.test(d.feed[0].msg), d.feed.slice(0, 2).map((f) => f.msg));
    }
    await ui.openTab(page, 'history');
    await ui.openTab(page, 'dash');
    book.ok('after failed sells the page is still usable (tabs switch, the editor opens)', (await page.locator('#new-copy').count()) === 1);
    await screenCheck(page, book, 'alice-after-sell-now');
  });

  await env.scenario('alice: the wallet cannot be removed while a position is open; deleting a copy that holds a coin', async () => {
    book.allow(409, /^\/api\/wallet$/);
    planDialog(page, { accept: true });
    await ui.hideToast(page);
    await page.locator('#remove-wallet').click();
    const t = await ui.toast(page);
    book.eq('Remove wallet with positions open: refused, and says what to do', t, { text: 'sell your open positions before removing the wallet', bad: true });
    book.eq('Remove wallet with positions open: the wallet is still there', (await ui.state(page)).wallet.pubkey, manifest.users.alice.wallet);

    // Pause a copy that has positions: they stay.
    const st = await ui.state(page);
    const allAll = manifest.copies.find((c) => c.key === 'allAll');
    const posBefore = st.positions.map((p) => p.id);
    await ui.openEdit(page, allAll.id);
    planDialog(page, { accept: true });
    await ui.hideToast(page);
    await page.locator('#delete-copy').click();
    book.eq('Delete on a copy that holds a coin says it deleted', await ui.toast(page), { text: 'Copy deleted', bad: false });
    await until(async () => !(await ui.editorOpen(page)));
    await sleep(400);
    const st2 = await ui.state(page);
    const d = await ui.readDash(page);
    book.ok('Delete on a copy that holds a coin: the copy is gone, its open position stays on the dashboard under the copy\'s name with Sell now', !st2.copies.some((c) => c.id === allAll.id) && JSON.stringify(st2.positions.map((p) => p.id)) === JSON.stringify(posBefore) && d.positions.some((p) => p.via === 'via AllOn all' && p.sell), { copies: st2.copies.map((c) => c.name), positions: d.positions.map((p) => [p.coin, p.via, !!p.sell]) });
    await ui.openTab(page, 'history');
    const h = await ui.readHistory(page);
    book.ok('Delete on a copy: its closed positions stay in History under its name', h.closed.some((r) => r.copy === 'AllOn all'), h.closed.map((r) => r.copy).slice(0, 6));
    await ui.openTab(page, 'dash');
  });

  return S;
}

module.exports = { alice, checkDashboard, checkHistory, amount };
