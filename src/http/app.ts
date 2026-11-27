// The website's server: JSON API under /api, the static site from public/. Sessions are an HttpOnly cookie holding
// a random token (stored hashed). Mutating calls need the X-Requested-With header (a cross-site form cannot send it).
// Wallet keys go in once and never come back out.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Keypair } from '@solana/web3.js';
import { lamportsToSol } from '../config.js';
import { timingSafeEqual } from 'node:crypto';
import { encryptSecret, newToken, sha256 } from '../crypto.js';
import { licenseHash, newLicenseKey } from '../licenses.js';
import { pnlSummary } from '../pnl.js';
import type { Engine } from '../engine/engine.js';
import type { Executor } from '../engine/executor.js';
import { lossPercent } from '../engine/rules.js';
import { SettingsError, validateSettings, defaultSettings, LIMITS, PRESETS } from '../engine/settings.js';
import { log, safeErrorMessage } from '../log.js';
import type { Position, Store } from '../store.js';
import { parseSecretKey, WalletKeyError } from '../wallets.js';

export interface AppDeps {
  store: Store;
  engine: Engine;
  executor: Executor;
  masterKey: string;
  secureCookies: boolean;
  /** Opens /admin. Empty = the admin area is closed. */
  adminPassword?: string;
  /** The owner's settings (admin page): a masked view, saving, and restarting the server. */
  owner?: { view: () => object; save: (patch: Record<string, unknown>) => Promise<{ restart: boolean }>; restart: () => void; connections?: () => Promise<object> };
  brand?: string;
  /** Forget the cached keypair of a user (after a wallet change). */
  forgetWallet: (userId: number) => void;
  serverInfo: () => { version?: string; live: boolean; maxSolPerBuy: number; watching: number; mode: string; sender?: string; feed?: string; keys?: string; health?: string; sends?: string };
  trustProxy?: boolean;
  /** Platform fee (basis points) this user pays. */
  feeBpsFor?: (userId: number) => number;
  maxCopiesPerUser?: number;
  publicDir?: string;
}

const COOKIE = 'ml_session';
const ADMIN_COOKIE = 'ml_admin';
const ADMIN_DAYS = 30;
const SESSION_DAYS = 90; // from the last visit: a session renews itself while it is used
const MAX_BODY = 64 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  // Only scripts served by this site run (no inline script, no third-party script): injected markup cannot run code.
  'content-security-policy': "default-src 'self'; script-src 'self'; object-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sol = (l: bigint) => Number(lamportsToSol(l).toFixed(9));

/** Fixed-window limiter for login attempts. Only FAILED attempts count: a trader who logs in from a phone, a laptop and
 *  a desk with the right key must never be told "too many attempts". */
class Limiter {
  private readonly hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    return !!h && h.until >= Date.now() && h.n >= this.max;
  }
  fail(key: string): void {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until < now) this.hits.set(key, { n: 1, until: now + this.windowMs });
    else h.n += 1;
    if (this.hits.size > 10_000) this.hits.clear();
  }
}

export function positionView(p: Position) {
  const valueLamports = p.refValueLamports !== null && p.tokensBought > 0n ? (p.refValueLamports * p.tokensHeld) / p.tokensBought : null;
  const costOfHeld = p.tokensBought > 0n ? (p.costLamports * p.tokensHeld) / p.tokensBought : 0n;
  const pnlLamports = p.proceedsLamports + (valueLamports ?? costOfHeld) - p.costLamports;
  const now = Date.now();
  const nextTimed = p.sell.timed.map((t, i) => ({ ...t, i })).filter((t) => !p.firedTimed.includes(t.i)).sort((a, b) => a.afterSec - b.afterSec)[0];
  return {
    id: p.id,
    copyId: p.copyId,
    copyName: p.copyName,
    leader: p.leader,
    mint: p.mint,
    mode: p.mode,
    status: p.status,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    costSol: sol(p.costLamports),
    proceedsSol: sol(p.proceedsLamports),
    valueSol: valueLamports === null ? null : sol(valueLamports),
    heldPct: p.tokensBought > 0n ? Number((p.tokensHeld * 10_000n) / p.tokensBought) / 100 : 0,
    pnlSol: sol(pnlLamports),
    pnlPct: p.costLamports > 0n ? (Number(pnlLamports) / Number(p.costLamports)) * 100 : 0,
    pricePct: (() => { const l = lossPercent(p); return l === null ? null : -l; })(),
    nextTimedSell: nextTimed ? { atMs: p.openedAt + nextTimed.afterSec * 1000, percent: nextTimed.percent, inSec: Math.max(0, Math.round((p.openedAt + nextTimed.afterSec * 1000 - now) / 1000)) } : null,
    buySig: p.buySig,
  };
}

