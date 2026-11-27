// The owner's page (/admin): license keys, users, and the settings that used to live in a file on the server.
import { $, $$, app, esc, short, fmtSol, signed, cls, solscanAcct, ago, api, toast, brandHtml, modePill } from '/ui.js';
import { plain } from '/figures.js';

let config = null;
let state = null;
let newKey = null; // the key just created: shown once, until the page is left or another is made
let timer = null; // the background refresh, every 5 s
let connTimer = null; // the connection check, every 2 minutes
let tab = 'admin';
let conn = null; // the last connection report (null: not checked yet)
let connBusy = false;
/** What the last Save of the settings said: a refusal stays on through the background redraws until the next Save. */
let settingsNote = { text: '', cls: 'muted' };

/**
 * The page's two clocks: started when the owner's page is shown (opened logged in, or after a login through the form,
 * which used to start only the first), stopped by the password form. The connection check ran on after Log out and
 * answered its 401 by drawing the password form again: a half-typed password was wiped two minutes later, and on the
 * Status tab the old Status page was drawn first.
 */
function startTimers() {
  stopTimers();
  timer = setInterval(() => { if (!document.hidden) load(true); }, 5000);
  // The connections are tested when the owner opens the page, and again every two minutes while it is open.
  connTimer = setInterval(() => { if (!document.hidden) checkConnections(); }, 120_000);
}
function stopTimers() {
  clearInterval(timer);
  clearInterval(connTimer);
  timer = null;
  connTimer = null;
}

/** The password form is on the screen: the owner is logged out. */
const onLogin = () => !!$('.auth', app);

/** A request found the owner logged out: the password form, unless it is already on the screen (drawn again, it lost
 *  what was being typed into it). */
function loggedOut() {
  stopTimers();
  if (!onLogin()) renderLogin();
}

function renderLogin(error = '') {
  stopTimers();
  app.innerHTML = `
    <section class="auth"><div class="auth-in">
      ${brandHtml(config.brand)}
      <p class="tagline">Owner area</p>
      <div class="card">
        ${config.adminEnabled ? `<form id="admin-login">
          <div class="field"><label for="ap">Admin password</label><input id="ap" type="password" autocomplete="current-password" required autofocus></div>
          <button class="btn primary block" type="submit">Open admin</button>
          ${error ? `<div class="err">${esc(error)}</div>` : ''}
        </form>` : '<div class="note">The admin area is not set up on this server yet. Run the installer once more: it asks you to choose an admin password.</div>'}
      </div>
      <div class="foot"><a href="/">Back to the site</a></div>
    </div></section>`;
  $('#admin-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/admin/login', { password: $('#ap').value });
      state = await api('GET', '/api/admin/state');
      render();
      startTimers();
      checkConnections();
    } catch (err) { renderLogin(err.message); }
  });
}

const STATUS = { unused: '<span class="pill">Unused</span>', active: '<span class="pill live">Active</span>', revoked: '<span class="pill off">Revoked</span>' };
const feeLabel = (l) => (l.feePercent === null ? `Default (${state.settings.feePercent}%)` : `${l.feePercent}%`);

const topbar = (s) => `
    <header class="topbar"><div class="topbar-in">
      ${brandHtml(config.brand)}
      <nav class="nav"><button data-tab="admin" class="${tab === 'admin' ? 'on' : ''}">Admin</button><button data-tab="connections" class="${tab === 'connections' ? 'on' : ''}">Status${conn && !conn.ok ? ' <span class="dot bad"></span>' : ''}</button></nav>
      <div class="right">${modePill(s.server)}<a class="btn small ghost" href="/">Open site</a><button class="btn small ghost" id="admin-logout">Log out</button></div>
    </div></header>`;

function bindTop() {
  $('#admin-logout').addEventListener('click', async () => { stopTimers(); await api('POST', '/api/admin/logout').catch(() => {}); newKey = null; settingsNote = { text: '', cls: 'muted' }; renderLogin(); });
  $$('[data-tab]', app).forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    render();
    if (tab === 'connections') checkConnections();
  }));
}

