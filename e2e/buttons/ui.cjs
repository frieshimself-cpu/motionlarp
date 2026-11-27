'use strict';
// Reading and driving the two pages the way a person does: what is on the screen, clicks, typing.
const { planDialog, apiCalls, sleep, until } = require('./lib.cjs');

async function gotoApp(page, p = '/') {
  await page.goto(p, { waitUntil: 'domcontentloaded' });
  await page.locator('#app .auth, #app .topbar').first().waitFor();
}

async function enter(page, key) {
  await page.locator('#l').fill(key);
  await page.locator('#auth-form button[type=submit]').click();
}

async function login(page, key) {
  await gotoApp(page, '/');
  await enter(page, key);
  await page.locator('.topbar').waitFor();
}

async function hideToast(page) {
  await page.evaluate(() => { const t = document.querySelector('#toast'); t.hidden = true; t.textContent = ''; });
}
/** The toast once it shows: { text, bad }, or null when none came. */
async function toast(page, timeout = 6000) {
  const h = await page.waitForFunction(() => { const t = document.querySelector('#toast'); return t && !t.hidden && t.textContent ? { text: t.textContent, bad: t.classList.contains('bad') } : false; }, null, { timeout }).catch(() => null);
  return h ? h.jsonValue() : null;
}

/** The server's own answer for this session (the page's data), fetched from inside the page. */
const state = (page) => page.evaluate(async () => { const r = await fetch(`/api/state?tz=${-new Date().getTimezoneOffset()}`); return r.ok ? r.json() : { __status: r.status }; });
const historyApi = (page) => page.evaluate(async () => { const r = await fetch(`/api/history?tz=${-new Date().getTimezoneOffset()}`); return r.ok ? r.json() : { __status: r.status }; });

const READ_DASH = `(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const txt = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : null);
  const shownEl = (el) => !!el && getComputedStyle(el).display !== 'none';
  const cardByTitle = (t) => $$('.card').find((c) => { const h = c.querySelector('.card-head h2'); return !!h && h.childNodes.length > 0 && h.childNodes[0].textContent.trim() === t; });
  const copiesCard = cardByTitle('Copies');
  const posCard = cardByTitle('Open positions');
  const feedCard = cardByTitle('Activity');
  const walletCard = cardByTitle('Trading wallet');
  return {
    title: document.title,
    top: {
      nav: $$('.topbar .nav button').map((b) => ({ text: b.textContent, on: b.classList.contains('on') })),
      pills: $$('.topbar .right .pill').map((p) => ({ text: p.textContent, cls: p.className, title: p.title })),
      who: $('.who') ? $('.who').textContent : null, whoShown: shownEl($('.who')), whoHtml: $('.who') ? $('.who').innerHTML : null,
      logout: !!$('#logout'),
    },
    stats: $$('.stats .stat').map((c) => ({ label: txt($('.label', c)), value: txt($('.value', c)), valueClass: $('.value', c).className.replace('value', '').trim(), foot: txt($('.foot', c)), footSpans: $$('.foot span', c).map((s) => ({ cls: s.className, text: s.textContent })) })),
    wallet: walletCard ? {
      hasForm: !!$('#wallet-form', walletCard), sol: txt($('.sol-big', walletCard)), addr: $('.addr a', walletCard) ? $('.addr a', walletCard).textContent : null, addrHref: $('.addr a', walletCard) ? $('.addr a', walletCard).href : null,
      hint: txt($('.hint', walletCard)), buttons: $$('button', walletCard).map((b) => b.textContent), notes: $$('.note', walletCard).map(txt),
    } : null,
    copiesHead: copiesCard ? $$('.card-head button', copiesCard).map((b) => b.textContent) : [],
    copiesEmpty: copiesCard ? txt($('.empty', copiesCard)) : null,
    copies: copiesCard ? $$('.row', copiesCard).map((r) => ({
      id: Number($('[data-edit]', r).dataset.edit), paused: r.classList.contains('paused'), avatar: $('.avatar', r).textContent, name: txt($('.name', r)), nameHtml: $('.name', r).innerHTML,
      pill: $('.name .pill', r) ? $('.name .pill', r).textContent : null, meta: $$('.meta', r).map(txt), leaderHref: $('.meta a', r) ? $('.meta a', r).href : null, pnlClass: $('.meta span', r) ? $('.meta span', r).className : '',
      tags: $$('.tags .tag', r).map((t) => t.textContent), on: $('[data-toggle]', r).checked, switchTitle: $('.switch', r).title,
    })) : [],
    positionsHead: posCard ? txt($('.card-head', posCard)) : null,
    positionsEmpty: posCard ? txt($('.empty', posCard)) : null,
    positions: posCard ? $$('.pos', posCard).map((p) => ({
      coin: $('.coin a', p).textContent, coinHref: $('.coin a', p).href, via: $('.coin .dim', p).textContent, pill: $('.coin .pill', p).textContent,
      sub: txt($('.pos-top .dim[style]', p)), big: $('.big', p).textContent, bigClass: $('.big', p).className.replace('big', '').trim(),
      line: $$('.line > span', p).map(txt), plClass: $('.line b.up, .line b.down', p) ? $('.line b.up, .line b.down', p).className : '', sell: $('[data-sell]', p) ? $('[data-sell]', p).dataset.sell : null, sellText: $('[data-sell]', p) ? $('[data-sell]', p).textContent : null,
      bar: $('.bar i', p).style.width,
    })) : [],
    feedHead: feedCard ? txt($('.card-head', feedCard)) : null,
    feedEmpty: feedCard ? txt($('.empty', feedCard)) : null,
    feed: feedCard ? $$('.feed li', feedCard).map((li) => ({ kind: li.className, icon: $('.ic', li).textContent, msg: ($('.msg', li).childNodes[0] ? $('.msg', li).childNodes[0].textContent : '').trim(), link: $('.msg a', li) ? $('.msg a', li).href : null, linkText: $('.msg a', li) ? $('.msg a', li).textContent : null, when: $('.when', li).textContent })) : [],
  };
})()`;
const readDash = (page) => page.evaluate(READ_DASH);

