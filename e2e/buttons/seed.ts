// Fills a fresh SQLite file with a full site: owner settings, license keys, users with wallets, copies of every
// kind, positions in every state with their fills, and a feed with every kind of line. Everything goes in through
// the product's own modules (Store, licenses, crypto, settings validation, owner settings), in the order and shape
// the server writes them; only the clock is faked, so rows carry the times they would have had.
//
//   MASTER_KEY=<64 hex> npx tsx e2e/buttons/seed.ts <db file> <manifest json>
//
// The manifest lists what was written (raw fills in lamports, plain license keys, throwaway wallets) so the browser
// suite can work out what every page should show without asking the server.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Store } from '../../src/store.js';
import { licenseHash, newLicenseKey } from '../../src/licenses.js';
import { encryptSecret, newToken } from '../../src/crypto.js';
import { PRESETS, validateSettings, type CopySettings } from '../../src/engine/settings.js';
import { saveOwnerSettings } from '../../src/owner-settings.js';

const dbPath = resolve(process.argv[2] ?? '');
const manifestPath = resolve(process.argv[3] ?? '');
const MASTER = process.env.MASTER_KEY ?? '';
if (!process.argv[2] || !process.argv[3] || !/^[0-9a-f]{64}$/i.test(MASTER)) {
  console.error('usage: MASTER_KEY=<64 hex> npx tsx e2e/buttons/seed.ts <db file> <manifest json>');
  process.exit(2);
}
if (!dbPath.includes('/e2e/buttons/')) {
  console.error('refusing to write a database outside e2e/buttons/');
  process.exit(2);
}
for (const ext of ['', '-wal', '-shm']) if (existsSync(dbPath + ext)) rmSync(dbPath + ext);
mkdirSync(dirname(dbPath), { recursive: true });

// ── a clock the Store's own Date.now() calls follow ─────────────────────
const realNow = Date.now.bind(Date);
const NOW = realNow();
let fake: number | null = null;
Date.now = () => fake ?? realNow();
function at<T>(t: number, fn: () => T): T {
  const prev = fake;
  fake = Math.round(t);
  try { return fn(); } finally { fake = prev; }
}
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ── amounts ─────────────────────────────────────────────────────────────
/** "0.512345678" SOL → lamports, exactly. */
function L(s: string): bigint {
  const neg = s.startsWith('-');
  const [a, b = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(a || '0') * 1_000_000_000n + BigInt((b + '000000000').slice(0, 9));
  return neg ? -v : v;
}
/** Whole tokens → base units. */
const T = (whole: number, decimals = 6): bigint => BigInt(whole) * 10n ** BigInt(decimals);

// The feed lines, word for word as src/engine/engine.ts and src/http/app.ts write them today.
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
function eSol(lamports: bigint): string {
  const v = Number(lamports) / 1e9;
  return `${Number(v.toFixed(v >= 1 ? 3 : 4))} SOL`;
}
function eTokens(amount: bigint, decimals: number): string {
  const v = Number(amount) / 10 ** decimals;
  const s = (n: number) => String(Number(n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)));
  if (v >= 1e9) return `${s(v / 1e9)}B`;
  if (v >= 1e6) return `${s(v / 1e6)}M`;
  if (v >= 1e3) return `${s(v / 1e3)}K`;
  return s(v);
}
const ePct = (p: number) => `${Number(p.toFixed(p < 1 ? 2 : 1))}%`;

const pubkey = () => Keypair.generate().publicKey.toBase58();
const fakeSig = () => bs58.encode(randomBytes(64));

const store = new Store(dbPath);

// ── the timeline: everything is written in the order it would have happened ─
const ops: { t: number; run: () => void }[] = [];
const op = (t: number, run: () => void) => ops.push({ t, run });

const manifest: any = {
  seededAt: NOW,
  masterKey: MASTER,
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  owner: {}, keys: {}, users: {}, copies: [], positions: [], events: [], imports: {}, presets: PRESETS,
};

// ── owner setup (the admin page's Settings, saved the way the page saves them) ─
const feeWallet = pubkey();
const ownerCfg = { rpcUrl: '', rpcWsUrl: '', jupiterUrl: '', jupiterApiKey: '', feeBps: 0, feeWallet: '', maxSolPerBuy: 30, liveTrading: false, masterKey: MASTER };
await saveOwnerSettings(store, ownerCfg, { feePercent: 1, feeWallet, maxSolPerBuy: 5, liveTrading: false }, { balance: async () => 5_000_000_000n });
manifest.owner = { feePercent: 1, feeBps: 100, feeWallet, maxSolPerBuy: 5, liveTrading: false };