// ── Status: does each connection work right now? Read-only. The Helius link and the Jupiter key live in the
// server's own file; this page cannot show or change them. ──
const connRow = (c) => `<div class="conn-row"><span class="dot ${c.ok ? 'good' : c.optional ? 'warn' : 'bad'}"></span><b>${esc(c.name)}</b><span class="${c.ok || c.optional ? 'muted' : 'down'}">${esc(c.detail)}</span></div>`;
const WHERE = {
  server: '<span class="pill live">Set on the server</span>',
  saved: '<span class="pill">Moving to the server file</span>',
  none: '<span class="pill off">Not set on the server</span>',
};

function renderConnections() {
  const s = state;
  const st = s.settings;
  const by = (id) => conn?.checks.find((c) => c.id === id);
  const rows = (ids) => (conn ? ids.map((id) => by(id)).filter(Boolean).map(connRow).join('') : '<div class="conn-row"><span class="dot"></span><span class="muted">Checking…</span></div>');
  const head = !conn ? '<span class="pill">Checking…</span>' : conn.ok ? '<span class="pill live">All working</span>' : '<span class="pill off">Needs attention</span>';
  const moving = '<div class="hint" style="margin-top:10px">It was typed into this page in the past. The server moves it into its own file by itself at its next update; it keeps working meanwhile.</div>';
  app.innerHTML = `${topbar(s)}
    <main class="page">
      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>Status<span class="sub">is everything the site trades through working right now?</span></h2><div style="display:flex;gap:10px;align-items:center">${head}<button class="btn small" id="conn-check" ${connBusy ? 'disabled' : ''}>${connBusy ? 'Checking…' : 'Check again'}</button></div></div>
          <div class="card-body"><div class="muted" style="font-size:13px">Each row is a real request sent just now. The Helius link and the Jupiter key are set once on the server itself and used for every user: this website cannot show or change them.</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Helius<span class="sub">the connection to Solana: reading the copied wallets and sending trades</span></h2>${WHERE[st.rpcFrom] ?? ''}</div>
          <div class="card-body">${rows(['rpc', 'stream', 'sender'])}${st.rpcFrom === 'saved' ? moving : ''}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Jupiter<span class="sub">buys and sells every coin that is not on pump.fun</span></h2>${WHERE[st.jupiterFrom] ?? ''}</div>
          <div class="card-body">${rows(['jupiter'])}${st.jupiterFrom === 'saved' ? moving : ''}</div>
        </div>
      </div>
    </main>`;
  bindTop();
  $('#conn-check').addEventListener('click', () => checkConnections());
}

async function checkConnections() {
  if (connBusy || onLogin()) return;
  connBusy = true;
  if (tab === 'connections') redraw({ background: true });
  try {
    conn = await api('GET', '/api/admin/connections');
  } catch (err) {
    connBusy = false;
    if (err.status === 401) return loggedOut();
    conn = { ok: false, checks: [{ id: 'rpc', name: 'Check', ok: false, detail: err.message }] };
  }
  connBusy = false;
  if (!onLogin()) redraw({ background: true });
}

// ── drawing the page again without losing what the owner is doing ───────
// The page used to stop drawing while any box held unsent text, and its figures froze with no sign ("2" typed in
// "Their fee", and the Users count stayed at 4 while a new user logged in). Now it is drawn as the figures come, and
// what was typed and not sent goes into the new page: the values, the box being typed in with its cursor where it
// was, and how far each table is scrolled.

/** A control as it can be found again in the new page: by its id, or by its first data- attribute (the table's buttons). */
function spot(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const d = [...el.attributes].find((a) => a.name.startsWith('data-'));
  return d ? `${el.tagName.toLowerCase()}[${d.name}="${CSS.escape(d.value)}"]` : null;
}

