// WalletMotion front end: no framework, no build step. State comes from /api/state every few seconds.
import { $, $$, app, modal, esc, short, fmtSol, signed, pct, cls, solscanTx, solscanAcct, coinLink, ago, hue, api, toast, brandHtml, modePill, openModal, closeModal } from '/ui.js';

let config = null;
let state = null;
let tab = 'dash';
let history = null;
let pollTimer = null;

// ── sign in / sign up ────────────────────────────────────────────────────
function renderAuth(mode = 'login', error = '') {
  stopPolling();
  const signup = mode === 'signup';
  app.innerHTML = `
    <section class="auth"><div class="auth-in">
      ${brandHtml(config.brand)}
      <p class="tagline">Copy any wallet's trades. Your size, your fees, your exits.</p>
      <div class="card">
        <div class="tabs">
          <button class="${signup ? '' : 'on'}" data-mode="login">Log in</button>
          <button class="${signup ? 'on' : ''}" data-mode="signup">Sign up</button>
        </div>
        <form id="auth-form" autocomplete="on">
          <div class="field"><label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" required minlength="3" maxlength="24"></div>
          <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}"></div>
          ${signup ? '<div class="field"><label for="l">License key</label><input id="l" name="license" type="text" autocomplete="off" spellcheck="false" placeholder="WM-XXXX-XXXX-XXXX-XXXX" required><div class="hint">You get one from whoever runs this site. Each key works once.</div></div>' : ''}
          <button class="btn primary block" type="submit">${signup ? 'Create account' : 'Log in'}</button>
          ${error ? `<div class="err">${esc(error)}</div>` : ''}
        </form>
      </div>
      <div class="foot">Pump.fun, PumpSwap, Raydium, Meteora and more — routed automatically.</div>
    </div></section>`;
  $$('[data-mode]', app).forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', signup ? '/api/signup' : '/api/login', Object.fromEntries(new FormData(e.target)));
      await loadState();
      startPolling();
    } catch (err) {
      renderAuth(mode, err.message);
    }
  });
}

