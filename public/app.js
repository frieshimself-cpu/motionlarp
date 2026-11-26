// motionlarp front end: no framework, no build. State comes from /api/state every few seconds.
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const modal = $('#modal');
const toastEl = $('#toast');

let config = null;
let state = null;
let tab = 'dash';
let history = null;
let pollTimer = null;

// ── helpers ──────────────────────────────────────────────────────────────
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const fmtSol = (n, d = 4) => (n === null || n === undefined ? '—' : `${Number(n.toFixed(n >= 100 ? 2 : d))}`);
const signed = (n, d = 4) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtSol(Math.abs(n), d);
const pct = (n) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const solscanTx = (s) => `https://solscan.io/tx/${encodeURIComponent(s)}`;
const solscanAcct = (a) => `https://solscan.io/account/${encodeURIComponent(a)}`;
const pumpCoin = (m) => `https://pump.fun/coin/${encodeURIComponent(m)}`;
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const HUES = ['#ff2fb9', '#2ec8ff', '#8a5cff', '#b8ff3c', '#ff8a3c', '#3cffd2'];
function hue(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'motionlarp' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(msg, bad = false) {
  toastEl.textContent = msg;
  toastEl.className = `toast${bad ? ' bad' : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3800);
}

function marquee(lines, { big = false, crest = 'COPY CLUB' } = {}) {
  const row = (text) => `<div class="row">${[...text].map((ch) => (ch === ' ' ? '<span class="tile sp"></span>' : `<span class="tile">${esc(ch)}</span>`)).join('')}</div>`;
  return `<div class="marquee${big ? ' big' : ''}"><span class="bulbs"></span><div class="crest">${esc(crest)}</div>${lines.map(row).join('')}</div>`;
}

// ── skyline (decorative) ─────────────────────────────────────────────────
function buildSkyline() {
  const sky = $('#skyline');
  const n = Math.max(14, Math.round(window.innerWidth / 70));
  const crowns = ['#ff2fb9', '#2ec8ff', '#8a5cff', '#b8ff3c'];
  let html = '';
  for (let i = 0; i < n; i++) {
    const center = 1 - Math.abs(i - n / 2) / (n / 2);
    const h = 25 + Math.random() * 45 + center * 30;
    const lit = (0.08 + Math.random() * 0.22).toFixed(2);
    const crown = Math.random() < 0.35 ? `--crown:${crowns[i % 4]};--crown-on:1;` : '';
    html += `<div class="tower" style="height:${h.toFixed(0)}%;--lit:${lit};${crown}"></div>`;
  }
  sky.innerHTML = html;
}

// ── auth screen ──────────────────────────────────────────────────────────
function renderAuth(mode = 'login', error = '') {
  stopPolling();
  const signup = mode === 'signup';
  app.innerHTML = `
    <section class="auth"><div class="auth-inner">
      ${marquee(['MOTION', 'LARP'], { big: true, crest: 'COPY CLUB · MIAMI' })}
      <p class="tagline">Pick a wallet. <b>Copy its pump.fun trades.</b><br>Your size, your exits — while you're out.</p>
      <div class="card neon">
        <div class="tabs">
          <button class="btn ${signup ? 'ghost' : 'primary'}" data-mode="login">Log in</button>
          <button class="btn ${signup ? 'primary' : 'ghost'}" data-mode="signup">Sign up</button>
        </div>
        <form id="auth-form" autocomplete="on">
          <div class="field"><label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" required minlength="3" maxlength="24"></div>
          <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}"></div>
          ${signup && config?.signupNeedsCode ? '<div class="field"><label for="c">Invite code</label><input id="c" name="code" type="text" autocomplete="off" required><div class="hint">Ask whoever sent you the link.</div></div>' : ''}
          <button class="btn primary block" type="submit">${signup ? 'Create account' : 'Enter'}</button>
          ${error ? `<div class="err">${esc(error)}</div>` : ''}
        </form>
      </div>
    </div></section>`;
  app.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', signup ? '/api/signup' : '/api/login', Object.fromEntries(f));
      await loadState();
      startPolling();
    } catch (err) {
      renderAuth(mode, err.message);
    }
  });
}

// ── dashboard ────────────────────────────────────────────────────────────
function modePill(server) {
  if (server.mode === 'offline') return '<span class="pill test" title="No RPC configured">OFFLINE</span>';
  return server.live ? '<span class="pill live" title="Copies set to Live really trade">LIVE SERVER</span>' : '<span class="pill test" title="Everything is simulated; nothing is sent">TEST MODE</span>';
}

function render() {
  if (!state) return;
  const s = state;
  const openPnl = s.positions.reduce((a, p) => a + p.pnlSol, 0);
  const activeCopies = s.copies.filter((c) => c.enabled).length;
  const realized = s.copies.reduce((a, c) => a + c.stats.pnlSol, 0);
  app.innerHTML = `
    <header class="topbar">
      ${marquee(['MOTIONLARP'], { crest: 'COPY CLUB' })}
      <div class="right">
        ${modePill(s.server)}
        <span class="muted">@${esc(s.user.username)}</span>
        <button class="btn small ghost" id="logout">Log out</button>
      </div>
    </header>

    <div class="navtabs">
      <button class="btn small ${tab === 'dash' ? 'primary' : 'ghost'}" data-tab="dash">Dashboard</button>
      <button class="btn small ${tab === 'history' ? 'primary' : 'ghost'}" data-tab="history">History</button>
    </div>

    <section class="grid stats">
      <div class="card stat"><div class="label">Wallet</div><div class="value">${s.wallet ? `${fmtSol(s.wallet.sol ?? 0, 3)} <span class="dim" style="font-size:15px">SOL</span>` : '—'}</div><div class="sub">${s.wallet ? short(s.wallet.pubkey) : 'not imported'}</div></div>
      <div class="card stat"><div class="label">Open</div><div class="value">${s.positions.length}</div><div class="sub">positions · <span class="${cls(openPnl)}">${signed(openPnl)} SOL</span></div></div>
      <div class="card stat"><div class="label">Profit (closed)</div><div class="value ${cls(realized)}">${signed(realized, 3)}</div><div class="sub">SOL, all copies</div></div>
      <div class="card stat"><div class="label">Copying</div><div class="value">${activeCopies}</div><div class="sub">of ${s.copies.length} wallets</div></div>
    </section>

    <div id="tab-body" style="margin-top:16px">${tab === 'history' ? renderHistory() : renderDash()}</div>`;

  $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); state = null; renderAuth(); });
  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', async () => {
    tab = b.dataset.tab;
    if (tab === 'history') history = await api('GET', '/api/history').catch(() => null);
    render();
  }));
  bindDash();
}

function renderDash() {
  const s = state;
  return `<section class="grid cols">
    <div class="stack">
      ${renderWallet()}
      <div class="card neon">
        <h2>Copying <span><button class="btn small primary" id="new-copy">+ New copy</button></span></h2>
        ${s.copies.length ? s.copies.map(renderCopy).join('') : `<div class="empty"><span class="neon-word">open</span>Add a wallet to copy — paste its address, set your buy and your exits.</div>`}
      </div>
      <div class="card">
        <h2>Open positions <span class="count">${s.positions.length}</span></h2>
        ${s.positions.length ? s.positions.map(renderPosition).join('') : '<div class="empty">Nothing held right now. Copies appear here the moment a wallet you follow buys.</div>'}
      </div>
    </div>
    <div class="card">
      <h2>Live feed <span class="dim" style="letter-spacing:0;text-transform:none;font-weight:400">every buy, sell and skip</span></h2>
      ${s.events.length ? `<ul class="feed">${s.events.map(renderEvent).join('')}</ul>` : '<div class="empty">Quiet so far.</div>'}
    </div>
  </section>`;
}

function renderWallet() {
  const w = state.wallet;
  if (!w) {
    return `<div class="card neon">
      <h2>Your trading wallet</h2>
      <div class="warn" style="margin-bottom:12px">Use a <b>fresh wallet</b> holding only what you want to copy with — never your main wallet. The key is stored encrypted on the server and is never shown again.</div>
      <form id="wallet-form">
        <div class="field"><label for="wk">Private key</label><textarea id="wk" class="secret" name="key" autocomplete="off" spellcheck="false" placeholder="base58 private key, or the [12, 34, …] array from Phantom / solana-keygen" required></textarea></div>
        <button class="btn primary" type="submit">Import wallet</button>
      </form>
    </div>`;
  }
  return `<div class="card neon">
    <div class="wallet-head">
      <div>
        <h2 style="margin-bottom:8px">Your trading wallet</h2>
        <div class="sol-big">${fmtSol(w.sol ?? 0, 4)} <small>SOL</small></div>
        <div class="addr" style="margin-top:8px"><a href="${solscanAcct(w.pubkey)}" target="_blank" rel="noopener">${esc(w.pubkey)}</a></div>
        <div class="hint">Send SOL to this address to fund your copies.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small ghost" id="copy-addr">Copy address</button>
        <button class="btn small danger" id="remove-wallet">Remove</button>
      </div>
    </div>
  </div>`;
}

function sellSummary(sell) {
  const chips = [];
  if (sell.mirror.enabled) chips.push(`<span class="chip pink">sell when they sell${sell.mirror.mode === 'all' ? ' (all)' : ''}</span>`);
  if (sell.timed.length) chips.push(`<span class="chip">${sell.timed.map((t) => `${t.percent}% @${t.afterSec}s`).join(' → ')}</span>`);
  if (sell.stopLoss.length) chips.push(`<span class="chip">SL ${sell.stopLoss.map((l) => `−${l.lossPct}%→${l.percent}%`).join(', ')}</span>`);
  if (sell.deadCoin.enabled) chips.push(`<span class="chip">dead ${sell.deadCoin.idleSec}s</span>`);
  return chips.length ? chips.join('') : '<span class="chip off">no auto sells — Sell now only</span>';
}

function renderCopy(c) {
  const color = hue(c.leader);
  const initials = (c.name || c.leader).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
  const pnl = c.stats.pnlSol;
  return `<div class="copy ${c.enabled ? '' : 'paused'}">
    <div class="avatar" style="background:linear-gradient(135deg, ${color}, #1a0a33);box-shadow:0 0 18px ${color}55">${esc(initials)}</div>
    <div>
      <div class="name">${esc(c.name)} ${c.mode === 'live' ? `<span class="pill ${state.server.live ? 'live' : 'test'}">${state.server.live ? 'LIVE' : 'LIVE (server in test)'}</span>` : '<span class="pill test">TEST</span>'}</div>
      <div class="meta"><a href="${solscanAcct(c.leader)}" target="_blank" rel="noopener" class="mono">${short(c.leader)}</a> · buy <b>${c.buySol}</b> SOL when they buy ≥ <b>${c.minLeaderBuySol}</b> SOL · ${c.stats.open} open · ${c.stats.closed} done · <span class="${cls(pnl)}">${signed(pnl, 3)} SOL</span></div>
      <div style="margin-top:6px">${sellSummary(c.sell)}</div>
    </div>
    <div class="actions">
      <label class="switch" title="${c.enabled ? 'Pause' : 'Resume'}"><input type="checkbox" data-toggle="${c.id}" ${c.enabled ? 'checked' : ''} aria-label="Copy on/off"><span></span></label>
      <button class="btn small ghost" data-edit="${c.id}">Edit</button>
    </div>
  </div>`;
}

function renderPosition(p) {
  const next = p.nextTimedSell ? ` · next sell ${p.nextTimedSell.percent}% in ${p.nextTimedSell.inSec}s` : '';
  return `<div class="pos">
    <div>
      <div class="coin"><a href="${pumpCoin(p.mint)}" target="_blank" rel="noopener" class="mono">${short(p.mint)}</a> <span class="dim">via</span> ${esc(p.copyName)} ${p.mode === 'live' && state.server.live ? '<span class="pill live">LIVE</span>' : '<span class="pill test">TEST</span>'}</div>
      <div class="dim" style="font-size:12px">${p.status === 'opening' ? 'buying…' : `opened ${ago(p.openedAt)}`}${next}</div>
    </div>
    <div class="big ${cls(p.pnlSol)}">${pct(p.pnlPct)}</div>
    <div class="line"><span>cost <b class="mono">${fmtSol(p.costSol)}</b></span><span>value <b class="mono">${fmtSol(p.valueSol)}</b></span><span>sold for <b class="mono">${fmtSol(p.proceedsSol)}</b></span><span>price <b class="mono ${cls(p.pricePct)}">${pct(p.pricePct)}</b></span><span>${p.heldPct.toFixed(0)}% left</span>
      ${p.status === 'open' ? `<button class="btn small danger" style="margin-left:auto" data-sell="${p.id}">Sell now</button>` : ''}</div>
    <div class="bar"><i style="width:${Math.max(0, Math.min(100, p.heldPct))}%"></i></div>
  </div>`;
}

const ICON = { buy: '↗', sell: '↘', skip: '·', error: '!', info: 'i' };
function renderEvent(e) {
  const link = e.signature ? ` <a href="${solscanTx(e.signature)}" target="_blank" rel="noopener">tx</a>` : '';
  return `<li class="${esc(e.kind)}"><span class="ic">${ICON[e.kind] || '·'}</span><div><div class="msg">${esc(e.message)}${link}</div><div class="when">${ago(e.createdAt)}</div></div></li>`;
}

function renderHistory() {
  if (!history) return '<div class="card"><div class="empty">Loading…</div></div>';
  const h = history;
  const winRate = h.trades ? Math.round((h.wins / h.trades) * 100) : 0;
  return `<div class="card">
    <h2>Closed positions <span class="count">${h.trades}</span></h2>
    <p class="muted" style="margin-top:-4px">Total <b class="${cls(h.totalPnlSol)}">${signed(h.totalPnlSol, 4)} SOL</b> · ${h.wins} winners · ${winRate}% win rate</p>
    ${h.positions.length ? `<div class="table-wrap"><table class="hist">
      <thead><tr><th>Coin</th><th>Copy</th><th>Sells</th><th class="num">Cost</th><th class="num">Got back</th><th class="num">P/L</th><th>Closed</th></tr></thead>
      <tbody>${h.positions.map((p) => `<tr>
        <td><a class="mono" href="${pumpCoin(p.mint)}" target="_blank" rel="noopener">${short(p.mint)}</a> ${p.mode === 'live' ? '' : '<span class="chip off">test</span>'}</td>
        <td>${esc(p.copyName)}</td>
        <td>${p.fills.filter((f) => f.side === 'sell').map((f) => `<span class="chip">${esc(f.reason.replace('_', ' '))} ${fmtSol(f.sol)}${f.signature ? ` <a href="${solscanTx(f.signature)}" target="_blank" rel="noopener">↗</a>` : ''}</span>`).join('')}</td>
        <td class="num">${fmtSol(p.costSol)}</td><td class="num">${fmtSol(p.proceedsSol)}</td>
        <td class="num ${cls(p.pnlSol)}">${signed(p.pnlSol)}<br><span style="font-size:12px">${pct(p.pnlPct)}</span></td>
        <td class="dim">${p.closedAt ? ago(p.closedAt) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No closed positions yet.</div>'}
  </div>`;
}

function bindDash() {
  $('#new-copy')?.addEventListener('click', () => openEditor());
  app.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditor(state.copies.find((c) => c.id === Number(b.dataset.edit)))));
  app.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('change', async () => {
    const c = state.copies.find((x) => x.id === Number(el.dataset.toggle));
    try {
      await api('PUT', `/api/copies/${c.id}`, { ...c, enabled: el.checked });
      toast(el.checked ? `Copying ${c.name} again` : `${c.name} paused`);
      await loadState();
    } catch (err) { toast(err.message, true); el.checked = !el.checked; }
  }));
  app.querySelectorAll('[data-sell]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Sell the whole position now?')) return;
    b.disabled = true;
    b.textContent = 'Selling…';
    try { await api('POST', `/api/positions/${b.dataset.sell}/sell`); toast('Sold'); } catch (err) { toast(err.message, true); }
    await loadState();
  }));
  $('#wallet-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = new FormData(e.target).get('key');
    try {
      await api('POST', '/api/wallet', { key });
      e.target.reset();
      toast('Wallet imported');
      await loadState();
    } catch (err) { toast(err.message, true); }
  });
  $('#copy-addr')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.wallet.pubkey); toast('Address copied'); } catch { toast(state.wallet.pubkey); }
  });
  $('#remove-wallet')?.addEventListener('click', async () => {
    if (!confirm('Remove this wallet from the server? Your coins and SOL stay in it — only the server forgets the key.')) return;
    try { await api('DELETE', '/api/wallet'); toast('Wallet removed'); await loadState(); } catch (err) { toast(err.message, true); }
  });
}

// ── copy editor ──────────────────────────────────────────────────────────
function stageRow(kind, a, b, i) {
  if (kind === 'timed') {
    return `<div class="stage" data-row="timed"><span>after</span><div class="unit"><input type="number" min="0" step="1" value="${esc(a)}" data-a aria-label="seconds"><span>sec</span></div><span>sell</span><div class="unit"><input type="number" min="0.01" max="100" step="any" value="${esc(b)}" data-b aria-label="percent"><span>%</span></div><span class="dim">of what's left</span><span class="spacer"></span><button type="button" class="btn small ghost" data-remove title="Remove">✕</button></div>`;
  }
  return `<div class="stage" data-row="stop"><span>at −</span><div class="unit"><input type="number" min="1" max="99" step="any" value="${esc(a)}" data-a aria-label="loss percent"><span>%</span></div><span>sell</span><div class="unit"><input type="number" min="0.01" max="100" step="any" value="${esc(b)}" data-b aria-label="percent"><span>%</span></div><span class="dim">of what's left</span><span class="spacer"></span><button type="button" class="btn small ghost" data-remove title="Remove">✕</button></div>`;
}

function section(id, title, desc, on, body, toggle = true) {
  return `<div class="section ${on ? '' : 'off'}" data-section="${id}">
    <div class="head"><div><div class="title">${title}</div><div class="desc">${desc}</div></div>
    ${toggle ? `<label class="switch"><input type="checkbox" data-on ${on ? 'checked' : ''} aria-label="${esc(title)} on/off"><span></span></label>` : ''}</div>
    <div class="body">${body}</div></div>`;
}

function openEditor(copy) {
  const d = copy || { ...config.defaults, sell: structuredClone(config.defaults.sell) };
  const live = state.server.live;
  const card = $('.modal-card', modal);
  card.innerHTML = `
    <h3>${copy ? 'Edit' : 'New'} <em>copy</em></h3>
    <form id="copy-form" novalidate>
      <div class="row2">
        <div class="field"><label for="f-leader">Wallet to copy</label><input id="f-leader" type="text" value="${esc(d.leader)}" placeholder="Solana wallet address" autocomplete="off" spellcheck="false" required></div>
        <div class="field"><label for="f-name">Nickname</label><input id="f-name" type="text" value="${esc(d.name)}" maxlength="40" placeholder="e.g. Cupsey"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="f-buy">Your buy</label><div class="unit"><input id="f-buy" type="number" min="0.001" step="any" value="${esc(d.buySol)}"><span>SOL</span></div><div class="hint">Server limit: ${config.server.maxSolPerBuy} SOL per buy.</div></div>
        <div class="field"><label for="f-min">Only if they buy at least</label><div class="unit"><input id="f-min" type="number" min="0" step="any" value="${esc(d.minLeaderBuySol)}"><span>SOL</span></div><div class="hint">Their smaller buys are skipped.</div></div>
      </div>
      <div class="field">
        <label>Mode</label>
        <div class="seg" id="f-mode">
          <button type="button" data-v="paper" class="${d.mode !== 'live' ? 'on' : ''}">Test (nothing sent)</button>
          <button type="button" data-v="live" class="${d.mode === 'live' ? 'on' : ''}">Live (real SOL)</button>
        </div>
        <div class="hint">${live ? 'Live copies spend real SOL from your wallet.' : 'The server is in test mode: Live copies are still only simulated until the owner switches the server to live.'}</div>
      </div>

      <label style="margin-top:8px">Sell options — mix any of them. Every % is of what you still hold.</label>
      ${section('mirror', 'Sell when they sell', 'When the wallet sells, you sell too.', d.sell.mirror.enabled,
        `<div class="seg" id="f-mirror-mode"><button type="button" data-v="same" class="${d.sell.mirror.mode !== 'all' ? 'on' : ''}">Same % as them</button><button type="button" data-v="all" class="${d.sell.mirror.mode === 'all' ? 'on' : ''}">Sell everything</button></div>
         <div class="hint">"Same %": they sell 40% of their bag → you sell 40% of yours.</div>`)}
      ${section('timed', 'Timed sells', 'Sell parts of your bag after set times.', d.sell.timed.length > 0,
        `<div id="timed-rows">${(d.sell.timed.length ? d.sell.timed : [{ afterSec: 3, percent: 25 }, { afterSec: 6, percent: 50 }, { afterSec: 9, percent: 100 }]).map((t, i) => stageRow('timed', t.afterSec, t.percent, i)).join('')}</div>
         <button type="button" class="btn small ghost" data-add="timed">+ Add timed sell</button>
         <div class="presets"><span class="dim" style="font-size:12px;align-self:center">Presets:</span>
           <button type="button" class="btn small ghost" data-preset="25,50,100@3">25 / 50 / 100% every 3s</button>
           <button type="button" class="btn small ghost" data-preset="50,100@10">50 / 100% every 10s</button>
           <button type="button" class="btn small ghost" data-preset="100@30">All after 30s</button>
           <button type="button" class="btn small ghost" data-preset="33,50,100@60">Thirds every minute</button></div>`)}
      ${section('stop', 'Stop loss levels', 'Sell when the price falls below what you paid.', d.sell.stopLoss.length > 0,
        `<div id="stop-rows">${(d.sell.stopLoss.length ? d.sell.stopLoss : [{ lossPct: 30, percent: 100 }]).map((l, i) => stageRow('stop', l.lossPct, l.percent, i)).join('')}</div>
         <button type="button" class="btn small ghost" data-add="stop">+ Add level</button>`)}
      ${section('dead', 'Dead coin', 'Nobody trading it any more? Get out.', d.sell.deadCoin.enabled,
        `<div class="stage" style="grid-template-columns:auto 130px auto"><span>no trades for</span><div class="unit"><input id="f-idle" type="number" min="5" step="1" value="${esc(d.sell.deadCoin.idleSec)}"><span>sec</span></div><span>→ sell everything</span></div>`)}

      <details>
        <summary>Advanced</summary>
        <div class="row2">
          <div class="field"><label for="f-slip">Slippage</label><div class="unit"><input id="f-slip" type="number" min="0.5" max="100" step="any" value="${esc(d.slippagePct)}"><span>%</span></div></div>
          <div class="field"><label for="f-prio">Priority fee</label><div class="unit"><input id="f-prio" type="number" min="0" max="0.1" step="any" value="${esc(d.priorityFeeSol)}"><span>SOL</span></div><div class="hint">Paid per transaction; higher lands faster.</div></div>
        </div>
        <div class="field" style="display:flex;align-items:center;gap:10px"><label class="switch"><input type="checkbox" id="f-once" ${d.oncePerCoin ? 'checked' : ''}><span></span></label><span class="muted" style="font-size:14px">Buy each coin only once (wallets often buy the same coin in chunks)</span></div>
      </details>

      <div id="form-err"></div>
      <div class="modal-actions">
        <div>${copy ? '<button type="button" class="btn danger" id="delete-copy">Delete</button>' : ''}</div>
        <div style="display:flex;gap:8px"><button type="button" class="btn ghost" id="cancel">Cancel</button><button type="submit" class="btn primary">${copy ? 'Save' : 'Start copying'}</button></div>
      </div>
    </form>`;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  const form = $('#copy-form');

  const seg = (el) => el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  seg($('#f-mode'));
  seg($('#f-mirror-mode'));
  form.querySelectorAll('[data-section] [data-on]').forEach((cb) => cb.addEventListener('change', () => cb.closest('.section').classList.toggle('off', !cb.checked)));
  form.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-remove')) t.closest('.stage').remove();
    if (t.dataset.add === 'timed') $('#timed-rows').insertAdjacentHTML('beforeend', stageRow('timed', '', 100));
    if (t.dataset.add === 'stop') $('#stop-rows').insertAdjacentHTML('beforeend', stageRow('stop', '', 100));
    if (t.dataset.preset) {
      const [parts, every] = t.dataset.preset.split('@');
      $('#timed-rows').innerHTML = parts.split(',').map((p, i) => stageRow('timed', Number(every) * (i + 1), p)).join('');
    }
  });

  const close = () => { modal.hidden = true; document.body.style.overflow = ''; };
  $('#cancel').addEventListener('click', close);
  modal.onclick = (e) => { if (e.target === modal) close(); };
  document.onkeydown = (e) => { if (e.key === 'Escape' && !modal.hidden) close(); };
  $('#delete-copy')?.addEventListener('click', async () => {
    if (!confirm(`Stop copying ${copy.name}? Open positions keep their sell rules until they close.`)) return;
    try { await api('DELETE', `/api/copies/${copy.id}`); close(); toast('Copy deleted'); await loadState(); } catch (err) { toast(err.message, true); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const on = (id) => form.querySelector(`[data-section="${id}"] [data-on]`).checked;
    const rows = (sel, a, b) => [...form.querySelectorAll(sel)].map((r) => ({ [a]: Number(r.querySelector('[data-a]').value), [b]: Number(r.querySelector('[data-b]').value) })).filter((r) => !(Number.isNaN(r[a]) && Number.isNaN(r[b])));
    const body = {
      leader: $('#f-leader').value.trim(),
      name: $('#f-name').value.trim(),
      enabled: copy ? copy.enabled : true,
      mode: $('#f-mode .on').dataset.v,
      buySol: Number($('#f-buy').value),
      minLeaderBuySol: Number($('#f-min').value || 0),
      slippagePct: Number($('#f-slip').value),
      priorityFeeSol: Number($('#f-prio').value),
      oncePerCoin: $('#f-once').checked,
      sell: {
        mirror: { enabled: on('mirror'), mode: $('#f-mirror-mode .on').dataset.v },
        timed: on('timed') ? rows('[data-row="timed"]', 'afterSec', 'percent') : [],
        stopLoss: on('stop') ? rows('[data-row="stop"]', 'lossPct', 'percent') : [],
        deadCoin: { enabled: on('dead'), idleSec: Number($('#f-idle').value) },
      },
    };
    if (body.mode === 'live' && !(copy && copy.mode === 'live') && !confirm(`Live mode buys ${body.buySol} SOL with your real wallet every time ${body.name || 'this wallet'} buys. Continue?`)) return;
    try {
      if (copy) await api('PUT', `/api/copies/${copy.id}`, body);
      else await api('POST', '/api/copies', body);
      close();
      toast(copy ? 'Saved' : 'Copying started');
      await loadState();
    } catch (err) {
      $('#form-err').innerHTML = `<div class="err">${esc(err.message)}</div>`;
    }
  });
  setTimeout(() => (copy ? $('#f-buy') : $('#f-leader')).focus(), 30);
}

// ── data loop ────────────────────────────────────────────────────────────
async function loadState() {
  try {
    state = await api('GET', '/api/state');
    if (tab === 'history') history = await api('GET', '/api/history').catch(() => history);
    // Never re-draw under someone typing (the private key box above all).
    const typing = document.activeElement && app.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (modal.hidden && !typing && !$('#wk')?.value) render();
  } catch (err) {
    if (err.status === 401) { state = null; renderAuth(); return; }
    toast(err.message, true);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { if (!document.hidden) loadState(); }, 3000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function boot() {
  buildSkyline();
  try { config = await api('GET', '/api/config'); } catch { config = { signupNeedsCode: true, server: { maxSolPerBuy: 0 } }; }
  try {
    state = await api('GET', '/api/state');
    render();
    startPolling();
  } catch {
    renderAuth();
  }
}
boot();
