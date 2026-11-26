// The website's server: JSON API under /api, the static site from public/. Sessions are an HttpOnly cookie holding
// a random token (stored hashed). Mutating calls need the X-Requested-With header (a cross-site form cannot send it).
// Wallet keys go in once and never come back out.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Keypair } from '@solana/web3.js';
import { lamportsToSol } from '../config.js';
import { encryptSecret, hashPassword, newToken, sha256, verifyPassword } from '../crypto.js';
import type { Engine } from '../engine/engine.js';
import type { Executor } from '../engine/executor.js';
import { lossPercent } from '../engine/rules.js';
import { SettingsError, validateSettings, defaultSettings, LIMITS } from '../engine/settings.js';
import { log, safeErrorMessage } from '../log.js';
import type { Position, Store } from '../store.js';
import { parseSecretKey, WalletKeyError } from '../wallets.js';

export interface AppDeps {
  store: Store;
  engine: Engine;
  executor: Executor;
  masterKey: string;
  signupCode: string;
  secureCookies: boolean;
  /** Forget the cached keypair of a user (after a wallet change). */
  forgetWallet: (userId: number) => void;
  serverInfo: () => { live: boolean; maxSolPerBuy: number; watching: number; mode: string };
  trustProxy?: boolean;
  maxCopiesPerUser?: number;
  publicDir?: string;
}

const COOKIE = 'ml_session';
const SESSION_DAYS = 30;
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
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

/** Simple fixed-window limiter for login / sign-up attempts. */
class Limiter {
  private readonly hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  hit(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until < now) {
      this.hits.set(key, { n: 1, until: now + this.windowMs });
      return true;
    }
    h.n += 1;
    return h.n <= this.max;
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
    if (id === null) throw new HttpError(401, 'please log in');
    return id;
  }

  function setSession(res: ServerResponse, uid: number): void {
    const token = newToken();
    store.createSession(sha256(token), uid, Date.now() + SESSION_DAYS * 86_400_000);
    res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}${deps.secureCookies ? '; Secure' : ''}`);
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

    // ── accounts ──
    if (path === '/api/signup' && method === 'POST') {
      const ip = clientIp(req);
      if (!authLimiter.hit(`signup:${ip}`)) throw new HttpError(429, 'too many attempts, try again in a few minutes');
      const b = await readJson(req);
      const username = String(b.username ?? '').trim();
      const password = String(b.password ?? '');
      if (deps.signupCode && String(b.code ?? '').trim() !== deps.signupCode) throw new HttpError(403, 'wrong invite code');
      if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) throw new HttpError(400, 'username: 3–24 letters, numbers, _ . -');
      if (password.length < 8) throw new HttpError(400, 'password: at least 8 characters');
      if (store.userByName(username)) throw new HttpError(409, 'that username is taken');
      const id = store.createUser(username, await hashPassword(password));
      setSession(res, id);
      return json(res, 200, { ok: true, username });
    }
    if (path === '/api/login' && method === 'POST') {
      const b = await readJson(req);
      const username = String(b.username ?? '').trim();
      const ip = clientIp(req);
      if (!authLimiter.hit(`login:${ip}:${username.toLowerCase()}`)) throw new HttpError(429, 'too many attempts, try again in a few minutes');
      const user = store.userByName(username);
      if (!user || !(await verifyPassword(String(b.password ?? ''), user.passHash))) throw new HttpError(401, 'wrong username or password');
      setSession(res, user.id);
      return json(res, 200, { ok: true, username: user.username });
    }
    if (path === '/api/logout' && method === 'POST') {
      const token = cookies(req)[COOKIE];
      if (token) store.deleteSession(sha256(token));
      res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/config' && method === 'GET') {
      return json(res, 200, { signupNeedsCode: !!deps.signupCode, defaults: defaultSettings(), limits: LIMITS, server: deps.serverInfo() });
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
      store.addEvent({ userId: uid, copyId: id, kind: 'info', message: `Now copying ${s.name} (${s.leader.slice(0, 4)}…${s.leader.slice(-4)})${s.mode === 'paper' ? ' in test mode' : ''}` });
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
      const user = store.user(uid);
      const w = store.wallet(uid);
      const stats = copyStats(uid);
      return json(res, 200, {
        user: { username: user?.username },
        server: deps.serverInfo(),
        wallet: w ? { pubkey: w.pubkey, sol: await walletSol(uid, w.pubkey) } : null,
        copies: store.copies(uid).map((c) => ({ id: c.id, ...c.settings, stats: stats.get(c.id) ?? { open: 0, closed: 0, pnlSol: 0 } })),
        positions: store.activePositions(uid).map(positionView),
        events: store.events(uid, 80),
      });
    }
    if (path === '/api/history' && method === 'GET') {
      const closed = store.closedPositions(uid, 200);
      const views = closed.map((p) => ({ ...positionView(p), fills: store.fills(p.id).map((f) => ({ side: f.side, reason: f.reason, sol: sol(f.lamports), signature: f.simulated ? null : f.signature, simulated: f.simulated, at: f.createdAt })) }));
      const total = closed.reduce((a, p) => a + (p.proceedsLamports - p.costLamports), 0n);
      const wins = closed.filter((p) => p.proceedsLamports > p.costLamports).length;
      return json(res, 200, { positions: views, totalPnlSol: sol(total), trades: closed.length, wins });
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