// ── the app shell ────────────────────────────────────────────────────────
function render() {
  if (!state) return;
  const s = state;
  const openPnl = s.positions.reduce((a, p) => a + p.pnlSol, 0);
  const realized = s.copies.reduce((a, c) => a + c.stats.pnlSol, 0);
  const activeCopies = s.copies.filter((c) => c.enabled).length;
  app.innerHTML = `
    <header class="topbar"><div class="topbar-in">
      ${brandHtml(config.brand)}
      <nav class="nav">
        <button class="${tab === 'dash' ? 'on' : ''}" data-tab="dash">Dashboard</button>
        <button class="${tab === 'history' ? 'on' : ''}" data-tab="history">History</button>
      </nav>
      <div class="right">
        ${modePill(s.server)}
        ${s.feeBps ? `<span class="pill" title="Platform fee on each buy and sell">Fee ${s.feeBps / 100}%</span>` : ''}
        <span class="who">${esc(s.user.username)}</span>
        <button class="btn small ghost" id="logout">Log out</button>
      </div>
    </div></header>
    <main class="page">
      <section class="grid stats">
        <div class="card stat"><div class="label">Wallet balance</div><div class="value">${s.wallet ? `${fmtSol(s.wallet.sol ?? 0, 3)} <small>SOL</small>` : '—'}</div><div class="foot">${s.wallet ? esc(short(s.wallet.pubkey)) : 'no wallet yet'}</div></div>
        <div class="card stat"><div class="label">Open positions</div><div class="value">${s.positions.length}</div><div class="foot"><span class="${cls(openPnl)}">${signed(openPnl)} SOL</span> unrealized</div></div>
        <div class="card stat"><div class="label">Realized profit</div><div class="value ${cls(realized)}">${signed(realized, 3)} <small>SOL</small></div><div class="foot">closed positions, fees included</div></div>
        <div class="card stat"><div class="label">Copying</div><div class="value">${activeCopies} <small>/ ${s.copies.length}</small></div><div class="foot">wallets active</div></div>
      </section>
      ${tab === 'history' ? renderHistory() : renderDash()}
    </main>`;
  $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); state = null; renderAuth(); });
  $$('[data-tab]', app).forEach((b) => b.addEventListener('click', async () => {
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
      <div class="card">
        <div class="card-head"><h2>Copies</h2><button class="btn small primary" id="new-copy">New copy</button></div>
        <div class="card-body flush">${s.copies.length ? s.copies.map(renderCopy).join('') : '<div class="empty"><b>No copies yet</b>Paste a wallet address, set your buy size, fees and sell rules.</div>'}</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Open positions<span class="sub">${s.positions.length}</span></h2></div>
        <div class="card-body flush">${s.positions.length ? s.positions.map(renderPosition).join('') : '<div class="empty"><b>Nothing open</b>A position appears the moment a wallet you copy buys.</div>'}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Activity<span class="sub">every buy, sell and skip</span></h2></div>
      <div class="card-body flush">${s.events.length ? `<ul class="feed">${s.events.map(renderEvent).join('')}</ul>` : '<div class="empty">Nothing yet.</div>'}</div>
    </div>
  </section>`;
}

function renderWallet() {
  const w = state.wallet;
  if (!w) {
    return `<div class="card">
      <div class="card-head"><h2>Trading wallet</h2></div>
      <div class="card-body">
        <div class="note" style="margin-bottom:14px">Use a <b>fresh wallet</b> that holds only what you want to trade with — never your main wallet. The key is stored encrypted and is never shown again.</div>
        <form id="wallet-form">
          <div class="field"><label for="wk">Private key</label><textarea id="wk" class="secret" name="key" autocomplete="off" spellcheck="false" placeholder="Base58 private key, or the [12, 34, …] array exported by Phantom / solana-keygen" required></textarea></div>
          <button class="btn primary" type="submit">Import wallet</button>
        </form>
      </div>
    </div>`;
  }
  return `<div class="card">
    <div class="card-head"><h2>Trading wallet</h2><div class="actions"><button class="btn small" id="copy-addr">Copy address</button><button class="btn small danger" id="remove-wallet">Remove</button></div></div>
    <div class="card-body wallet">
      <div>
        <div class="sol-big">${fmtSol(w.sol ?? 0, 4)} <small>SOL</small></div>
        <div class="addr" style="margin-top:8px"><a href="${solscanAcct(w.pubkey)}" target="_blank" rel="noopener">${esc(w.pubkey)}</a></div>
        <div class="hint">Send SOL to this address to fund your copies.</div>
      </div>
    </div>
  </div>`;
}

const feeText = (c) => {
  const buy = `${c.priorityFeeSol}${c.tipSol ? ` + ${c.tipSol} tip` : ''}`;
  const sp = c.sellPriorityFeeSol ?? c.priorityFeeSol;
  const st = c.sellTipSol ?? c.tipSol;
  const sell = `${sp}${st ? ` + ${st} tip` : ''}`;
  return buy === sell ? `fees ${buy}` : `fees buy ${buy} · sell ${sell}`;
};

function sellTags(sell) {
  const t = [];
  if (sell.mirror.enabled) t.push(`<span class="tag">Sell when they sell${sell.mirror.mode === 'all' ? ' · all' : ''}</span>`);
  if (sell.timed.length) t.push(`<span class="tag">${sell.timed.map((x) => `${x.percent}% @ ${x.afterSec}s`).join(' → ')}</span>`);
  if (sell.stopLoss.length) t.push(`<span class="tag">Stop ${sell.stopLoss.map((l) => `−${l.lossPct}% → ${l.percent}%`).join(', ')}</span>`);
  if (sell.deadCoin.enabled) t.push(`<span class="tag">Dead coin ${sell.deadCoin.idleSec}s</span>`);
  return t.length ? t.join('') : '<span class="tag off">No automatic sells</span>';
}

function renderCopy(c) {
  const color = hue(c.leader);
  const initials = (c.name || c.leader).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '··';
  const pnl = c.stats.pnlSol;
  const live = c.mode === 'live';
  return `<div class="row ${c.enabled ? '' : 'paused'}">
    <div class="avatar" style="background:${color}">${esc(initials)}</div>
    <div class="info">
      <div class="name">${esc(c.name)} ${live ? `<span class="pill ${state.server.live ? 'live' : 'test'}">${state.server.live ? 'LIVE' : 'LIVE · server in test'}</span>` : '<span class="pill test">TEST</span>'}</div>
      <div class="meta"><a href="${solscanAcct(c.leader)}" target="_blank" rel="noopener" class="mono">${esc(short(c.leader))}</a> · buy <b>${c.buySol}</b> SOL when they buy ≥ <b>${c.minLeaderBuySol}</b> SOL · ${esc(feeText(c))} SOL · slippage ${c.slippagePct}%</div>
      <div class="meta">${c.stats.open} open · ${c.stats.closed} closed · <span class="${cls(pnl)}">${signed(pnl, 3)} SOL</span></div>
      <div class="tags">${sellTags(c.sell)}</div>
    </div>
    <div class="actions">
      <label class="switch" title="${c.enabled ? 'Pause' : 'Resume'}"><input type="checkbox" data-toggle="${c.id}" ${c.enabled ? 'checked' : ''} aria-label="Copy on or off"><span></span></label>
      <button class="btn small" data-edit="${c.id}">Edit</button>
    </div>
  </div>`;
}

function renderPosition(p) {
  const next = p.nextTimedSell ? ` · next sell ${p.nextTimedSell.percent}% in ${p.nextTimedSell.inSec}s` : '';
  return `<div class="pos">
    <div class="pos-top">
      <div>
        <div class="coin"><a href="${coinLink(p.mint)}" target="_blank" rel="noopener" class="mono">${esc(short(p.mint))}</a><span class="dim">via ${esc(p.copyName)}</span>${p.mode === 'live' ? '<span class="pill live">LIVE</span>' : '<span class="pill test">TEST</span>'}</div>
        <div class="dim" style="font-size:12px;margin-top:2px">${p.status === 'opening' ? 'buying…' : `opened ${ago(p.openedAt)}`}${next}</div>
      </div>
      <div class="big ${cls(p.pnlSol)}">${pct(p.pnlPct)}</div>
    </div>
    <div class="line"><span>Cost <b>${fmtSol(p.costSol)}</b></span><span>Value <b>${fmtSol(p.valueSol)}</b></span><span>Sold <b>${fmtSol(p.proceedsSol)}</b></span><span>P/L <b class="${cls(p.pnlSol)}">${signed(p.pnlSol)}</b></span><span>${p.heldPct.toFixed(0)}% held</span>
      ${p.status === 'open' ? `<button class="btn small danger" style="margin-left:auto" data-sell="${p.id}">Sell now</button>` : ''}</div>
    <div class="bar"><i style="width:${Math.max(0, Math.min(100, p.heldPct))}%"></i></div>
  </div>`;
}

const ICON = { buy: '↗', sell: '↘', skip: '–', error: '!', info: 'i' };
function renderEvent(e) {
  const link = e.signature ? ` <a href="${solscanTx(e.signature)}" target="_blank" rel="noopener">view</a>` : '';
  return `<li class="${esc(e.kind)}"><span class="ic">${ICON[e.kind] || '·'}</span><div><div class="msg">${esc(e.message)}${link}</div><div class="when">${ago(e.createdAt)}</div></div></li>`;
}

function renderHistory() {
  if (!history) return '<div class="card"><div class="empty">Loading…</div></div>';
  const h = history;
  const winRate = h.trades ? Math.round((h.wins / h.trades) * 100) : 0;
  return `<div class="card">
    <div class="card-head"><h2>Closed positions<span class="sub">${h.trades} · total <span class="${cls(h.totalPnlSol)}">${signed(h.totalPnlSol, 4)} SOL</span> · ${winRate}% winners${h.totalFeesSol ? ` · platform fees ${fmtSol(h.totalFeesSol)} SOL` : ''}</span></h2></div>
    <div class="card-body flush">${h.positions.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Coin</th><th>Copy</th><th>Sells</th><th class="num">Cost</th><th class="num">Returned</th><th class="num">P/L</th><th>Closed</th></tr></thead>
      <tbody>${h.positions.map((p) => `<tr>
        <td><a class="mono" href="${coinLink(p.mint)}" target="_blank" rel="noopener">${esc(short(p.mint))}</a> ${p.mode === 'live' ? '' : '<span class="tag off">test</span>'}</td>
        <td>${esc(p.copyName)}</td>
        <td>${p.fills.filter((f) => f.side === 'sell').map((f) => `<span class="tag">${esc(f.reason.replace('_', ' '))} ${fmtSol(f.sol)}${f.signature ? ` <a href="${solscanTx(f.signature)}" target="_blank" rel="noopener">↗</a>` : ''}</span>`).join('')}</td>
        <td class="num">${fmtSol(p.costSol)}</td><td class="num">${fmtSol(p.proceedsSol)}</td>
        <td class="num ${cls(p.pnlSol)}">${signed(p.pnlSol)}<div style="font-size:11.5px">${pct(p.pnlPct)}</div></td>
        <td class="dim">${p.closedAt ? ago(p.closedAt) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><b>No closed positions yet</b>They show up here with every sell and the profit.</div>'}</div>
  </div>`;
}

function bindDash() {
  $('#new-copy')?.addEventListener('click', () => openEditor());
  $$('[data-edit]', app).forEach((b) => b.addEventListener('click', () => openEditor(state.copies.find((c) => c.id === Number(b.dataset.edit)))));
  $$('[data-toggle]', app).forEach((el) => el.addEventListener('change', async () => {
    const c = state.copies.find((x) => x.id === Number(el.dataset.toggle));
    try {
      await api('PUT', `/api/copies/${c.id}`, { ...c, enabled: el.checked });
      toast(el.checked ? `Copying ${c.name}` : `${c.name} paused`);
      await loadState();
    } catch (err) { toast(err.message, true); el.checked = !el.checked; }
  }));
  $$('[data-sell]', app).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Sell the whole position now?')) return;
    b.disabled = true;
    b.textContent = 'Selling…';
    try { await api('POST', `/api/positions/${b.dataset.sell}/sell`); toast('Sold'); } catch (err) { toast(err.message, true); }
    await loadState();
  }));
  $('#wallet-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/wallet', { key: new FormData(e.target).get('key') });
      e.target.reset();
      toast('Wallet imported');
      await loadState();
    } catch (err) { toast(err.message, true); }
  });
  $('#copy-addr')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.wallet.pubkey); toast('Address copied'); } catch { toast(state.wallet.pubkey); }
  });
  $('#remove-wallet')?.addEventListener('click', async () => {
    if (!confirm('Remove this wallet from the site? Your coins and SOL stay in it — only the stored key is deleted.')) return;
    try { await api('DELETE', '/api/wallet'); toast('Wallet removed'); await loadState(); } catch (err) { toast(err.message, true); }
  });
}