const READ_HISTORY = `(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const txt = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : null);
  const cards = $$('.page > .stack > .card');
  if (cards.length < 2) return { loading: true, text: txt($('.page')) };
  const dayCard = cards[0], closedCard = cards[1];
  return {
    dayHead: txt($('.card-head', dayCard)), dayCols: $$('thead th', dayCard).map((th) => th.textContent),
    days: $$('tbody tr', dayCard).map((tr) => $$('td', tr).map((td) => ({ text: txt(td), cls: td.className }))),
    dayEmpty: txt($('.empty', dayCard)),
    closedHead: txt($('.card-head', closedCard)), closedTotalClass: $('.card-head .sub span', closedCard) ? $('.card-head .sub span', closedCard).className : '',
    closedCols: $$('thead th', closedCard).map((th) => th.textContent),
    closed: $$('tbody tr', closedCard).map((tr) => {
      const td = $$('td', tr);
      return {
        coin: $('a', td[0]).textContent, coinHref: $('a', td[0]).href, test: !!$('.tag', td[0]), copy: td[1].textContent,
        sells: $$('.tag', td[2]).map((t) => ({ text: t.childNodes[0].textContent.trim(), link: $('a', t) ? $('a', t).href : null })),
        cost: td[3].textContent, returned: td[4].textContent, pnl: td[5].childNodes[0].textContent, pnlPct: $('div', td[5]).textContent, pnlClass: td[5].className, closed: td[6].textContent,
      };
    }),
    closedEmpty: txt($('.empty', closedCard)),
  };
})()`;
const readHistory = (page) => page.evaluate(READ_HISTORY);

async function openTab(page, tab) {
  await page.locator(`.topbar .nav [data-tab=${tab}]`).click();
  await page.locator(`.topbar .nav [data-tab=${tab}].on`).waitFor();
  if (tab === 'history') await until(async () => !(await readHistory(page)).loading, { timeout: 8000 });
}