/** What is typed and not sent (not in `sent`, the form just sent, whose boxes come back empty), and where the cursor is. */
function keepTyped(sent) {
  const sentForm = sent ? $(sent, app) : null;
  const inSent = (el) => !!sentForm && sentForm.contains(el);
  const a = document.activeElement;
  const focus = a && a !== document.body && app.contains(a) ? a : null;
  const typed = $$('input, textarea', app)
    .filter((el) => el.id && el !== focus && !inSent(el) && (el.type === 'checkbox' ? el.checked !== el.defaultChecked : el.value !== el.defaultValue))
    .map((el) => ({ id: el.id, value: el.value, checked: el.checked }));
  return { focus, keepBox: !!focus && /^(INPUT|TEXTAREA)$/.test(focus.tagName) && !inSent(focus), where: focus ? spot(focus) : null, typed, scroll: $$('.table-wrap', app).map((el) => el.scrollLeft) };
}

function putBack(k) {
  for (const t of k.typed) {
    const el = document.getElementById(t.id);
    if (!el || !app.contains(el)) continue;
    if (el.type === 'checkbox') el.checked = t.checked;
    else el.value = t.value;
  }
  const fresh = k.where ? $(k.where, app) : null;
  if (fresh && k.keepBox && fresh.tagName === k.focus.tagName && fresh.type === k.focus.type) {
    // The box itself goes back (what is typed in it, and its cursor, even in a number box, which does not say where its
    // cursor is); what it would start from is the server's latest.
    if (fresh.type === 'checkbox') k.focus.defaultChecked = fresh.defaultChecked;
    else k.focus.defaultValue = fresh.defaultValue;
    fresh.replaceWith(k.focus);
    k.focus.focus({ preventScroll: true });
  } else if (fresh) fresh.focus({ preventScroll: true });
  $$('.table-wrap', app).forEach((el, i) => { if (k.scroll[i]) el.scrollLeft = k.scroll[i]; });
  // The live switch's words follow the switch, as when it is clicked.
  const live = $('#set-live', app);
  if (live && state?.settings && live.checked !== state.settings.liveTrading) $('#live-text').textContent = live.checked ? 'Live trading will be ON after saving' : 'Test mode';
}

// A background redraw waits while a button is held down (it would be replaced before it is let go, and the click lost)
// or a word is being composed with an input method, and comes right after.
let pressedAt = 0;
let composing = false;
let drawLater = false;
const busyHand = () => composing || (pressedAt > 0 && Date.now() - pressedAt < 2000);
function drawNow() {
  if (!drawLater) return;
  drawLater = false;
  setTimeout(() => { if (!onLogin() && state) redraw({ background: true }); }, 0);
}
document.addEventListener('pointerdown', () => { pressedAt = Date.now(); }, true);
for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, () => { pressedAt = 0; drawNow(); }, true);
document.addEventListener('compositionstart', () => { composing = true; }, true);
document.addEventListener('compositionend', () => { composing = false; drawNow(); }, true);

/** Draws the page again from the latest data, keeping what the owner was doing (see above). */
function redraw({ sent = null, background = false } = {}) {
  if (background && busyHand()) { drawLater = true; return; }
  const kept = keepTyped(sent);
  render();
  putBack(kept);
}