export function createApp(deps: AppDeps): Server {
  const { store } = deps;
  const publicDir = deps.publicDir ?? PUBLIC_DIR;
  const authLimiter = new Limiter(10, 10 * 60_000);
  const balanceCache = new Map<number, { at: number; sol: number | null }>();

  function clientIp(req: IncomingMessage): string {
    const fwd = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    return fwd || req.socket.remoteAddress || '';
  }

  function userId(req: IncomingMessage): number | null {
    const token = cookies(req)[COOKIE];
    return token ? store.sessionUser(sha256(token)) : null;
  }

  function requireUser(req: IncomingMessage): number {
    const id = userId(req);
    if (id === null || store.user(id)?.disabled !== false) throw new HttpError(401, 'please log in');
    return id;
  }

  // ── admin: a password only the owner has; its own short-lived cookie ──
  const adminLimiter = new Limiter(5, 15 * 60_000);

  function isAdmin(req: IncomingMessage): boolean {
    const token = cookies(req)[ADMIN_COOKIE];
    if (!token) return false;
    return store.adminSessionValid(sha256(token));
  }

  function passwordMatches(given: string): boolean {
    const want = deps.adminPassword ?? '';
    const a = Buffer.from(sha256(given));
    const b = Buffer.from(sha256(want));
    return !!want && timingSafeEqual(a, b);
  }

  const feePercentOf = (bps: number | null) => (bps === null ? null : bps / 100);
  function parseFeePercent(v: unknown): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null; // null = use the site's default fee
    const pct = Number(v);
    if (!(pct >= 0 && pct <= 10)) throw new HttpError(400, 'a license fee must be between 0 and 10 %');
    return Math.round(pct * 100);
  }

  function adminState() {
    const users = store.users();
    const active = store.activePositions();
    const rows = users.map((u) => {
      const closed = store.closedPositions(u.id, 5000);
      const fills = store.userFees(u.id);
      return {
        id: u.id, username: u.username, createdAt: u.createdAt, disabled: u.disabled,
        license: store.userLicense(u.id)?.label ?? null,
        feePercent: (deps.feeBpsFor?.(u.id) ?? 0) / 100,
        wallet: store.wallet(u.id)?.pubkey ?? null,
        copies: store.copies(u.id).filter((c) => c.settings.enabled).length,
        open: active.filter((p) => p.userId === u.id).length,
        closed: closed.length,
        pnlSol: sol(closed.reduce((a, p) => a + (p.proceedsLamports - p.costLamports), 0n)),
        feesLiveSol: sol(fills.live), feesTestSol: sol(fills.test),
      };
    });
    return {
      server: deps.serverInfo(),
      settings: deps.owner?.view() ?? {},
      licenses: store.licenses().map((l) => ({ id: l.id, label: l.label, hint: l.hint, feePercent: feePercentOf(l.feeBps), createdAt: l.createdAt, usedAt: l.usedAt, username: l.username, status: l.revoked ? 'revoked' : l.usedBy !== null ? 'active' : 'unused' })),
      users: rows,
      totals: { users: users.length, open: active.length, feesLiveSol: rows.reduce((a, r) => a + r.feesLiveSol, 0), feesTestSol: rows.reduce((a, r) => a + r.feesTestSol, 0) },
    };
  }

  async function adminRoute(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    if (path === '/api/admin/login' && method === 'POST') {
      if (!deps.adminPassword) throw new HttpError(503, 'the admin area is not set up on this server (no ADMIN_PASSWORD)');
      const who = `admin:${clientIp(req)}`;
      if (adminLimiter.blocked(who)) throw new HttpError(429, 'too many attempts, try again in 15 minutes');
      const b = await readJson(req);
      if (!passwordMatches(String(b.password ?? ''))) { adminLimiter.fail(who); throw new HttpError(401, 'wrong password'); }
      const token = newToken();
      store.createAdminSession(sha256(token), Date.now() + ADMIN_DAYS * 86_400_000);
      res.setHeader('set-cookie', `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_DAYS * 86_400}${deps.secureCookies ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    if (!isAdmin(req)) throw new HttpError(401, 'admin login needed');
    if (path === '/api/admin/logout' && method === 'POST') {
      store.deleteAdminSession(sha256(cookies(req)[ADMIN_COOKIE] ?? ''));
      res.setHeader('set-cookie', `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/admin/state' && method === 'GET') return json(res, 200, adminState());

    if (path === '/api/admin/licenses' && method === 'POST') {
      const b = await readJson(req);
      const label = String(b.label ?? '').trim().slice(0, 40);
      if (!label) throw new HttpError(400, 'give the key a name (who it is for)');
      const feeBps = parseFeePercent(b.feePercent) ?? null;
      const key = newLicenseKey();
      const id = store.createLicense({ keyHash: licenseHash(key), hint: key.slice(-4), label, feeBps });
      return json(res, 200, { ok: true, id, key }); // the only time the key is shown
    }
    const reissue = /^\/api\/admin\/licenses\/(\d+)\/reissue$/.exec(path);
    if (reissue && method === 'POST') {
      const key = newLicenseKey();
      if (!store.rekeyLicense(Number(reissue[1]), licenseHash(key), key.slice(-4))) throw new HttpError(404, 'no such key');
      return json(res, 200, { ok: true, key });
    }
    const userKey = /^\/api\/admin\/users\/(\d+)\/key$/.exec(path);
    if (userKey && method === 'POST') {
      const uid = Number(userKey[1]);
      const user = store.user(uid);
      if (!user) throw new HttpError(404, 'no such user');
      const key = newLicenseKey();
      const existing = store.userLicense(uid);
      if (existing) store.rekeyLicense(existing.id, licenseHash(key), key.slice(-4));
      else store.redeemLicense(store.createLicense({ keyHash: licenseHash(key), hint: key.slice(-4), label: user.username.slice(0, 40), feeBps: null }), uid);
      return json(res, 200, { ok: true, key });
    }
    const lic = /^\/api\/admin\/licenses\/(\d+)$/.exec(path);
    if (lic && method === 'PUT') {
      const id = Number(lic[1]);
      const b = await readJson(req);
      const feeBps = parseFeePercent(b.feePercent);
      store.updateLicense(id, { ...(typeof b.label === 'string' && b.label.trim() ? { label: b.label.trim().slice(0, 40) } : {}), ...(feeBps !== undefined ? { feeBps } : {}) });
      if (typeof b.revoked === 'boolean') store.setLicenseRevoked(id, b.revoked);
      return json(res, 200, { ok: true });
    }
    if (lic && method === 'DELETE') {
      if (!store.deleteLicense(Number(lic[1]))) throw new HttpError(409, 'this key is in use: revoke it instead');
      return json(res, 200, { ok: true });
    }
    const usr = /^\/api\/admin\/users\/(\d+)$/.exec(path);
    if (usr && method === 'PUT') {
      const b = await readJson(req);
      // A user whose key is revoked cannot log in: enabling them would only have the server copy trades for them again.
      if (b.disabled === false && store.userLicense(Number(usr[1]))?.revoked) throw new HttpError(409, 'their key is revoked: restore their key first (that enables them too)');
      if (typeof b.disabled === 'boolean') store.setUserDisabled(Number(usr[1]), b.disabled);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/admin/connections' && method === 'GET') {
      if (!deps.owner?.connections) throw new HttpError(503, 'connection checks are not available');
      return json(res, 200, await deps.owner.connections());
    }
    if (path === '/api/admin/settings' && method === 'POST') {
      if (!deps.owner) throw new HttpError(503, 'settings are not available');
      const b = await readJson(req);
      let result: { restart: boolean };
      try {
        result = await deps.owner.save(b);
      } catch (err) {
        if (err instanceof Error && err.name === 'OwnerSettingsError') throw new HttpError(400, err.message);
        throw err;
      }
      json(res, 200, { ok: true, restart: result.restart });
      if (result.restart) setTimeout(() => deps.owner?.restart(), 10);
      return;
    }
    throw new HttpError(404, 'not found');
  }

  const sessionCookie = (token: string) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}${deps.secureCookies ? '; Secure' : ''}`;

  function setSession(res: ServerResponse, uid: number): void {
    const token = newToken();
    store.createSession(sha256(token), uid, Date.now() + SESSION_DAYS * 86_400_000);
    res.setHeader('set-cookie', sessionCookie(token));
  }

  /** Called on the page's regular refresh: once a day at most, push the session's end 90 days out again. */
  function renewSession(req: IncomingMessage, res: ServerResponse): void {
    const token = cookies(req)[COOKIE];
    if (!token) return;
    const expiry = store.sessionExpiry(sha256(token));
    if (expiry === null || expiry - Date.now() > (SESSION_DAYS - 1) * 86_400_000) return;
    store.extendSession(sha256(token), Date.now() + SESSION_DAYS * 86_400_000);
    res.setHeader('set-cookie', sessionCookie(token));
  }

  async function walletSol(uid: number, pubkey: string): Promise<number | null> {
    const hit = balanceCache.get(uid);
    if (hit && Date.now() - hit.at < 10_000) return hit.sol;
    let value: number | null = null;
    try {
      value = sol(await deps.executor.solBalance(pubkey));
    } catch {
      value = hit?.sol ?? null;
    }
    balanceCache.set(uid, { at: Date.now(), sol: value });
    return value;
  }

  function copyStats(uid: number) {
    const stats = new Map<number, { open: number; closed: number; pnlSol: number }>();
    const bump = (id: number) => stats.get(id) ?? stats.set(id, { open: 0, closed: 0, pnlSol: 0 }).get(id)!;
    for (const p of store.activePositions(uid)) bump(p.copyId).open++;
    for (const p of store.closedPositions(uid, 1000)) {
      const s = bump(p.copyId);
      s.closed++;
      s.pnlSol += sol(p.proceedsLamports - p.costLamports);
    }
    return stats;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/')) return serveStatic(path, res);
    if (method !== 'GET' && req.headers['x-requested-with'] !== 'motionlarp') throw new HttpError(403, 'missing request header');

    if (path.startsWith('/api/admin/')) return adminRoute(req, res, path, method);

    // ── accounts ──
    // The license key is the login: its first use opens the account (named after the key), later uses return to it.
    if (path === '/api/enter' && method === 'POST') {
      const who = `enter:${clientIp(req)}`;
      if (authLimiter.blocked(who)) throw new HttpError(429, 'too many attempts, try again in a few minutes');
      const b = await readJson(req);
      const license = store.licenseByHash(licenseHash(String(b.license ?? '')));
      if (!license) { authLimiter.fail(who); throw new HttpError(403, 'that license key is not valid'); }
      if (license.revoked) { authLimiter.fail(who); throw new HttpError(403, 'this license key was revoked: ask the owner'); }
      let uid = license.usedBy;
      if (uid === null) {
        // Unique account name from the key's label; the password slot is filled with random bytes (never used).
        let name = license.label;
        if (store.userByName(name)) name = `${license.label} #${license.id}`;
        uid = store.createUser(name, `nologin:${newToken()}`);
        if (!store.redeemLicense(license.id, uid)) {
          store.deleteUser(uid); // the same key was entered twice in the same instant: use the account that won
          uid = store.licenseByHash(licenseHash(String(b.license ?? '')))?.usedBy ?? null;
          if (uid === null) throw new HttpError(403, 'that license key is not valid');
        }
      }
      const user = store.user(uid);
      if (!user || user.disabled) throw new HttpError(403, 'this account is disabled: ask the owner');
      setSession(res, uid);
      return json(res, 200, { ok: true, username: user.username });
    }
    if (path === '/api/logout' && method === 'POST') {
      const token = cookies(req)[COOKIE];
      if (token) store.deleteSession(sha256(token));
      res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/config' && method === 'GET') {
      return json(res, 200, { brand: deps.brand ?? 'WalletMotion', adminEnabled: !!deps.adminPassword, defaults: defaultSettings(), presets: PRESETS, limits: LIMITS, server: deps.serverInfo() });
    }

    const uid = requireUser(req);

    // ── wallet ──
    if (path === '/api/wallet' && method === 'POST') {
      if (store.activePositions(uid).length) throw new HttpError(409, 'sell your open positions before changing wallet');
      const b = await readJson(req);
      let kp: Keypair;
      try {
        kp = parseSecretKey(String(b.key ?? ''));
      } catch (err) {
        throw new HttpError(400, err instanceof WalletKeyError ? err.message : 'that private key is not valid');
      }
      store.setWallet(uid, kp.publicKey.toBase58(), encryptSecret(kp.secretKey, uid, deps.masterKey));
      deps.forgetWallet(uid);
      balanceCache.delete(uid);
      store.addEvent({ userId: uid, kind: 'info', message: `Wallet ${kp.publicKey.toBase58().slice(0, 4)}…${kp.publicKey.toBase58().slice(-4)} imported` });
      return json(res, 200, { ok: true, pubkey: kp.publicKey.toBase58() });
    }
    if (path === '/api/wallet' && method === 'DELETE') {
      if (store.activePositions(uid).length) throw new HttpError(409, 'sell your open positions before removing the wallet');
      store.deleteWallet(uid);
      deps.forgetWallet(uid);
      balanceCache.delete(uid);
      store.addEvent({ userId: uid, kind: 'info', message: 'Wallet removed from the server' });
      return json(res, 200, { ok: true });
    }

    // ── copies ──
    if (path === '/api/copies' && method === 'POST') {
      const s = validated(await readJson(req));
      const cap = deps.maxCopiesPerUser ?? 20;
      if (store.countCopies(uid) >= cap) throw new HttpError(409, `at most ${cap} copies per account`);
      const id = store.createCopy(uid, s);
      // Real or test is the site's switch, not the copy's: say what a buy of this copy will be right now.
      store.addEvent({ userId: uid, copyId: id, kind: 'info', message: `Now copying ${s.name} (${s.leader.slice(0, 4)}…${s.leader.slice(-4)})${deps.serverInfo().live ? ' with real SOL' : ' in test mode'}` });
      return json(res, 200, { ok: true, id });
    }
    const copyMatch = /^\/api\/copies\/(\d+)$/.exec(path);
    if (copyMatch && (method === 'PUT' || method === 'DELETE')) {
      const id = Number(copyMatch[1]);
      const existing = store.copy(id);
      if (!existing || existing.userId !== uid) throw new HttpError(404, 'no such copy');
      if (method === 'DELETE') {
        store.deleteCopy(uid, id);
        return json(res, 200, { ok: true });
      }
      const s = validated(await readJson(req));
      store.updateCopy(uid, id, s);
      return json(res, 200, { ok: true, id });
    }

    // ── positions ──
    const sellMatch = /^\/api\/positions\/(\d+)\/sell$/.exec(path);
    if (sellMatch && method === 'POST') {
      const r = await deps.engine.sellNow(uid, Number(sellMatch[1]));
      if (!r.ok) throw new HttpError(r.error === 'no open position with that id' ? 404 : 502, r.error ?? 'sell failed');
      return json(res, 200, { ok: true });
    }

    // ── reads ──
    if (path === '/api/state' && method === 'GET') {
      renewSession(req, res);
      const user = store.user(uid);
      const w = store.wallet(uid);
      const stats = copyStats(uid);
      return json(res, 200, {
        user: { username: user?.username },
        server: deps.serverInfo(),
        feeBps: deps.feeBpsFor?.(uid) ?? 0,
        pnl: (({ days: _days, ...rest }) => rest)(pnlSummary(store, uid, Number(url.searchParams.get('tz') ?? 0))),
        wallet: w ? { pubkey: w.pubkey, sol: await walletSol(uid, w.pubkey) } : null,
        copies: store.copies(uid).map((c) => ({ id: c.id, ...c.settings, stats: stats.get(c.id) ?? { open: 0, closed: 0, pnlSol: 0 } })),
        positions: store.activePositions(uid).map(positionView),
        events: store.events(uid, 80),
      });
    }
    if (path === '/api/history' && method === 'GET') {
      const closed = store.closedPositions(uid, 200);
      let feesTotal = 0n;
      const views = closed.map((p) => {
        const fills = store.fills(p.id);
        const fees = fills.reduce((a, f) => a + f.feeLamports, 0n);
        feesTotal += fees;
        return { ...positionView(p), feesSol: sol(fees), fills: fills.map((f) => ({ side: f.side, reason: f.reason, sol: sol(f.lamports), feeSol: sol(f.feeLamports), signature: f.simulated ? null : f.signature, simulated: f.simulated, at: f.createdAt })) };
      });
      const total = closed.reduce((a, p) => a + (p.proceedsLamports - p.costLamports), 0n);
      const wins = closed.filter((p) => p.proceedsLamports > p.costLamports).length;
      return json(res, 200, { positions: views, totalPnlSol: sol(total), totalFeesSol: sol(feesTotal), trades: closed.length, wins, pnl: pnlSummary(store, uid, Number(url.searchParams.get('tz') ?? 0)) });
    }

    throw new HttpError(404, 'not found');
  }

  function validated(body: Record<string, unknown>) {
    try {
      return validateSettings(body);
    } catch (err) {
      if (err instanceof SettingsError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  async function serveStatic(path: string, res: ServerResponse): Promise<void> {
    const rel = path === '/' ? 'index.html' : normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    if (rel.includes('..')) throw new HttpError(404, 'not found');
    const file = join(publicDir, rel);
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300', ...SECURITY_HEADERS });
      res.end(data);
    } catch {
      // Unknown paths fall back to the app shell (client-side routes).
      const data = await readFile(join(publicDir, 'index.html')).catch(() => null);
      if (!data) throw new HttpError(404, 'not found');
      res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      res.end(data);
    }
  }

  return createServer((req, res) => {
    route(req, res).catch((err) => {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      log.error('request failed', { path: req.url, error: safeErrorMessage(err) });
      json(res, 500, { error: 'something went wrong' });
    });
  });
}