// ── license keys and users ──────────────────────────────────────────────
interface U { key: string; id: number; name: string; feeBps: number; wallet: Keypair | null }
const users: Record<string, U> = {};

function license(name: string, label: string, feeBps: number | null, createdAt: number): { id: number; key: string } {
  const key = newLicenseKey();
  const id = at(createdAt, () => store.createLicense({ keyHash: licenseHash(key), hint: key.slice(-4), label, feeBps }));
  manifest.keys[name] = { id, key, label, feeBps, hint: key.slice(-4), createdAt, status: 'unused', username: null };
  return { id, key };
}

/** What POST /api/enter does on a key's first use, and POST /api/wallet after it. */
function user(name: string, label: string, opts: { feeBps?: number | null; licensed?: boolean; wallet?: boolean; joinedAgo: number }): U {
  const joined = NOW - opts.joinedAgo;
  let lic: { id: number; key: string } | null = null;
  if (opts.licensed !== false) lic = license(name, label, opts.feeBps ?? null, joined - HOUR);
  const id = at(joined, () => store.createUser(label, `nologin:${newToken()}`));
  if (lic) {
    at(joined, () => store.redeemLicense(lic!.id, id));
    Object.assign(manifest.keys[name], { status: 'active', username: label, usedAt: joined });
  }
  let kp: Keypair | null = null;
  if (opts.wallet !== false) {
    kp = Keypair.generate();
    const w = kp;
    op(joined + 2 * MIN, () => {
      store.setWallet(id, w.publicKey.toBase58(), encryptSecret(w.secretKey, id, MASTER));
      event(u, 'info', `Wallet ${short(w.publicKey.toBase58())} imported`);
    });
  }
  const u: U = { key: name, id, name: label, feeBps: opts.feeBps ?? manifest.owner.feeBps, wallet: kp };
  users[name] = u;
  manifest.users[name] = { id, name: label, feeBps: u.feeBps, wallet: kp ? kp.publicKey.toBase58() : null, createdAt: joined, disabled: false, licensed: opts.licensed !== false };
  return u;
}

function event(u: U, kind: 'buy' | 'sell' | 'skip' | 'error' | 'info', message: string, extra: { copyId?: number; mint?: string; signature?: string | null } = {}): void {
  store.addEvent({ userId: u.id, copyId: extra.copyId ?? null, kind, message, mint: extra.mint ?? null, signature: extra.signature ?? null });
  manifest.events.push({ user: u.key, kind, message, mint: extra.mint ?? null, signature: extra.signature ?? null, at: Date.now() });
}

const alice = user('alice', 'Alice', { feeBps: 50, joinedAgo: 60 * DAY });
const bob = user('bob', 'Bob', { joinedAgo: 45 * DAY });
const carol = user('carol', 'Carol', { joinedAgo: 20 * DAY });
const dave = user('dave', 'Dave', { licensed: false, wallet: false, joinedAgo: 70 * DAY }); // an account from before license keys

// Keys nobody has used yet. "fresh*" are pasted in the browser; their labels carry markup on purpose.
license('unusedTom', 'Tom', 200, NOW - 3 * DAY);
license('revokedUnused', 'Old key', null, NOW - 9 * DAY);
license('fresh', 'Erin <i>x</i> & "co"', null, NOW - 2 * HOUR);
license('fresh2', 'Frank', 0, NOW - 2 * HOUR);
license('spare1', 'Spare one', null, NOW - 1 * HOUR);
license('spare2', 'Spare two', 150, NOW - 1 * HOUR);
license('spare3', 'Spare three', null, NOW - 1 * HOUR);

// ── copies (what POST /api/copies stores: the validated settings, plus the "Now copying" line) ─
interface C { key: string; id: number; user: U; settings: CopySettings }
const copies: Record<string, C> = {};
function copy(key: string, u: U, body: Record<string, unknown>, createdAgo: number, raw = false): C {
  const settings = (raw ? body : validateSettings(body)) as CopySettings;
  const c: C = { key, id: 0, user: u, settings };
  copies[key] = c;
  op(NOW - createdAgo, () => {
    c.id = store.createCopy(u.id, settings);
    event(u, 'info', `Now copying ${settings.name} (${short(settings.leader)}) in test mode`, { copyId: c.id });
    manifest.copies.push({ key, id: c.id, user: u.key, settings });
  });
  return c;
}