// ── the copy editor ─────────────────────────────────────────────────────
const READ_EDITOR = `(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const f = $('#copy-form');
  if (!f || $('#modal').hidden) return null;
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
  const rows = (sel) => $$(sel + ' .stage').map((r) => ({ a: $('[data-a]', r).value, b: $('[data-b]', r).value, rest: $('.rest', r) ? $('.rest', r).textContent : null, restShown: vis($('.rest', r)), text: r.innerText.replace(/\\s+/g, ' ').trim() }));
  const rule = (id) => ({ on: $('[data-rule="' + id + '"] [data-on]').checked, bodyShown: vis($('[data-rule="' + id + '"] .body')), title: $('[data-rule="' + id + '"] .t').textContent, desc: $('[data-rule="' + id + '"] .d').textContent });
  const groups = $$('.modal-body > .group');
  return {
    title: $('.modal-head h3').textContent,
    leaderTag: $('#f-leader').tagName, leader: $('#f-leader').value, leaderLabel: $('label[for=f-leader]').textContent, name: $('#f-name').value,
    buy: $('#f-buy').value, buyHint: $('#buy-hint').textContent, buyHintClass: $('#buy-hint').className,
    min: $('#f-min').value, prio: $('#f-prio').value, tip: $('#f-tip').value, sprio: $('#f-sprio').value, stip: $('#f-stip').value, slip: $('#f-slip').value,
    mirror: rule('mirror'), mirrorMode: $$('#f-mirror-mode .on').map((b) => b.dataset.v), mirrorHint: $('#mirror-hint').textContent,
    timed: rule('timed'), timedOf: $$('#f-timed-of .on').map((b) => b.dataset.v), timedHint: $('#timed-hint').textContent, timedRows: rows('#timed-rows'),
    stop: rule('stop'), stopRows: rows('#stop-rows'),
    dead: rule('dead'), idle: $('#f-idle').value,
    once: $('#f-once').checked,
    modeHint: groups.length ? (groups[groups.length - 1].querySelector('.hint') || {}).textContent : null,
    presetBar: $('.preset-bar') ? $('.preset-bar').innerText.replace(/\\s+/g, ' ').trim() : null,
    presetButtons: $$('[data-use-preset]').map((b) => ({ id: b.dataset.usePreset, text: b.textContent, primary: b.classList.contains('primary') })),
    submit: $('#copy-form button[type=submit]').textContent, hasDelete: !!$('#delete-copy'),
    err: $('#form-err').textContent,
    focus: document.activeElement ? document.activeElement.id : null,
  };
})()`;
const readEditor = (page) => page.evaluate(READ_EDITOR);
const editorOpen = async (page) => (await page.locator('#modal').getAttribute('hidden')) === null;

async function setRule(page, id, want) {
  const cur = await page.locator(`[data-rule=${id}] [data-on]`).isChecked();
  if (cur !== want) await page.locator(`[data-rule=${id}] .head .switch span`).click();
}

async function setRows(page, kind, rows) {
  const box = kind === 'timed' ? '#timed-rows' : '#stop-rows';
  for (let n = await page.locator(`${box} .stage`).count(); n > 0; n--) await page.locator(`${box} .stage [data-remove]`).first().click();
  for (const [a, b] of rows) {
    await page.locator(`[data-add=${kind}]`).click();
    const row = page.locator(`${box} .stage`).last();
    await row.locator('[data-a]').fill(String(a));
    await row.locator('[data-b]').fill(String(b));
  }
}

