// The owner's page (/admin): license keys, users, and the settings that used to live in a file on the server.
import { $, $$, app, esc, short, fmtSol, signed, cls, solscanAcct, ago, api, toast, brandHtml, modePill } from '/ui.js';

let config = null;
let state = null;
let newKey = null; // the key just created: shown once, until the page is left or another is made
let timer = null;

function renderLogin(error = '') {
  clearInterval(timer);
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
      await load();
      timer = setInterval(() => { if (!document.hidden) load(true); }, 5000);
    } catch (err) { renderLogin(err.message); }
  });
}

const STATUS = { unused: '<span class="pill">Unused</span>', active: '<span class="pill live">Active</span>', revoked: '<span class="pill off">Revoked</span>' };
const feeLabel = (l) => (l.feePercent === null ? `Default (${state.settings.feePercent}%)` : `${l.feePercent}%`);

function render() {
  const s = state;
  const st = s.settings;
  app.innerHTML = `
    <header class="topbar"><div class="topbar-in">
      ${brandHtml(config.brand)}
      <nav class="nav"><button class="on">Admin</button></nav>
      <div class="right">${modePill(s.server)}<a class="btn small ghost" href="/">Open site</a><button class="btn small ghost" id="admin-logout">Log out</button></div>
    </div></header>
    <main class="page">
      <section class="grid stats">
        <div class="card stat"><div class="label">Users</div><div class="value">${s.totals.users}</div><div class="foot">${s.licenses.filter((l) => l.status === 'unused').length} unused keys</div></div>
        <div class="card stat"><div class="label">Open positions</div><div class="value">${s.totals.open}</div><div class="foot">watching ${s.server.watching} wallets</div></div>
        <div class="card stat"><div class="label">Fees earned</div><div class="value">${fmtSol(s.totals.feesLiveSol, 4)} <small>SOL</small></div><div class="foot">real trades · test mode would have: ${fmtSol(s.totals.feesTestSol, 4)}</div></div>
        <div class="card stat"><div class="label">Trading</div><div class="value">${s.server.mode === 'offline' ? 'Offline' : s.server.live ? 'Live' : 'Test'}</div><div class="foot">${st.rpcSet ? esc(st.rpc) : 'add your Helius link below'}</div></div>
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
            <thead><tr><th>User</th><th>License</th><th>Wallet</th><th class="num">Copies</th><th class="num">Open</th><th class="num">Closed</th><th class="num">Profit</th><th class="num">Fees paid</th><th></th></tr></thead>
            <tbody>${s.users.map((u) => `<tr>
              <td><b>${esc(u.username)}</b> ${u.disabled ? '<span class="pill off">Disabled</span>' : ''}<div class="dim" style="font-size:12px">joined ${ago(u.createdAt)} · fee ${u.feePercent}%</div></td>
              <td>${u.license ? esc(u.license) : '<span class="dim">—</span>'}</td>
              <td>${u.wallet ? `<a class="mono" href="${solscanAcct(u.wallet)}" target="_blank" rel="noopener">${esc(short(u.wallet))}</a>` : '<span class="dim">none</span>'}</td>
              <td class="num">${u.copies}</td><td class="num">${u.open}</td><td class="num">${u.closed}</td>
              <td class="num ${cls(u.pnlSol)}">${signed(u.pnlSol, 3)}</td>
              <td class="num">${fmtSol(u.feesLiveSol, 4)}</td>
              <td class="right-align"><div class="actions" style="justify-content:flex-end">${u.license ? '' : `<button class="btn small" data-userkey="${u.id}" title="This account has no key yet: make one so they can get in">Create key</button>`}${u.disabled ? `<button class="btn small" data-enable="${u.id}">Enable</button>` : `<button class="btn small danger" data-disable="${u.id}">Disable</button>`}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><b>No users yet</b>Create a key above and send it to a friend: pasting it on the site is all they need to get in.</div>'}</div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Settings</h2></div>
          <form id="settings">
            <div class="setting"><div class="what"><b>Helius RPC link</b><span>The connection to Solana. Helius → RPC → "RPC URL".</span></div>
              <div><div class="hint" style="margin:0 0 6px">${st.rpcSet ? `Current: <span class="mono">${esc(st.rpc)}</span>` : 'Not set: nothing is watched or traded yet.'}</div><input id="set-rpc" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="${st.rpcSet ? 'Leave empty to keep the current link' : 'https://mainnet.helius-rpc.com/?api-key=…'}"><div class="hint">Stored encrypted, never shown again. Changing it restarts the site (a few seconds).</div></div></div>
            <div class="setting"><div class="what"><b>Jupiter API key</b><span>Optional. For coins outside pump.fun: a key from portal.jup.ag lifts the free rate limit.</span></div>
              <div><input id="set-jup" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore placeholder="${st.jupiterKeySet ? 'Set — paste a new key to replace it' : 'Optional'}"></div></div>
            <div class="setting"><div class="what"><b>Platform fee</b><span>Your cut of every buy and sell, paid inside the same transaction. A license can have its own.</span></div>
              <div class="row2"><div><label for="set-fee">Fee</label><div class="unit"><input id="set-fee" type="number" min="0" max="10" step="any" value="${esc(st.feePercent)}"><span>%</span></div></div>
              <div><label for="set-wallet">Paid to wallet</label><input id="set-wallet" type="text" autocomplete="off" spellcheck="false" value="${esc(st.feeWallet)}" placeholder="Wallet address (must hold ≥ 0.001 SOL)"></div></div></div>
            <div class="setting"><div class="what"><b>Max per buy</b><span>No single copy buy may spend more than this.</span></div>
              <div style="max-width:220px"><div class="unit"><input id="set-max" type="number" min="0.001" step="any" value="${esc(st.maxSolPerBuy)}"><span>SOL</span></div></div></div>
            <div class="setting"><div class="what"><b>Live trading</b><span>Off: everything is simulated. On: copies set to Live trade real SOL.</span></div>
              <div style="display:flex;align-items:center;gap:12px"><label class="switch"><input type="checkbox" id="set-live" ${st.liveTrading ? 'checked' : ''} aria-label="Live trading"><span></span></label><span id="live-text" class="${st.liveTrading ? 'up' : 'muted'}">${st.liveTrading ? 'Live trading is ON' : 'Test mode'}</span></div></div>
            <div class="card-body" style="border-top:1px solid var(--border);display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="btn primary" type="submit">Save settings</button><span id="settings-msg" class="muted"></span></div>
          </form>
        </div>
      </div>
    </main>`;
  bind();
}

function bind() {
  $('#admin-logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout').catch(() => {}); newKey = null; renderLogin(); });
  $('#new-license').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('#lic-label').value.trim();
    const fee = $('#lic-fee').value;
    try {
      const r = await api('POST', '/api/admin/licenses', { label, feePercent: fee === '' ? null : Number(fee) });
      newKey = { key: r.key, label };
      await load();
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
    await api('PUT', `/api/admin/licenses/${id}`, { feePercent: v.trim() === '' ? null : Number(v) });
  });
  act('[data-disable]', 'disable', async (id) => { if (confirm('Disable this user? They are logged out and get no new copies.')) await api('PUT', `/api/admin/users/${id}`, { disabled: true }); });
  act('[data-enable]', 'enable', (id) => api('PUT', `/api/admin/users/${id}`, { disabled: false }));

  $('#set-live').addEventListener('change', (e) => {
    if (e.target.checked && !confirm('Turn live trading ON? Copies set to Live will then buy and sell with real SOL.')) e.target.checked = false;
    $('#live-text').textContent = e.target.checked ? 'Live trading will be ON after saving' : 'Test mode';
  });
  $('#settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#settings-msg');
    msg.className = 'muted';
    msg.textContent = 'Saving…';
    const body = { feePercent: Number($('#set-fee').value || 0), feeWallet: $('#set-wallet').value.trim(), liveTrading: $('#set-live').checked };
    // An empty "max per buy" keeps the current value.
    if ($('#set-max').value.trim()) body.maxSolPerBuy = Number($('#set-max').value);
    // The RPC link is a link: anything else in that box (a password a browser filled in by itself) is ignored.
    const rpcBox = $('#set-rpc').value.trim();
    if (rpcBox && !/^https:\/\//.test(rpcBox)) $('#set-rpc').value = '';
    if ($('#set-rpc').value.trim()) body.rpcUrl = $('#set-rpc').value.trim();
    if ($('#set-jup').value.trim()) body.jupiterApiKey = $('#set-jup').value.trim();
    try {
      const r = await api('POST', '/api/admin/settings', body);
      if (r.restart) {
        msg.textContent = 'Saved. Restarting the site…';
        await waitForRestart();
        toast('Saved — the site is back up');
      } else {
        toast('Settings saved');
      }
      await load();
    } catch (err) {
      msg.className = 'down';
      msg.textContent = err.message;
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

async function load(quiet = false) {
  try {
    const next = await api('GET', '/api/admin/state');
    // Do not re-draw under someone typing in a form.
    const typing = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName) && app.contains(document.activeElement);
    const dirty = $$('#settings input', app).some((i) => (i.type === 'checkbox' ? i.checked !== i.defaultChecked : i.value !== i.defaultValue));
    state = next;
    if (!(quiet && (typing || dirty))) render();
  } catch (err) {
    if (err.status === 401) return renderLogin();
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
      timer = setInterval(() => { if (!document.hidden) load(true); }, 5000);
      return;
    } catch (err) {
      if (err.status === 401 || err.status === 503) return renderLogin();
      await new Promise((r) => setTimeout(r, Math.min(1500 * (attempt + 1), 8000)));
    }
  }
}