// 1. The Scharo preset exactly as PRESETS gives it (what the editor posts after one click).
copy('scharo', alice, structuredClone(PRESETS[0]!.settings), 50 * DAY);
// 2. Every sell option on; "sell when they sell" = same %, timed sells of what is left.
copy('allSame', alice, {
  leader: pubkey(), name: 'AllOn same', enabled: true, buySol: 0.5, minLeaderBuySol: 0.25, slippagePct: 30,
  priorityFeeSol: 0.0005, tipSol: 0.0001, sellPriorityFeeSol: 0.0007, sellTipSol: 0.0002, oncePerCoin: true,
  sell: {
    mirror: { enabled: true, mode: 'same' }, timedOf: 'left',
    timed: [{ afterSec: 3, percent: 25 }, { afterSec: 6, percent: 50 }, { afterSec: 9, percent: 100 }],
    stopLoss: [{ lossPct: 30, percent: 50 }, { lossPct: 60, percent: 100 }],
    deadCoin: { enabled: true, idleSec: 90 },
  },
}, 49 * DAY);
// 3. Every sell option on; "sell when they sell" = everything, timed sells of the original bag; same fees both ways.
copy('allAll', alice, {
  leader: pubkey(), name: 'AllOn all', enabled: true, buySol: 1.25, minLeaderBuySol: 0, slippagePct: 99.5,
  priorityFeeSol: 0.002, tipSol: 0, sellPriorityFeeSol: 0.002, sellTipSol: 0, oncePerCoin: false,
  sell: {
    mirror: { enabled: true, mode: 'all' }, timedOf: 'bag',
    timed: [{ afterSec: 5, percent: 50 }, { afterSec: 10, percent: 100 }],
    stopLoss: [{ lossPct: 20, percent: 30 }, { lossPct: 50, percent: 100 }],
    deadCoin: { enabled: true, idleSec: 300 },
  },
}, 48 * DAY);
// 4. Paused, and no automatic sell at all.
copy('paused', alice, {
  leader: pubkey(), name: 'Paused none', enabled: false, buySol: 0.02, minLeaderBuySol: 0.5, slippagePct: 25,
  priorityFeeSol: 0.0005, tipSol: 0, sellPriorityFeeSol: 0.0005, sellTipSol: 0, oncePerCoin: true,
  sell: { mirror: { enabled: false, mode: 'same' }, timedOf: 'left', timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } },
}, 47 * DAY);

copy('bobMain', bob, {
  leader: pubkey(), name: 'Bob main', enabled: true, buySol: 0.02, minLeaderBuySol: 0.1, slippagePct: 50,
  priorityFeeSol: 0.0005, tipSol: 0.0001, sellPriorityFeeSol: 0.0005, sellTipSol: 0.0001, oncePerCoin: true,
  sell: { mirror: { enabled: true, mode: 'all' }, timedOf: 'left', timed: [{ afterSec: 30, percent: 100 }], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } },
}, 40 * DAY);
// A copy saved by the site's first version, before tips, sell fees, "% of the bag" and "only their full exit"
// existed: stored without those fields (src/engine/settings.ts as of commit 6d50d6f).
copy('bobLegacy', bob, {
  name: 'Legacy', leader: pubkey(), enabled: true, mode: 'paper', buySol: 0.05, minLeaderBuySol: 0.5, slippagePct: 25,
  priorityFeeSol: 0.0005, oncePerCoin: true,
  sell: { mirror: { enabled: true, mode: 'same' }, timed: [{ afterSec: 10, percent: 50 }], stopLoss: [{ lossPct: 40, percent: 100 }], deadCoin: { enabled: false, idleSec: 120 } },
}, 44 * DAY, true);
copy('carolCopy', carol, {
  leader: pubkey(), name: 'Carol copy', enabled: true, buySol: 0.1, minLeaderBuySol: 0.5, slippagePct: 25,
  priorityFeeSol: 0.0005, tipSol: 0, sellPriorityFeeSol: 0.0005, sellTipSol: 0, oncePerCoin: true,
  sell: { mirror: { enabled: true, mode: 'same' }, timedOf: 'left', timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } },
}, 19 * DAY);