/** Types a whole copy into the open editor, control by control. */
async function fillEditor(page, s) {
  if (s.leaderText !== undefined) await page.locator('#f-leader').fill(s.leaderText);
  if (s.name !== undefined) await page.locator('#f-name').fill(s.name);
  const num = async (sel, v) => { if (v !== undefined) await page.locator(sel).fill(String(v)); };
  await num('#f-buy', s.buy); await num('#f-min', s.min); await num('#f-prio', s.prio); await num('#f-tip', s.tip);
  await num('#f-sprio', s.sprio); await num('#f-stip', s.stip); await num('#f-slip', s.slip);
  if (s.mirror) {
    if (s.mirror.mode) { await setRule(page, 'mirror', true); await page.locator(`#f-mirror-mode [data-v=${s.mirror.mode}]`).click(); }
    await setRule(page, 'mirror', s.mirror.on);
  }
  if (s.timed) {
    if (s.timed.of || s.timed.rows) {
      await setRule(page, 'timed', true);
      if (s.timed.of) await page.locator(`#f-timed-of [data-v=${s.timed.of}]`).click();
      if (s.timed.rows) await setRows(page, 'timed', s.timed.rows);
    }
    await setRule(page, 'timed', s.timed.on);
  }
  if (s.stop) {
    if (s.stop.rows) { await setRule(page, 'stop', true); await setRows(page, 'stop', s.stop.rows); }
    await setRule(page, 'stop', s.stop.on);
  }
  if (s.dead) {
    if (s.dead.idle !== undefined) { await setRule(page, 'dead', true); await page.locator('#f-idle').fill(String(s.dead.idle)); }
    await setRule(page, 'dead', s.dead.on);
  }
  if (s.once !== undefined && (await page.locator('#f-once').isChecked()) !== s.once) await page.locator('#f-once + span').click();
}

/** The settings the server should hold after `s` was typed for `leader`. */
function settingsOf(s, leader, name) {
  return {
    name, leader, enabled: s.enabled !== false, mode: 'paper', buySol: s.buy, minLeaderBuySol: s.min, slippagePct: s.slip,
    priorityFeeSol: s.prio, tipSol: s.tip, sellPriorityFeeSol: s.sprio, sellTipSol: s.stip, oncePerCoin: s.once,
    sell: {
      mirror: { enabled: s.mirror.on, mode: s.mirror.mode },
      timed: s.timed.on ? s.timed.rows.map(([afterSec, percent]) => ({ afterSec, percent })).sort((a, b) => a.afterSec - b.afterSec) : [],
      timedOf: s.timed.of,
      stopLoss: s.stop.on ? s.stop.rows.map(([lossPct, percent]) => ({ lossPct, percent })).sort((a, b) => a.lossPct - b.lossPct) : [],
      deadCoin: { enabled: s.dead.on, idleSec: s.dead.idle },
    },
  };
}

