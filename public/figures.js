// Numbers and dates as the pages print them, and what a card adds up. Nothing here touches the page, so the tests
// load this file as it is (tests/review-site-pages.test.ts).

/**
 * A number as plain decimal digits. JavaScript writes 0.0000005 as "5e-7": the copy editor filled its boxes with that,
 * then refused its own text when the copy was saved again ("Sell tip: "5e-7" is not a number"), and the dashboard
 * printed it as is. Anything that is not a number (an empty box) is returned as text.
 */
export function plain(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '');
  const s = String(v);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = '', e] = m;
  const exp = Number(e);
  // Below 0.000001: "0." and the zeros the exponent stands for, then the digits. From 1e21 up: the digits and zeros.
  return exp < 0 ? `${sign}0.${'0'.repeat(-exp - 1)}${int}${frac}` : `${sign}${int}${frac}${'0'.repeat(Math.max(0, exp - frac.length))}`;
}

/**
 * SOL to `d` decimals (2 from 100 up), "—" when it is not known. A negative amount carries the same minus sign as
 * signed() and pct(): History printed a sell as "-0.0004" next to its P/L "−0.0091".
 */
export function fmtSol(n, d = 4) {
  if (n === null || n === undefined) return '—';
  const r = Number(Number(n).toFixed(Math.abs(n) >= 100 ? 2 : d));
  return r < 0 ? `−${plain(-r)}` : plain(r);
}
/** Under half a millionth of a SOL an amount is 0: no sign, no colour. */
const TINY = 5e-7;

/**
 * A signed amount, "+1.234" / "−0.567". One too small for `d` decimals is shown with as many more as it takes (up to
 * 6), so its sign, and its colour (cls), never stand beside a bare "0": a loss of 0.0002 SOL read "−0", in red. Under
 * half a millionth it is 0. (Not a number: 0, as before.)
 */
export function signed(n, d = 4) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a < TINY) return '0';
  let dd = d;
  while (dd < 6 && a < 100 && Number(a.toFixed(dd)) === 0) dd++;
  return (v > 0 ? '+' : '−') + fmtSol(a, dd);
}

/** The colour class of an amount: up, down, or none for 0 (and for what signed() prints as 0). */
export const cls = (n) => (n >= TINY ? 'up' : n <= -TINY ? 'down' : '');
export const pct = (n) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);

/**
 * "2026-11-27", a day of the viewer's own calendar (the server works it out with their clock) → "Fri, Nov 27". It is
 * read as a calendar date, not as a moment: noon UTC is already the next day from UTC+12 on, and there every row of
 * "Profit by day" was named a day late.
 */
export function dayLabel(iso, locale) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * The words around the numbers of History's "Closed positions" heading. Its count, total and winners are of one kind
 * (real once there are real trades, test until then) while the list under it holds both, and the list may be cut: it
 * read "150 · total +1.5 SOL · 100% winners · … · the latest 200 are listed" above 200 rows, 100 of them tagged test.
 * Now the count names its kind when another kind exists or it is test ("150 real", "205 test"), and a cut list says
 * of how many and of which ("the latest 200 of 250 closed positions (real and test) are listed").
 * `h`: { trades (the count), kind ('live' | 'test'), shown (rows listed), closedAll (closed positions of both kinds) }.
 */
export function closedHeading(h) {
  const all = h.closedAll ?? h.trades;
  const mixed = all > h.trades;
  const word = !h.trades ? '' : h.kind === 'test' ? ' test' : mixed ? ' real' : '';
  const listed = h.shown < all ? `the latest ${h.shown} of ${all}${mixed ? ' closed positions (real and test)' : ''} are listed` : '';
  return { count: `${h.trades}${word}`, listed };
}

/**
 * What the "Open positions" card says about the open positions' profit: the real ones' when any is open, the test
 * ones' beside it; the test ones' alone (marked test) when nothing real is open. It added the two together: a real
 * +0.069 and a test −0.534 read "−0.4654 SOL unrealized".
 */
export function openPnl(positions) {
  const sum = (live) => positions.filter((p) => (p.mode === 'live') === live).reduce((a, p) => a + p.pnlSol, 0);
  const anyLive = positions.some((p) => p.mode === 'live');
  const anyTest = positions.some((p) => p.mode !== 'live');
  if (anyLive) return { sol: sum(true), test: false, testSol: anyTest ? sum(false) : null };
  return { sol: sum(false), test: anyTest, testSol: null };
}

/**
 * A copy's numbers on the dashboard: all of one kind, as on the profit cards (real once there are real trades), the
 * other kind's after them, apart, and each part says which kind it is: "live: 2 open · 2 closed · +0.744 SOL · test: 2
 * closed +0.959". The first part said nothing (third review): next to the server's TEST pill, real profit read as test
 * profit, and next to LIVE, test profit as real. Returns HTML (only numbers and the two words go in).
 * `st`: { kind ('live' | 'test'), open, closed, pnlSol, other: { kind, open, closed, pnlSol } }.
 */
export function copyNumbers(st) {
  const word = (k) => (k === 'live' ? 'live' : 'test');
  const n = (v) => Number(v) || 0;
  const main = `${word(st.kind)}: ${n(st.open)} open · ${n(st.closed)} closed · <span class="${cls(st.pnlSol)}">${signed(st.pnlSol, 3)} SOL</span>`;
  const o = st.other;
  if (!o || (!o.open && !o.closed)) return main;
  const parts = [o.open ? `${n(o.open)} open` : '', o.closed ? `${n(o.closed)} closed <span class="${cls(o.pnlSol)}">${signed(o.pnlSol, 3)}</span>` : ''].filter(Boolean);
  return `${main} · ${word(o.kind)}: ${parts.join(' · ')}`;
}