// ── positions, written step by step the way the engine writes them ──────
type Reason = 'timed' | 'stop_loss' | 'dead_coin' | 'mirror' | 'manual';
interface Sell { reason: Reason; tokens: bigint; lamports: bigint; fee: bigint; afterMs: number; stage?: number; percent: number; bag?: boolean; rest?: boolean }
interface PSpec {
  key: string; copy: C; mode: 'live' | 'paper'; end: 'opening' | 'open' | 'closed' | 'failed';
  /** When our buy was confirmed (the leader's trade is two seconds before). */
  boughtAgo: number;
  tokens?: bigint; decimals?: number; leaderSol?: bigint;
  buy?: { lamports: bigint; fee: bigint };
  sells?: Sell[];
  /** The last quote of the whole bag (the engine starts it at what the buy cost). */
  refValue?: bigint;
  failError?: string; failText?: string;
}

function position(spec: PSpec): void {
  const c = spec.copy;
  const u = c.user;
  const mint = pubkey();
  const decimals = spec.decimals ?? 6;
  const leaderSig = fakeSig();
  const t0 = NOW - spec.boughtAgo - 2 * SEC;
  const tc = NOW - spec.boughtAgo;
  const sim = spec.mode === 'paper';
  const label = () => `${short(mint)} (${c.settings.name})`;
  const rec: any = { key: spec.key, user: u.key, copy: c.key, copyName: c.settings.name, mint, mode: spec.mode, end: spec.end, decimals, insertedAt: t0, openedAt: spec.end === 'opening' || spec.end === 'failed' ? t0 : tc, closedAt: null, tokensBought: '0', tokensHeld: '0', refValue: null, firedTimed: [], fills: [] };
  manifest.positions.push(rec);
  let id = 0;
  op(t0, () => {
    id = store.insertPosition({ userId: u.id, copyId: c.id, mint, mode: 'live', leaderSig, sell: c.settings.sell, copyName: c.settings.name, leader: c.settings.leader, now: Date.now(), decimals });
    rec.id = id;
  });
  if (spec.end === 'opening') return;
  if (spec.end === 'failed') {
    op(t0 + 900, () => {
      const lamports = BigInt(Math.round(c.settings.buySol * 1e9));
      store.updatePosition(id, { status: 'failed', closedAt: Date.now() });
      store.insertFill({ positionId: id, userId: u.id, side: 'buy', reason: 'copy', tokens: 0n, lamports, signature: null, simulated: false, error: spec.failError ?? 'failed' });
      event(u, 'error', `Buy of ${label()} failed: ${spec.failText ?? spec.failError}`, { copyId: c.id, mint, signature: leaderSig });
      rec.closedAt = Date.now();
      rec.fills.push({ side: 'buy', reason: 'copy', tokens: '0', lamports: String(lamports), fee: '0', at: Date.now(), simulated: false, signature: null, error: spec.failError ?? 'failed' });
    });
    return;
  }
  const tokens = spec.tokens!;
  const buy = spec.buy!;
  const buySig = sim ? `PAPER_${Math.round(tc).toString(36)}` : fakeSig();
  rec.tokensBought = String(tokens);
  rec.tokensHeld = String(tokens);
  rec.refValue = String(buy.lamports);
  op(tc, () => {
    const now = Date.now();
    store.updatePosition(id, { mode: sim ? 'paper' : 'live', status: 'open', tokensBought: tokens, tokensHeld: tokens, costLamports: buy.lamports, openedAt: now, lastChangeAt: now, refValueLamports: buy.lamports, buySig });
    store.insertFill({ positionId: id, userId: u.id, side: 'buy', reason: 'copy', tokens, lamports: buy.lamports, signature: buySig, simulated: sim, error: null, feeLamports: buy.fee });
    event(u, 'buy', `Bought ${eSol(buy.lamports)} of ${label()} — they bought ${eSol(spec.leaderSol ?? L('2.5'))}${sim ? ' (test)' : ''}`, { copyId: c.id, mint, signature: sim ? null : buySig });
    rec.fills.push({ side: 'buy', reason: 'copy', tokens: String(tokens), lamports: String(buy.lamports), fee: String(buy.fee), at: now, simulated: sim, signature: buySig, error: null });
  });
  let held = tokens;
  let proceeds = 0n;
  const firedTimed: number[] = [];
  const firedStop: number[] = [];
  for (const s of spec.sells ?? []) {
    if (s.tokens > held) throw new Error(`${spec.key}: sells more than it holds`);
    held -= s.tokens;
    proceeds += s.lamports;
    const left = held;
    const total = proceeds;
    const closed = left === 0n;
    if (s.reason === 'timed' && s.stage !== undefined) firedTimed.push(s.stage);
    if (s.reason === 'stop_loss' && s.stage !== undefined) firedStop.push(s.stage);
    const ft = [...firedTimed];
    const fs = [...firedStop];
    const sig = sim ? `PAPER_${Math.round(tc + s.afterMs).toString(36)}` : fakeSig();
    op(tc + s.afterMs, () => {
      const now = Date.now();
      store.updatePosition(id, {
        tokensHeld: left, proceedsLamports: total,
        ...(closed ? { status: 'closed' as const, closedAt: now } : {}),
        ...(s.reason === 'timed' ? { firedTimed: ft } : s.reason === 'stop_loss' ? { firedStop: fs } : s.reason === 'dead_coin' ? { deadFired: true } : {}),
      });
      store.insertFill({ positionId: id, userId: u.id, side: 'sell', reason: s.reason, tokens: s.tokens, lamports: s.lamports, signature: sig, simulated: sim, error: null, feeLamports: s.fee });
      // Sent a little before it was booked: the feed line says when it was sent, the history when it was booked.
      const after = `+${((s.afterMs - 150) / 1000).toFixed(1)}s after buy`;
      const what = s.rest ? 'the rest' : s.bag ? `${ePct(s.percent)} of the bag` : s.percent >= 100 ? 'all' : ePct(s.percent);
      const reasonText = s.reason === 'timed' ? `timed sell after ${c.settings.sell.timed[s.stage ?? 0]?.afterSec ?? '?'}s`
        : s.reason === 'stop_loss' ? `stop loss at −${c.settings.sell.stopLoss[s.stage ?? 0]?.lossPct ?? '?'}%`
        : s.reason === 'dead_coin' ? `dead coin (no trades for ${c.settings.sell.deadCoin.idleSec}s)`
        : s.reason === 'mirror' ? `they sold ${s.percent >= 100 ? 'out' : `${ePct(s.percent)} of theirs`}` : 'you pressed Sell now';
      const why = s.bag || s.rest ? after : `${reasonText} · ${after}`;
      event(u, 'sell', `Sold ${what} of ${label()} for ${eSol(s.lamports)} — ${why} · ${eTokens(s.tokens, decimals)} tokens${sim ? ' (test)' : ''}${closed ? '. Position closed.' : ''}`, { copyId: c.id, mint, signature: sim ? null : sig });
      rec.fills.push({ side: 'sell', reason: s.reason, tokens: String(s.tokens), lamports: String(s.lamports), fee: String(s.fee), at: now, simulated: sim, signature: sig, error: null });
      rec.tokensHeld = String(left);
      rec.firedTimed = ft;
      if (closed) rec.closedAt = now;
    });
  }
  if ((spec.end === 'closed') !== (held === 0n)) throw new Error(`${spec.key}: end state does not match what is left`);
  if (spec.refValue !== undefined) {
    const lastSell = Math.max(0, ...(spec.sells ?? []).map((s) => s.afterMs));
    op(Math.min(NOW - 500, tc + lastSell + 20 * SEC), () => {
      store.updatePosition(id, { refValueLamports: spec.refValue!, lastChangeAt: Date.now() });
      rec.refValue = String(spec.refValue);
    });
  }
}