/** Every difference between what the editor shows and a copy's saved settings. */
function editorVsSettings(ed, s) {
  const diffs = [];
  const num = (what, text, want) => { if (text === '' || Number(text) !== want) diffs.push(`${what}: the editor shows "${text}", saved is ${want}`); };
  if (ed.leader.trim() !== s.leader) diffs.push(`wallet: the editor shows "${ed.leader}", saved is ${s.leader}`);
  if (ed.name !== s.name) diffs.push(`nickname: the editor shows "${ed.name}", saved is "${s.name}"`);
  num('your buy', ed.buy, s.buySol);
  num('only when they buy at least', ed.min, s.minLeaderBuySol);
  num('slippage', ed.slip, s.slippagePct);
  num('buy priority fee', ed.prio, s.priorityFeeSol);
  num('buy tip', ed.tip, s.tipSol ?? 0);
  num('sell priority fee', ed.sprio, s.sellPriorityFeeSol ?? s.priorityFeeSol);
  num('sell tip', ed.stip, s.sellTipSol ?? s.tipSol ?? 0);
  if (ed.mirror.on !== s.sell.mirror.enabled) diffs.push(`sell when they sell: switch ${ed.mirror.on}, saved ${s.sell.mirror.enabled}`);
  const mode = s.sell.mirror.mode ?? 'same';
  if (ed.mirrorMode.length !== 1 || ed.mirrorMode[0] !== mode) diffs.push(`sell-when-they-sell mode: the editor marks ${JSON.stringify(ed.mirrorMode)}, saved is ${mode}`);
  const timedOn = s.sell.timed.length > 0;
  if (ed.timed.on !== timedOn) diffs.push(`timed sells: switch ${ed.timed.on}, saved has ${s.sell.timed.length} steps`);
  const of = s.sell.timedOf ?? 'left';
  if (ed.timedOf.length !== 1 || ed.timedOf[0] !== of) diffs.push(`timed sells "% of": the editor marks ${JSON.stringify(ed.timedOf)}, saved is ${of}`);
  if (timedOn) {
    const got = ed.timedRows.map((r) => [Number(r.a), Number(r.b)]);
    const want = s.sell.timed.map((t) => [t.afterSec, t.percent]);
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`timed steps: the editor shows ${JSON.stringify(got)}, saved is ${JSON.stringify(want)}`);
    const wantRest = of === 'bag' ? 'of the original bag' : "of what's left";
    if (ed.timedRows.some((r) => r.rest !== wantRest)) diffs.push(`timed rows say ${JSON.stringify(ed.timedRows.map((r) => r.rest))}, should say "${wantRest}"`);
  }
  const stopOn = s.sell.stopLoss.length > 0;
  if (ed.stop.on !== stopOn) diffs.push(`stop loss: switch ${ed.stop.on}, saved has ${s.sell.stopLoss.length} levels`);
  if (stopOn) {
    const got = ed.stopRows.map((r) => [Number(r.a), Number(r.b)]);
    const want = s.sell.stopLoss.map((t) => [t.lossPct, t.percent]);
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`stop levels: the editor shows ${JSON.stringify(got)}, saved is ${JSON.stringify(want)}`);
  }
  if (ed.dead.on !== s.sell.deadCoin.enabled) diffs.push(`dead coin: switch ${ed.dead.on}, saved ${s.sell.deadCoin.enabled}`);
  num('dead coin seconds', ed.idle, s.sell.deadCoin.idleSec);
  if (ed.once !== s.oncePerCoin) diffs.push(`buy each coin only once: switch ${ed.once}, saved ${s.oncePerCoin}`);
  return diffs;
}

const stripCopy = (c) => { const { id, stats, ...rest } = c; return rest; };

// The editor moves the cursor into a box 30 ms after it opens; a person cannot type sooner than that, so neither does the suite.
const settle = (page) => page.waitForTimeout(120);
async function openEdit(page, id) {
  await page.locator(`[data-edit="${id}"]`).click();
  await page.locator('#copy-form').waitFor();
  await settle(page);
}
async function openNew(page) {
  await page.locator('#new-copy').click();
  await page.locator('#copy-form').waitFor();
  await settle(page);
}
async function openPreset(page, id = 'scharo') {
  await page.locator(`[data-preset-open=${id}]`).click();
  await page.locator('#copy-form').waitFor();
  await settle(page);
}
async function usePreset(page, id = 'scharo') {
  await page.locator(`[data-use-preset=${id}]`).click();
  await settle(page);
}
async function submitEditor(page) { await page.locator('#copy-form button[type=submit]').click(); }
async function closeEditor(page, how = 'cancel') {
  if (how === 'cancel') await page.locator('#cancel').click();
  else if (how === 'x') await page.locator('#cancel-x').click();
  else if (how === 'escape') await page.keyboard.press('Escape');
  else if (how === 'backdrop') await page.locator('#modal').dispatchEvent('mousedown');
  await until(async () => !(await editorOpen(page)), { timeout: 3000 });
}