// ── copy editor ──────────────────────────────────────────────────────────
function stageRow(kind, a, b) {
  const first = kind === 'timed'
    ? `<span>After</span><div class="unit"><input type="number" min="0" step="1" value="${esc(a)}" data-a aria-label="seconds"><span>sec</span></div>`
    : `<span>At −</span><div class="unit"><input type="number" min="1" max="99" step="any" value="${esc(a)}" data-a aria-label="loss percent"><span>%</span></div>`;
  return `<div class="stage" data-row="${kind}">${first}<span>sell</span><div class="unit"><input type="number" min="0.01" max="100" step="any" value="${esc(b)}" data-b aria-label="percent to sell"><span>%</span></div><span class="rest dim">of what's left</span><button type="button" class="btn small ghost" data-remove aria-label="Remove">✕</button></div>`;
}

function rule(id, title, desc, on, body) {
  return `<div class="rule ${on ? '' : 'off'}" data-rule="${id}">
    <div class="head"><div><div class="t">${title}</div><div class="d">${desc}</div></div>
    <label class="switch"><input type="checkbox" data-on ${on ? 'checked' : ''} aria-label="${esc(title)} on or off"><span></span></label></div>
    <div class="body">${body}</div></div>`;
}

const FEE_PRESETS = { eco: [0.0001, 0], fast: [0.001, 0.001], turbo: [0.003, 0.005] };