const sell = (reason: Reason, tokens: bigint, lamports: string, fee: string, afterMs: number, percent: number, extra: Partial<Sell> = {}): Sell => ({ reason, tokens, lamports: L(lamports), fee: L(fee), afterMs, percent, ...extra });
const { scharo, allSame, allAll, paused, bobMain, carolCopy } = copies as Record<string, C>;

// Alice, on the dashboard right now ─────────────────────────────────────
position({ key: 'P1-opening', copy: scharo!, mode: 'live', end: 'opening', boughtAgo: 20 * SEC });
position({
  key: 'P2-open-live', copy: allSame!, mode: 'live', end: 'open', boughtAgo: 5 * MIN, tokens: T(2_000_000), buy: { lamports: L('0.512345678'), fee: L('0.0025') },
  sells: [sell('timed', T(500_000), '0.14', '0.0007', 3300, 25, { stage: 0 }), sell('mirror', T(300_000), '0.081234567', '0.0004', 4900, 20)],
  refValue: L('0.6'),
});
position({
  key: 'P3-open-test', copy: allAll!, mode: 'paper', end: 'open', boughtAgo: 2 * HOUR, tokens: T(750_000), buy: { lamports: L('1.258255'), fee: L('0.00625') },
  sells: [sell('timed', T(375_000), '0.412', '0.00207', 5200, 50, { stage: 0, bag: true }), sell('stop_loss', T(112_500), '0.081', '0.0004', 61_000, 30, { stage: 0 })],
  refValue: L('0.66'),
});
position({ key: 'P4-open-live-fresh', copy: scharo!, mode: 'live', end: 'open', boughtAgo: 90 * SEC, tokens: 12_345_678_123_456n, buy: { lamports: L('7.041005'), fee: L('0.035') }, leaderSol: L('3.2') });

