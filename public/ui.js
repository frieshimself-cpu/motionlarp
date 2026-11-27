// Shared by the trading app (app.js) and the admin page (admin.js).
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const app = $('#app');
export const modal = $('#modal');
const toastEl = $('#toast');

/** Every string that came from a user or the server goes through this before it reaches innerHTML. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
export const fmtSol = (n, d = 4) => (n === null || n === undefined ? '—' : `${Number(Number(n).toFixed(Math.abs(n) >= 100 ? 2 : d))}`);
export const signed = (n, d = 4) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtSol(Math.abs(n), d);
export const pct = (n) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);
export const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
export const solscanTx = (s) => `https://solscan.io/tx/${encodeURIComponent(s)}`;
export const solscanAcct = (a) => `https://solscan.io/account/${encodeURIComponent(a)}`;
export const coinLink = (m) => `https://dexscreener.com/solana/${encodeURIComponent(m)}`;

export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const HUES = ['#ff4d8d', '#8b5cf6', '#38bdf8', '#2fd6a1', '#f59e0b', '#ef6cff'];
export function hue(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export async function api(method, path, body) {
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
export function toast(msg, bad = false) {
  toastEl.textContent = msg;
  toastEl.className = `toast${bad ? ' bad' : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3800);
}

export const LOGO = '<span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 6-8"/><path d="M15 6h4v4"/></svg></span>';
export const brandHtml = (name) => `<a class="brand" href="/">${LOGO}<span>${esc(name)}</span></a>`;

export function modePill(server) {
  if (server.mode === 'offline') return '<span class="pill off" title="No RPC connection set yet">OFFLINE</span>';
  return server.live ? '<span class="pill live" title="Copies trade with real SOL">LIVE</span>' : '<span class="pill test" title="Everything is simulated; nothing is sent">TEST MODE</span>';
}

export function openModal(html) {
  $('.modal-card', modal).innerHTML = html;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}
export function closeModal() {
  modal.hidden = true;
  document.body.style.overflow = '';
}
modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
