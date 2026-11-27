'use strict';
// What every page SHOULD show, worked out from the seeded fills alone (never from the server's own sums).
//
// The rules assumed:
//   * SOL spent      = the lamports of the position's buy fill (network fee, priority fee, tip and platform fee inside).
//   * SOL returned   = the sum of its sell fills' lamports (each net of every fee; one that did not cover its fees is negative).
//   * profit         = SOL returned − SOL spent, for a closed position. A winner is a closed position with profit > 0.
//   * an open position: sold = returned so far; value = the last quote of the whole bag × tokens held / tokens bought;
//     P/L = sold + value − spent; % held = tokens held / tokens bought.
//   * "today" is the viewer's calendar day; "last 7 days" is today and the six days before it.
//   * real (live) and test trades are never added together.
const DAY = 86_400_000;

function localDate(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
const dayNumber = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
/** How the site names a day (en-US, short weekday, day, short month). */
const dayLabel = (iso, locale = 'en-US') => new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const bucket = () => ({ today: 0n, week: 0n, all: 0n, trades: 0, wins: 0, fees: 0n });

function forUser(manifest, userKey, { timeZone = 'UTC', now = Date.now() } = {}) {
  const todayIso = localDate(now, timeZone);
  const today = dayNumber(todayIso);
  const out = { todayIso, open: [], closed: [], failed: [], modes: { live: bucket(), test: bucket() }, days: [], fees: { live: 0n, test: 0n }, feesClosed: { live: 0n, test: 0n } };
  const days = new Map();
  for (const p of manifest.positions.filter((x) => x.user === userKey)) {
    const buys = p.fills.filter((f) => f.side === 'buy' && !f.error);
    const sells = p.fills.filter((f) => f.side === 'sell');
    const cost = sum(buys.map((f) => BigInt(f.lamports)));
    const returned = sum(sells.map((f) => BigInt(f.lamports)));
    const fees = sum(p.fills.map((f) => BigInt(f.fee)));
    for (const f of p.fills) out.fees[f.simulated ? 'test' : 'live'] += BigInt(f.fee);
    const mode = p.mode === 'live' ? 'live' : 'test';
    const base = { key: p.key, id: p.id, mint: p.mint, copy: p.copy, copyName: p.copyName, mode, cost, returned, fees, openedAt: p.openedAt, decimals: p.decimals };
    if (p.end === 'failed') { out.failed.push(base); continue; }
    if (p.end === 'opening' || p.end === 'open') {
      const bought = BigInt(p.tokensBought);
      const held = BigInt(p.tokensHeld);
      const value = p.refValue !== null && bought > 0n ? (BigInt(p.refValue) * held) / bought : null;
      const pnl = returned + (value ?? 0n) - cost;
      out.open.push({ ...base, status: p.end, bought, held, value, pnl, heldPct: bought > 0n ? Number((held * 1_000_000n) / bought) / 10_000 : 0, pnlPct: cost > 0n ? (Number(pnl) / Number(cost)) * 100 : 0, firedTimed: p.firedTimed });
      continue;
    }
    const pnl = returned - cost;
    const iso = localDate(p.closedAt, timeZone);
    const day = dayNumber(iso);
    const b = out.modes[mode];
    b.trades += 1;
    b.all += pnl;
    b.fees += fees;
    if (pnl > 0n) b.wins += 1;
    if (day === today) b.today += pnl;
    if (day > today - 7 && day <= today) b.week += pnl;
    out.feesClosed[mode] += fees;
    const k = `${iso}|${mode}`;
    const d = days.get(k) ?? { iso, mode, trades: 0, wins: 0, pnl: 0n };
    d.trades += 1;
    d.pnl += pnl;
    if (pnl > 0n) d.wins += 1;
    days.set(k, d);
    out.closed.push({ ...base, closedAt: p.closedAt, pnl, pnlPct: cost > 0n ? (Number(pnl) / Number(cost)) * 100 : 0, sells: sells.map((f) => ({ reason: f.reason, lamports: BigInt(f.lamports), at: f.at, afterMs: f.at - p.openedAt, simulated: f.simulated, signature: f.signature })) });
  }
  out.open.sort((a, b) => a.id - b.id);
  out.closed.sort((a, b) => b.closedAt - a.closedAt || b.id - a.id);
  out.days = [...days.values()].sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : a.mode < b.mode ? -1 : 1));
  out.primary = out.modes.live.trades > 0 ? 'live' : 'test';
  return out;
}

/** Per copy: positions open now, closed ones, and their profit by mode. */
function forCopies(manifest, userKey) {
  const out = {};
  const u = forUser(manifest, userKey);
  for (const c of manifest.copies.filter((x) => x.user === userKey)) out[c.key] = { id: c.id, settings: c.settings, open: 0, closed: 0, live: 0n, test: 0n };
  for (const p of u.open) out[p.copy].open += 1;
  for (const p of u.closed) { out[p.copy].closed += 1; out[p.copy][p.mode] += p.pnl; }
  return out;
}

/** What a copy's line on the dashboard should say about its sell rules. */
function sellTags(sell) {
  const t = [];
  const mode = sell.mirror.mode ?? 'same';
  if (sell.mirror.enabled) t.push(mode === 'exit' ? 'Sell all when they sell all' : mode === 'all' ? 'Sell when they sell · all' : 'Sell when they sell');
  if (sell.timed.length) {
    const bag = sell.timedOf === 'bag';
    t.push(sell.timed.map((x, i) => `${bag && i === sell.timed.length - 1 ? 'rest' : `${x.percent}%`} @ ${x.afterSec}s`).join(' → ') + (bag ? ' · of the bag' : ''));
  }
  if (sell.stopLoss.length) t.push(`Stop ${sell.stopLoss.map((l) => `−${l.lossPct}% → ${l.percent}%`).join(', ')}`);
  if (sell.deadCoin.enabled) t.push(`Dead coin ${sell.deadCoin.idleSec}s`);
  return t.length ? t : ['No automatic sells'];
}

function feeText(c) {
  const buy = `${c.priorityFeeSol}${c.tipSol ? ` + ${c.tipSol} tip` : ''}`;
  const sp = c.sellPriorityFeeSol ?? c.priorityFeeSol;
  const st = c.sellTipSol ?? c.tipSol;
  const sellT = `${sp}${st ? ` + ${st} tip` : ''}`;
  return buy === sellT ? `fees ${buy}` : `fees buy ${buy} · sell ${sellT}`;
}

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

module.exports = { forUser, forCopies, sellTags, feeText, short, localDate, dayNumber, dayLabel, DAY };