// Alice, closed with real money ─────────────────────────────────────────
position({
  key: 'H1-live-win-today', copy: scharo!, mode: 'live', end: 'closed', boughtAgo: 30 * MIN, tokens: T(10_000_000), buy: { lamports: L('7.041005'), fee: L('0.035') },
  sells: [sell('timed', T(4_000_000), '3.012345678', '0.0151', 2100, 40, { stage: 0, bag: true }), sell('timed', T(3_000_000), '2.25', '0.0113', 4200, 30, { stage: 1, bag: true }), sell('timed', T(3_000_000), '2.300000001', '0.0116', 6300, 100, { stage: 2, rest: true })],
});
position({
  key: 'H2-live-loss-today', copy: allSame!, mode: 'live', end: 'closed', boughtAgo: 3 * HOUR, tokens: T(1_000_000), buy: { lamports: L('0.512'), fee: L('0.0025') },
  sells: [sell('stop_loss', T(500_000), '0.17', '0.00085', 45_000, 50, { stage: 0 }), sell('stop_loss', T(500_000), '0.09', '0.00045', 80_000, 100, { stage: 1 })],
});
position({ // the last sell did not cover its own fees: NEGATIVE proceeds
  key: 'H3-live-negative-sell', copy: allSame!, mode: 'live', end: 'closed', boughtAgo: DAY + 2 * HOUR, tokens: T(40_000), buy: { lamports: L('0.020605'), fee: L('0.0001') },
  sells: [sell('timed', T(10_000), '0.0048', '0.000024', 3200, 25, { stage: 0 }), sell('mirror', T(15_000), '0.0071', '0.000036', 7400, 50), sell('manual', T(15_000), '-0.000405', '0.000001', 12 * MIN + 5 * SEC, 100)],
});
position({
  key: 'H4-live-win-3d', copy: allAll!, mode: 'live', end: 'closed', boughtAgo: 3 * DAY, tokens: T(800_000), buy: { lamports: L('1.258255'), fee: L('0.00625') },
  sells: [sell('timed', T(400_000), '0.9', '0.0045', 5100, 50, { stage: 0, bag: true }), sell('dead_coin', T(400_000), '0.75', '0.00375', 305_500, 100)],
});
position({
  key: 'H5-live-win-6d', copy: allSame!, mode: 'live', end: 'closed', boughtAgo: 6 * DAY, tokens: T(600_000), buy: { lamports: L('0.3'), fee: L('0.0015') },
  sells: [sell('mirror', T(600_000), '0.345678901', '0.0017', 33_000, 100)],
});
position({
  key: 'H6-live-loss-7d', copy: allSame!, mode: 'live', end: 'closed', boughtAgo: 7 * DAY, tokens: T(900_000), buy: { lamports: L('0.4'), fee: L('0.002') },
  sells: [sell('manual', T(900_000), '0.1', '0.0005', 2 * MIN, 100)],
});
position({
  key: 'H7-live-win-9d', copy: scharo!, mode: 'live', end: 'closed', boughtAgo: 9 * DAY, tokens: T(5_000_000), buy: { lamports: L('1'), fee: L('0.005') },
  sells: [sell('timed', T(2_000_000), '0.5', '0.0025', 2000, 40, { stage: 0, bag: true }), sell('timed', T(1_500_000), '0.4', '0.002', 4100, 30, { stage: 1, bag: true }), sell('timed', T(1_500_000), '0.3222', '0.0016', 6200, 100, { stage: 2, rest: true })],
});
position({
  key: 'H8-live-even-40d', copy: allAll!, mode: 'live', end: 'closed', boughtAgo: 40 * DAY, tokens: T(300_000), buy: { lamports: L('0.5'), fee: L('0.0025') },
  sells: [sell('timed', T(150_000), '0.3', '0.0015', 5000, 50, { stage: 0, bag: true }), sell('timed', T(150_000), '0.2', '0.001', 10_100, 100, { stage: 1, rest: true })],
});
// Alice, closed in test mode ────────────────────────────────────────────
position({
  key: 'T1-test-win-today', copy: scharo!, mode: 'paper', end: 'closed', boughtAgo: 50 * MIN, tokens: T(9_000_000), buy: { lamports: L('7.041005'), fee: L('0.035') },
  sells: [sell('timed', T(3_600_000), '3.2', '0.016', 2050, 40, { stage: 0, bag: true }), sell('timed', T(2_700_000), '2.4', '0.012', 4050, 30, { stage: 1, bag: true }), sell('timed', T(2_700_000), '2.3', '0.0115', 6050, 100, { stage: 2, rest: true })],
});
position({
  key: 'T2-test-loss-today', copy: allSame!, mode: 'paper', end: 'closed', boughtAgo: 70 * MIN, tokens: T(1_000_000), buy: { lamports: L('0.512'), fee: L('0.0025') },
  sells: [sell('timed', T(250_000), '0.1', '0.0005', 3100, 25, { stage: 0 }), sell('mirror', T(750_000), '0.288543211', '0.00145', 9000, 100)],
});
position({ // a profit too small for three decimals
  key: 'T3-test-tiny-2d', copy: allSame!, mode: 'paper', end: 'closed', boughtAgo: 2 * DAY, tokens: T(40_000), buy: { lamports: L('0.020605'), fee: L('0.0001') },
  sells: [sell('mirror', T(40_000), '0.021005', '0.0001', 15_000, 100)],
});
position({
  key: 'T4-test-loss-8d', copy: allAll!, mode: 'paper', end: 'closed', boughtAgo: 8 * DAY, tokens: T(700_000), buy: { lamports: L('1.258255'), fee: L('0.00625') },
  sells: [sell('timed', T(350_000), '0.7', '0.0035', 5050, 50, { stage: 0, bag: true }), sell('timed', T(350_000), '0.508255', '0.0025', 10_050, 100, { stage: 1, rest: true })],
});
position({ // the same day as H4: a day with both real and test trades
  key: 'T5-test-win-3d', copy: scharo!, mode: 'paper', end: 'closed', boughtAgo: 3 * DAY + 20 * MIN, tokens: T(8_000_000), buy: { lamports: L('7.041005'), fee: L('0.035') },
  sells: [sell('timed', T(3_200_000), '3', '0.015', 2000, 40, { stage: 0, bag: true }), sell('timed', T(2_400_000), '2.141005', '0.0107', 4000, 30, { stage: 1, bag: true }), sell('timed', T(2_400_000), '2', '0.01', 6000, 100, { stage: 2, rest: true })],
});
// A real trade that closed at 00:30 on 19 October 2026 for someone in Berlin: 22:30 UTC on the 18th, a week before
// the clocks went back there (so that day's offset is not today's).
{
  const closedAt = Date.UTC(2026, 9, 18, 22, 30, 0);
  if (NOW - closedAt > 2 * DAY && NOW - closedAt < 45 * DAY) {
    position({
      key: 'H9-live-dst-edge', copy: allSame!, mode: 'live', end: 'closed', boughtAgo: NOW - closedAt + 60_000, tokens: T(100_000), buy: { lamports: L('0.2'), fee: L('0.001') },
      sells: [sell('manual', T(100_000), '0.21', '0.001', 60_000, 100)],
    });
  }
}
// The same for someone in Los Angeles: 07:30 UTC on 25 October 2026 is 00:30 there, a week before the clocks went back
// (1 November); with November's offset it reads 23:30 on the 24th. Without it, the Los Angeles checks saw such a trade
// only when the suite ran between 07:00 and 08:00 UTC (the 40-day-old trade then closed at that hour).
{
  const closedAt = Date.UTC(2026, 9, 25, 7, 30, 0);
  if (NOW - closedAt > 2 * DAY && NOW - closedAt < 45 * DAY) {
    position({
      key: 'H10-live-dst-edge-la', copy: allSame!, mode: 'live', end: 'closed', boughtAgo: NOW - closedAt + 60_000, tokens: T(100_000), buy: { lamports: L('0.3'), fee: L('0.0015') },
      sells: [sell('manual', T(100_000), '0.33', '0.0015', 60_000, 100)],
    });
  }
}
// Alice, a buy that failed ──────────────────────────────────────────────
position({ key: 'F1-failed-buy', copy: allSame!, mode: 'live', end: 'failed', boughtAgo: 40 * MIN, failError: 'custom program error: 0x1772 TooMuchSolRequired', failText: 'price moved more than your slippage allows' });