function openEditor(copy) {
  const d = copy || { ...config.defaults, sell: structuredClone(config.defaults.sell) };
  const live = state.server.live;
  const sp = d.sellPriorityFeeSol ?? d.priorityFeeSol;
  const st = d.sellTipSol ?? d.tipSol ?? 0;
  openModal(`
    <form id="copy-form" novalidate>
    <div class="modal-head"><h3>${copy ? `Edit ${esc(copy.name)}` : 'New copy'}</h3><button type="button" class="btn small ghost" id="cancel-x" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="group">
        <div class="title">Who and how much</div>
        <div class="row2">
          <div class="field"><label for="f-leader">Wallet to copy</label><input id="f-leader" type="text" value="${esc(d.leader)}" placeholder="Solana wallet address" autocomplete="off" spellcheck="false" required></div>
          <div class="field"><label for="f-name">Nickname</label><input id="f-name" type="text" value="${esc(d.name)}" maxlength="40" placeholder="Optional"></div>
        </div>
        <div class="row2">
          <div class="field"><label for="f-buy">Your buy</label><div class="unit"><input id="f-buy" type="number" min="0.001" step="any" value="${esc(d.buySol)}"><span>SOL</span></div><div class="hint">Site limit ${config.server.maxSolPerBuy} SOL per buy${state.feeBps ? ` · platform fee ${state.feeBps / 100}%` : ''}</div></div>
          <div class="field"><label for="f-min">Only when they buy at least</label><div class="unit"><input id="f-min" type="number" min="0" step="any" value="${esc(d.minLeaderBuySol)}"><span>SOL</span></div><div class="hint">Their smaller buys are skipped.</div></div>
        </div>
      </div>

      <div class="group">
        <div class="title">Trading fees <span class="presets"><button type="button" class="btn small ghost" data-fee="eco">Eco</button><button type="button" class="btn small ghost" data-fee="fast">Fast</button><button type="button" class="btn small ghost" data-fee="turbo">Turbo</button></span></div>
        <div class="row4">
          <div class="field"><label for="f-prio">Buy priority fee</label><div class="unit"><input id="f-prio" type="number" min="0" max="0.1" step="any" value="${esc(d.priorityFeeSol)}"><span>SOL</span></div></div>
          <div class="field"><label for="f-tip">Buy tip</label><div class="unit"><input id="f-tip" type="number" min="0" max="0.5" step="any" value="${esc(d.tipSol ?? 0)}"><span>SOL</span></div></div>
          <div class="field"><label for="f-sprio">Sell priority fee</label><div class="unit"><input id="f-sprio" type="number" min="0" max="0.1" step="any" value="${esc(sp)}"><span>SOL</span></div></div>
          <div class="field"><label for="f-stip">Sell tip</label><div class="unit"><input id="f-stip" type="number" min="0" max="0.5" step="any" value="${esc(st)}"><span>SOL</span></div></div>
        </div>
        <div class="row2">
          <div class="field"><label for="f-slip">Slippage</label><div class="unit"><input id="f-slip" type="number" min="0.5" max="100" step="any" value="${esc(d.slippagePct)}"><span>%</span></div></div>
          <div class="hint" style="align-self:center">Priority fee: paid to the network on every transaction. Tip: an extra payment to land sooner (sent through Jito); 0 for none. Higher lands faster.</div>
        </div>
      </div>

      <div class="group">
        <div class="title">Sell rules <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">every % is of what you still hold</span></div>
        ${rule('mirror', 'Sell when they sell', 'When the wallet sells, you sell.', d.sell.mirror.enabled,
          `<div class="seg" id="f-mirror-mode"><button type="button" data-v="same" class="${d.sell.mirror.mode !== 'all' ? 'on' : ''}">Same % as them</button><button type="button" data-v="all" class="${d.sell.mirror.mode === 'all' ? 'on' : ''}">Sell everything</button></div>
           <div class="hint">Same %: they sell 40% of their bag, you sell 40% of yours.</div>`)}
        ${rule('timed', 'Timed sells', 'Sell parts of your bag after set times.', d.sell.timed.length > 0,
          `<div id="timed-rows">${(d.sell.timed.length ? d.sell.timed : [{ afterSec: 3, percent: 25 }, { afterSec: 6, percent: 50 }, { afterSec: 9, percent: 100 }]).map((t) => stageRow('timed', t.afterSec, t.percent)).join('')}</div>
           <div class="presets"><button type="button" class="btn small" data-add="timed">Add step</button><span class="dim" style="font-size:12px">Presets</span>
             <button type="button" class="btn small ghost" data-preset="25,50,100@3">25/50/100% every 3s</button>
             <button type="button" class="btn small ghost" data-preset="50,100@10">50/100% every 10s</button>
             <button type="button" class="btn small ghost" data-preset="100@30">All after 30s</button></div>`)}
        ${rule('stop', 'Stop loss', 'Sell when the price falls below what you paid.', d.sell.stopLoss.length > 0,
          `<div id="stop-rows">${(d.sell.stopLoss.length ? d.sell.stopLoss : [{ lossPct: 30, percent: 100 }]).map((l) => stageRow('stop', l.lossPct, l.percent)).join('')}</div>
           <button type="button" class="btn small" data-add="stop">Add level</button>`)}
        ${rule('dead', 'Dead coin', 'Nobody is trading it any more: get out.', d.sell.deadCoin.enabled,
          `<div class="stage" style="grid-template-columns:auto 120px auto"><span>No trades for</span><div class="unit"><input id="f-idle" type="number" min="5" step="1" value="${esc(d.sell.deadCoin.idleSec)}"><span>sec</span></div><span>→ sell everything</span></div>`)}
      </div>

      <div class="group" style="margin-bottom:0">
        <div class="title">Mode</div>
        <div class="seg" id="f-mode">
          <button type="button" data-v="paper" class="${d.mode !== 'live' ? 'on' : ''}">Test — nothing is sent</button>
          <button type="button" data-v="live" class="${d.mode === 'live' ? 'on' : ''}">Live — real SOL</button>
        </div>
        <div class="hint">${live ? 'Live copies spend real SOL from your wallet.' : 'The site is in test mode: Live copies are still only simulated until the owner turns live trading on.'}</div>
        <label style="display:flex;align-items:center;gap:10px;margin:14px 0 0;color:var(--text);font-size:13.5px"><span class="switch"><input type="checkbox" id="f-once" ${d.oncePerCoin ? 'checked' : ''}><span></span></span>Buy each coin only once</label>
      </div>
      <div id="form-err"></div>
    </div>
    <div class="modal-foot">
      <div>${copy ? '<button type="button" class="btn danger" id="delete-copy">Delete</button>' : ''}</div>
      <div style="display:flex;gap:8px"><button type="button" class="btn" id="cancel">Cancel</button><button type="submit" class="btn primary">${copy ? 'Save changes' : 'Start copying'}</button></div>
    </div>
    </form>`);
  const form = $('#copy-form');
  const seg = (el) => $$('button', el).forEach((b) => b.addEventListener('click', () => $$('button', el).forEach((x) => x.classList.toggle('on', x === b))));
  seg($('#f-mode'));
  seg($('#f-mirror-mode'));
  $$('[data-rule] [data-on]', form).forEach((cb) => cb.addEventListener('change', () => cb.closest('.rule').classList.toggle('off', !cb.checked)));
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
    if (t.dataset.fee) {
      const [prio, tip] = FEE_PRESETS[t.dataset.fee];
      $('#f-prio').value = prio; $('#f-sprio').value = prio; $('#f-tip').value = tip; $('#f-stip').value = tip;
    }
  });
  $('#cancel').addEventListener('click', closeModal);
  $('#cancel-x').addEventListener('click', closeModal);
  $('#delete-copy')?.addEventListener('click', async () => {
    if (!confirm(`Stop copying ${copy.name}? Open positions keep their sell rules until they close.`)) return;
    try { await api('DELETE', `/api/copies/${copy.id}`); closeModal(); toast('Copy deleted'); await loadState(); } catch (err) { toast(err.message, true); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const on = (id) => $(`[data-rule="${id}"] [data-on]`, form).checked;
    const rows = (sel, a, b) => $$(sel, form).map((r) => ({ [a]: Number($('[data-a]', r).value), [b]: Number($('[data-b]', r).value) }));
    const body = {
      leader: $('#f-leader').value.trim(),
      name: $('#f-name').value.trim(),
      enabled: copy ? copy.enabled : true,
      mode: $('#f-mode .on').dataset.v,
      buySol: Number($('#f-buy').value),
      minLeaderBuySol: Number($('#f-min').value || 0),
      slippagePct: Number($('#f-slip').value),
      priorityFeeSol: Number($('#f-prio').value),
      tipSol: Number($('#f-tip').value || 0),
      sellPriorityFeeSol: Number($('#f-sprio').value),
      sellTipSol: Number($('#f-stip').value || 0),
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
      closeModal();
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
  for (let attempt = 0; !config; attempt++) {
    try { config = await api('GET', '/api/config'); } catch {
      app.innerHTML = '<section class="auth"><div class="auth-in"><p class="tagline">Reconnecting…</p></div></section>';
      await new Promise((r) => setTimeout(r, Math.min(1500 * (attempt + 1), 8000)));
    }
  }
  document.title = `${config.brand} — copy trading`;
  if (location.pathname.startsWith('/admin')) {
    const { bootAdmin } = await import('/admin.js');
    return bootAdmin(config);
  }
  // Only "not logged in" shows the login form. Anything else (the site restarting for an update, a network blip)
  // waits and tries again, so nobody is thrown out of a session that is still good.
  for (let attempt = 0; ; attempt++) {
    try {
      state = await api('GET', '/api/state');
      render();
      startPolling();
      return;
    } catch (err) {
      if (err.status === 401) return renderAuth();
      app.innerHTML = `<section class="auth"><div class="auth-in">${brandHtml(config.brand)}<p class="tagline">Reconnecting…</p></div></section>`;
      await new Promise((r) => setTimeout(r, Math.min(1500 * (attempt + 1), 8000)));
    }
  }
}
boot();