// ── the admin page ──────────────────────────────────────────────────────
const READ_ADMIN = `(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const txt = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : null);
  if ($('#admin-login') || $('.auth')) return { login: true, tagline: txt($('.tagline')), err: txt($('.err')), note: txt($('.note')), foot: txt($('.auth .foot')), footHref: $('.auth .foot a') ? $('.auth .foot a').getAttribute('href') : null };
  const cardByTitle = (t) => $$('.card').find((c) => { const h = c.querySelector('.card-head h2'); return !!h && h.childNodes.length > 0 && h.childNodes[0].textContent.trim() === t; });
  const lic = cardByTitle('License keys'), users = cardByTitle('Users'), settings = cardByTitle('Settings');
  const top = {
    nav: $$('.topbar .nav button').map((b) => ({ text: b.textContent.trim(), on: b.classList.contains('on'), dot: !!b.querySelector('.dot.bad') })),
    pills: $$('.topbar .right .pill').map((p) => p.textContent), openSite: $('.topbar a.btn') ? $('.topbar a.btn').getAttribute('href') : null, logout: !!$('#admin-logout'),
  };
  if (!lic) {
    return {
      status: true, top,
      cards: $$('.page .card').map((c) => ({ head: txt($('.card-head h2', c)), pill: txt($('.card-head .pill', c)), rows: $$('.conn-row', c).map((r) => ({ dot: $('.dot', r) ? $('.dot', r).className.replace('dot', '').trim() : '', name: $('b', r) ? $('b', r).textContent : '', detail: r.lastElementChild ? r.lastElementChild.textContent : '', cls: r.lastElementChild ? r.lastElementChild.className : '' })), body: txt($('.card-body', c)) })),
      inputs: $$('.page input, .page textarea, .page select').length, buttons: $$('.page button').map((b) => ({ text: b.textContent, disabled: b.disabled })),
    };
  }
  return {
    top, banner: txt($('.page > .err')),
    stats: $$('.stats .stat').map((c) => ({ label: txt($('.label', c)), value: txt($('.value', c)), foot: txt($('.foot', c)) })),
    newKey: $('.ok-note') ? { text: txt($('.ok-note')), key: $('#key-text').textContent, html: $('.ok-note').innerHTML } : null,
    licFeePlaceholder: $('#lic-fee').placeholder, licLabel: $('#lic-label').value,
    licenses: $$('tbody tr', lic).map((tr) => { const td = $$('td', tr); return { label: td[0].textContent, labelHtml: td[0].innerHTML, key: td[1].textContent, status: txt(td[2]), account: txt(td[3]), fee: td[4].textContent, created: td[5].textContent, buttons: $$('button', td[6]).map((b) => b.textContent), id: Number(($('[data-fee]', td[6]) || { dataset: {} }).dataset.fee) }; }),
    usersHead: txt($('.card-head', users)), usersEmpty: txt($('.empty', users)),
    users: $$('tbody tr', users).map((tr) => { const td = $$('td', tr); return { name: $('b', td[0]).textContent, nameHtml: $('b', td[0]).innerHTML, disabled: !!$('.pill.off', td[0]), sub: txt($('div', td[0])), license: txt(td[1]), wallet: txt(td[2]), walletHref: $('a', td[2]) ? $('a', td[2]).href : null, copies: td[3].textContent, open: td[4].textContent, closed: td[5].textContent, profit: td[6].textContent, profitClass: td[6].className, fees: td[7].textContent, buttons: $$('button', td[8]).map((b) => b.textContent), id: Number(($('[data-disable], [data-enable]', td[8]) || { dataset: {} }).dataset.disable || ($('[data-enable]', td[8]) || { dataset: {} }).dataset.enable) }; }),
    settings: { fee: $('#set-fee').value, wallet: $('#set-wallet').value, max: $('#set-max').value, live: $('#set-live').checked, liveText: $('#live-text').textContent, liveClass: $('#live-text').className, msg: $('#settings-msg').textContent, msgClass: $('#settings-msg').className },
  };
})()`;
const readAdmin = (page) => page.evaluate(READ_ADMIN);

async function adminLogin(page, password) {
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await page.locator('#admin-login, .topbar').first().waitFor();
  if (await page.locator('#admin-login').count()) {
    await page.locator('#ap').fill(password);
    await page.locator('#admin-login button[type=submit]').click();
    await page.locator('.topbar').waitFor();
  }
}
const adminState = (page) => page.evaluate(async () => { const r = await fetch('/api/admin/state'); return r.ok ? r.json() : { __status: r.status }; });

module.exports = {
  gotoApp, enter, login, hideToast, toast, state, historyApi, readDash, readHistory, openTab, readEditor, editorOpen, setRule, setRows, fillEditor, settingsOf,
  editorVsSettings, stripCopy, openEdit, openNew, openPreset, usePreset, submitEditor, closeEditor, readAdmin, adminLogin, adminState,
};