// Alice's other feed lines: skips, a failed sell, a position closed because the coins were gone.
{
  const m1 = pubkey(), m2 = pubkey(), m3 = pubkey();
  op(NOW - 26 * MIN, () => event(alice, 'skip', `Skipped ${short(m1)} (Scharo): they bought 0.2 SOL, under your 1 SOL minimum`, { copyId: scharo!.id, mint: m1, signature: fakeSig() }));
  op(NOW - 25 * MIN, () => event(alice, 'skip', `Skipped ${short(m2)} (Scharo): 7 SOL is above the server limit of 5 SOL per buy`, { copyId: scharo!.id, mint: m2, signature: fakeSig() }));
  op(NOW - 24 * MIN, () => event(alice, 'skip', `Skipped ${short(m3)} (AllOn same): already traded this coin (buy once per coin is on)`, { copyId: allSame!.id, mint: m3, signature: fakeSig() }));
  op(NOW - 23 * MIN, () => event(alice, 'error', `Sell of ${short(m3)} (AllOn same) (timed sell after 6s) failed: could not reach the Solana RPC — retrying`, { copyId: allSame!.id, mint: m3 }));
  op(NOW - 22 * MIN, () => event(alice, 'info', `${short(m3)} (AllOn same): the wallet holds none of it any more (sold elsewhere?) — closed`, { copyId: allSame!.id, mint: m3 }));
  for (let i = 0; i < 14; i++) {
    const m = pubkey();
    op(NOW - 21 * MIN + i * 20 * SEC, () => event(alice, 'skip', `Skipped ${short(m)} (Scharo): they bought ${eSol(L('0.3') + BigInt(i) * 10_000_000n)}, under your 1 SOL minimum`, { copyId: scharo!.id, mint: m, signature: fakeSig() }));
  }
}