function render() {
  if (tab === 'connections') return renderConnections();
  const s = state;
  const st = s.settings;
  app.innerHTML = `${topbar(s)}
    <main class="page">
      ${conn && !conn.ok ? `<div class="err" style="margin-bottom:16px">A connection needs attention: ${esc(conn.checks.filter((c) => !c.ok && !c.optional).map((c) => `${c.name} — ${c.detail}`).join(' · '))}. Open <b>Status</b>.</div>` : ''}
      <section class="grid stats">
        <div class="card stat"><div class="label">Users</div><div class="value">${s.totals.users}</div><div class="foot">${s.licenses.filter((l) => l.status === 'unused').length} unused keys</div></div>
        <div class="card stat"><div class="label">Open positions</div><div class="value">${s.totals.open}</div><div class="foot">watching ${s.server.watching} wallets</div></div>
        <div class="card stat"><div class="label">Fees earned</div><div class="value">${fmtSol(s.totals.feesLiveSol, 4)} <small>SOL</small></div><div class="foot">real trades · test mode would have: ${fmtSol(s.totals.feesTestSol, 4)}</div></div>
        <div class="card stat"><div class="label">Trading</div><div class="value">${s.server.mode === 'offline' ? 'Offline' : s.server.live ? 'Live' : 'Test'}</div><div class="foot">${st.rpcSet ? `Sender ${esc(s.server.sender ?? '—')} · feed: ${esc(s.server.feed ?? 'standard')}` : 'the Helius link is not set on the server'}</div></div>
      </section>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>License keys<span class="sub">one key = one account · the key is the login</span></h2></div>
          <div class="card-body">
            <form id="new-license" class="inline-form">
              <div class="field"><label for="lic-label">Who is it for</label><input id="lic-label" type="text" maxlength="40" placeholder="e.g. Tom" required></div>
              <div class="field" style="flex:0 1 190px"><label for="lic-fee">Their fee</label><div class="unit"><input id="lic-fee" type="number" min="0" max="10" step="any" placeholder="default ${st.feePercent}"><span>%</span></div></div>
              <button class="btn primary" type="submit">Create key</button>
            </form>
            ${newKey ? `<div class="ok-note" style="margin-top:14px">Key for <b>${esc(newKey.label)}</b> — copy it now, it is not shown again:<div class="keybox" id="key-text">${esc(newKey.key)}</div><button class="btn small" id="copy-key">Copy key</button></div>` : ''}
          </div>
          ${s.licenses.length ? `<div class="table-wrap" style="border-top:1px solid var(--border)"><table>
            <thead><tr><th>For</th><th>Key</th><th>Status</th><th>Account</th><th>Fee</th><th>Created</th><th></th></tr></thead>
            <tbody>${s.licenses.map((l) => `<tr>
              <td><b>${esc(l.label)}</b></td>
              <td class="mono dim">WM-····-${esc(l.hint)}</td>
              <td>${STATUS[l.status] ?? ''}</td>
              <td>${l.username ? esc(l.username) : '<span class="dim">—</span>'}</td>
              <td>${esc(feeLabel(l))}</td>
              <td class="dim">${ago(l.createdAt)}</td>
              <td class="right-align"><div class="actions" style="justify-content:flex-end">
                <button class="btn small" data-fee="${l.id}">Set fee</button>
                <button class="btn small" data-reissue="${l.id}" title="Lost key: make a new one for the same account">New key</button>
                ${l.status === 'revoked' ? `<button class="btn small" data-restore="${l.id}">Restore</button>` : `<button class="btn small danger" data-revoke="${l.id}">Revoke</button>`}
                ${l.status === 'unused' ? `<button class="btn small ghost" data-delete="${l.id}">Delete</button>` : ''}
              </div></td></tr>`).join('')}</tbody></table></div>` : ''}
        </div>

        <div class="card">
          <div class="card-head"><h2>Users<span class="sub">${s.users.length}</span></h2></div>
          <div class="card-body flush">${s.users.length ? `<div class="table-wrap"><table>
            <thead><tr><th>User</th><th>License</th><th>Wallet</th><th class="num">Copies</th><th class="num">Open</th><th class="num">Closed</th><th class="num" title="Real trades; what test trades would have made is shown under it">Profit</th><th class="num">Fees paid</th><th></th></tr></thead>
            <tbody>${s.users.map((u) => `<tr>
              <td><b>${esc(u.username)}</b> ${u.disabled ? '<span class="pill off">Disabled</span>' : ''}<div class="dim" style="font-size:12px">joined ${ago(u.createdAt)} · fee ${u.feePercent}%</div></td>
              <td>${u.license ? esc(u.license) : '<span class="dim">—</span>'}</td>
              <td>${u.wallet ? `<a class="mono" href="${solscanAcct(u.wallet)}" target="_blank" rel="noopener">${esc(short(u.wallet))}</a>` : '<span class="dim">none</span>'}</td>
              <td class="num">${u.copies}</td><td class="num">${u.open}</td><td class="num">${u.closed}</td>
              <td class="num ${cls(u.pnlSol)}">${signed(u.pnlSol, 3)}${u.testPnlSol ? `<div class="dim" style="font-size:12px">test ${signed(u.testPnlSol, 3)}</div>` : ''}</td>
              <td class="num">${fmtSol(u.feesLiveSol, 4)}</td>
              <td class="right-align"><div class="actions" style="justify-content:flex-end">${u.license ? '' : `<button class="btn small" data-userkey="${u.id}" title="This account has no key yet: make one so they can get in">Create key</button>`}${u.disabled ? `<button class="btn small" data-enable="${u.id}">Enable</button>` : `<button class="btn small danger" data-disable="${u.id}">Disable</button>`}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><b>No users yet</b>Create a key above and send it to a friend: pasting it on the site is all they need to get in.</div>'}</div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Settings</h2></div>
          <form id="settings">
            <div class="setting"><div class="what"><b>Platform fee</b><span>Your cut of every buy and sell, paid inside the same transaction. A license can have its own.</span></div>
              <div class="row2"><div><label for="set-fee">Fee</label><div class="unit"><input id="set-fee" type="number" min="0" max="10" step="any" value="${esc(plain(st.feePercent))}"><span>%</span></div></div>
              <div><label for="set-wallet">Paid to wallet</label><input id="set-wallet" type="text" autocomplete="off" spellcheck="false" value="${esc(st.feeWallet)}" placeholder="Wallet address (must hold ≥ 0.001 SOL)"></div></div></div>
            <div class="setting"><div class="what"><b>Max per buy</b><span>No single copy buy may spend more than this.</span></div>
              <div style="max-width:220px"><div class="unit"><input id="set-max" type="number" min="0.001" step="any" value="${esc(plain(st.maxSolPerBuy))}"><span>SOL</span></div></div></div>
            <div class="setting"><div class="what"><b>Live trading</b><span>On: every enabled copy on the site buys with real SOL. Off: no new real buys (copies are simulated); coins already bought with real SOL are still sold by their rules and with Sell now.</span></div>
              <div style="display:flex;align-items:center;gap:12px"><label class="switch"><input type="checkbox" id="set-live" ${st.liveTrading ? 'checked' : ''} aria-label="Live trading"><span></span></label><span id="live-text" class="${st.liveTrading ? 'up' : 'muted'}">${st.liveTrading ? 'Live trading is ON' : 'Test mode'}</span></div></div>
            <div class="card-body" style="border-top:1px solid var(--border);display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="btn primary" type="submit">Save settings</button><span id="settings-msg" class="${settingsNote.cls}">${esc(settingsNote.text)}</span></div>
          </form>
        </div>
      </div>
    </main>`;
  bind();
}

function bind() {
  bindTop();
  $('#new-license').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('#lic-label').value.trim();
    const fee = $('#lic-fee').value;
    try {
      const r = await api('POST', '/api/admin/licenses', { label, feePercent: fee === '' ? null : Number(fee) });
      newKey = { key: r.key, label };
      await load(false, '#new-license');
    } catch (err) { toast(err.message, true); }
  });
  $('#copy-key')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(newKey.key); toast('Key copied'); } catch { toast('Select the key and copy it', true); }
  });
  const act = (sel, attr, fn) => $$(sel, app).forEach((b) => b.addEventListener('click', async () => {
    try { await fn(Number(b.dataset[attr])); await load(); } catch (err) { toast(err.message, true); }
  }));
  act('[data-revoke]', 'revoke', async (id) => { if (confirm('Revoke this key? Its user is locked out and gets no new copies; open positions still sell by their rules.')) await api('PUT', `/api/admin/licenses/${id}`, { revoked: true }); });
  act('[data-reissue]', 'reissue', async (id) => {
    if (!confirm('Make a new key for this account? The old key stops working.')) return;
    const l = state.licenses.find((x) => x.id === id);
    const r = await api('POST', `/api/admin/licenses/${id}/reissue`);
    newKey = { key: r.key, label: l?.label ?? '' };
  });
  act('[data-userkey]', 'userkey', async (id) => {
    const u = state.users.find((x) => x.id === id);
    const r = await api('POST', `/api/admin/users/${id}/key`);
    newKey = { key: r.key, label: u?.username ?? '' };
  });
  act('[data-restore]', 'restore', (id) => api('PUT', `/api/admin/licenses/${id}`, { revoked: false }));
  act('[data-delete]', 'delete', async (id) => { if (confirm('Delete this unused key?')) await api('DELETE', `/api/admin/licenses/${id}`); });
  act('[data-fee]', 'fee', async (id) => {
    const v = prompt('Fee for this license in % (leave empty to use the default fee):', '');
    if (v === null) return;
    // "0%", "0,5" and " 1 " are read as the numbers they mean; anything else is refused, never taken as "default".
    const t = v.trim().replace(',', '.').replace(/%$/, '').trim();
    if (t !== '' && !/^\d*\.?\d+$/.test(t)) { alert(`"${v}" is not a number: nothing was changed.`); return; }
    await api('PUT', `/api/admin/licenses/${id}`, { feePercent: t === '' ? null : Number(t) });
  });
  act('[data-disable]', 'disable', async (id) => { if (confirm('Disable this user? They are logged out and get no new copies.')) await api('PUT', `/api/admin/users/${id}`, { disabled: true }); });
  act('[data-enable]', 'enable', (id) => api('PUT', `/api/admin/users/${id}`, { disabled: false }));

  $('#set-live').addEventListener('change', (e) => {
    if (e.target.checked && !confirm('Turn live trading ON? Every enabled copy on the site will then buy and sell with real SOL.')) e.target.checked = false;
    $('#live-text').textContent = e.target.checked ? 'Live trading will be ON after saving' : 'Test mode';
  });
  $('#settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = (text, c) => {
      settingsNote = { text, cls: c };
      const msg = $('#settings-msg');
      if (msg) { msg.className = c; msg.textContent = text; }
    };
    note('Saving…', 'muted');
    const body = { feePercent: Number($('#set-fee').value || 0), feeWallet: $('#set-wallet').value.trim(), liveTrading: $('#set-live').checked };
    // An empty "max per buy" keeps the current value.
    if ($('#set-max').value.trim()) body.maxSolPerBuy = Number($('#set-max').value);
    try {
      await api('POST', '/api/admin/settings', body);
      settingsNote = { text: '', cls: 'muted' };
      toast('Settings saved');
      await load(false, '#settings');
    } catch (err) {
      note(err.message, 'down');
    }
  });
}

/** Wait for the site to come back after it restarts itself (the admin login survives the restart). */
async function waitForRestart() {
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/config'); return; } catch { await new Promise((r) => setTimeout(r, 1500)); }
  }
}

/**
 * The latest figures, drawn at once, with what is typed and not sent kept (see redraw). `quiet`: the background
 * refresh (it says nothing when it fails, and waits for a button being held down); `sent`: the form just sent, whose
 * boxes come back empty.
 */
async function load(quiet = false, sent = null) {
  try {
    const next = await api('GET', '/api/admin/state');
    if (onLogin()) return; // logged out meanwhile
    state = next;
    redraw({ sent, background: quiet });
  } catch (err) {
    if (err.status === 401) return loggedOut();
    if (!quiet) toast(err.message, true);
  }
}

export async function bootAdmin(cfg) {
  config = cfg;
  document.title = `${config.brand} — admin`;
  for (let attempt = 0; ; attempt++) {
    try {
      state = await api('GET', '/api/admin/state');
      render();
      startTimers();
      checkConnections();
      return;
    } catch (err) {
      if (err.status === 401 || err.status === 503) return renderLogin();
      await new Promise((r) => setTimeout(r, Math.min(1500 * (attempt + 1), 8000)));
    }
  }
}