// Carol (her key is revoked below): one copy, one position still open in test mode.
position({ key: 'CAROL-open-test', copy: carolCopy!, mode: 'paper', end: 'open', boughtAgo: 10 * MIN, tokens: T(100_000), buy: { lamports: L('0.101605'), fee: L('0.001') } });

// Bob: test mode only, and more closed positions than one history page holds (205). The five oldest are the big
// winners, so a total that leaves them out is plainly different.
for (let k = 0; k < 205; k++) {
  const cost = L('0.020805');
  const back = k >= 200 ? cost + L('1') : k % 3 === 1 ? cost - L('0.0015') : k % 3 === 0 ? cost + 400_000n + BigInt(k) * 1000n : cost + L('0.002');
  position({
    key: `B${String(k).padStart(3, '0')}`, copy: bobMain!, mode: 'paper', end: 'closed', boughtAgo: 10 * MIN + k * 3 * HOUR, tokens: T(50_000), buy: { lamports: cost, fee: L('0.0002') },
    sells: [{ reason: 'timed', tokens: T(50_000), lamports: back, fee: 200_000n + BigInt(k), afterMs: 30_200, stage: 0, percent: 100 }],
  });
}

// ── write it all, oldest first ──────────────────────────────────────────
ops.sort((a, b) => a.t - b.t);
for (const o of ops) at(o.t, o.run);

// Carol's key is revoked now (the admin page's Revoke): the key is dead and her account is disabled.
at(NOW - 2 * DAY, () => store.setLicenseRevoked(manifest.keys.carol.id, true));
manifest.keys.carol.status = 'revoked';
manifest.users.carol.disabled = true;
at(NOW - 8 * DAY, () => store.setLicenseRevoked(manifest.keys.revokedUnused.id, true));
manifest.keys.revokedUnused.status = 'revoked';

// Throwaway wallets the browser imports: one as base58, one as the JSON array; and an address pasted by mistake.
{
  const a = Keypair.generate(), b = Keypair.generate(), c = Keypair.generate(), d = Keypair.generate();
  manifest.imports = {
    base58: { secret: bs58.encode(a.secretKey), pubkey: a.publicKey.toBase58() },
    json: { secret: JSON.stringify(Array.from(b.secretKey)), pubkey: b.publicKey.toBase58() },
    base58b: { secret: bs58.encode(c.secretKey), pubkey: c.publicKey.toBase58() },
    seed32: JSON.stringify(Array.from(d.secretKey.slice(0, 32))),
    address: pubkey(),
    leaders: Array.from({ length: 12 }, pubkey),
  };
  manifest.fillers = Array.from({ length: 40 }, pubkey);
}

store.close();
writeFileSync(manifestPath, JSON.stringify(manifest, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
console.log(JSON.stringify({ ok: true, db: dbPath, users: Object.keys(manifest.users).length, keys: Object.keys(manifest.keys).length, copies: manifest.copies.length, positions: manifest.positions.length, events: manifest.events.length }));
