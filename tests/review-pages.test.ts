// From the every-button test of the site (27 Nov 2026): successful logins counted against the login limit, and a user
// re-enabled while their key stayed revoked was copied for again although they could not log in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/http/app.js';
import { Engine } from '../src/engine/engine.js';
import type { Executor } from '../src/engine/executor.js';
import { Store } from '../src/store.js';

const executor: Executor = {
  buy: async (r) => ({ ok: true, signature: 'B', tokens: 1000n, lamports: r.lamports, simulated: true }),
  sell: async (r) => ({ ok: true, signature: 'S', tokens: r.tokens, lamports: 1n, simulated: true }),
  quoteSell: async () => 1n, solBalance: async () => 2_000_000_000n, tokenBalance: async () => 0n, isLive: () => false,
};
let server: Server;
let base: string;
let store: Store;

beforeAll(async () => {
  store = new Store(':memory:');
  const engine = new Engine({ store, executor, walletFor: () => null, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
  server = createApp({
    store, engine, executor, masterKey: '11'.repeat(32), secureCookies: false, forgetWallet: () => {},
    serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'test' }),
    adminPassword: 'correct horse battery',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

class Client {
  cookies = new Map<string, string>();
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'motionlarp', cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv!.indexOf('='); this.cookies.set(kv!.slice(0, i), kv!.slice(i + 1)); }
    return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
  }
}

describe('the login limit counts failures only', () => {
  it('the right admin password works however often it is used; five wrong ones lock the door', async () => {
    for (let i = 0; i < 8; i++) expect((await new Client().call('POST', '/api/admin/login', { password: 'correct horse battery' })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await new Client().call('POST', '/api/admin/login', { password: 'nope' })).status).toBe(401);
    expect((await new Client().call('POST', '/api/admin/login', { password: 'nope' })).status).toBe(429);
  });

  it('a valid license key logs in from many devices (a trader with a phone, a laptop, a desk); ten wrong keys lock the door', async () => {
    const { licenseHash, newLicenseKey } = await import('../src/licenses.js');
    const key = newLicenseKey();
    store.createLicense({ keyHash: licenseHash(key), hint: key.slice(-4), label: 'Kol', feeBps: null });
    for (let i = 0; i < 14; i++) expect((await new Client().call('POST', '/api/enter', { license: key })).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await new Client().call('POST', '/api/enter', { license: 'WM-NOPE-NOPE-NOPE-NOPE' })).status).toBe(403);
    expect((await new Client().call('POST', '/api/enter', { license: 'WM-NOPE-NOPE-NOPE-NOPE' })).status).toBe(429);
  });
});

describe('a revoked key', () => {
  it('its user cannot be enabled while the key stays revoked (the server would copy trades for someone who cannot log in)', async () => {
    const lid = store.createLicense({ keyHash: 'h-revoked', hint: 'xxxx', label: 'Gone', feeBps: null });
    const uid = store.createUser('Gone', 'x');
    store.redeemLicense(lid, uid);
    store.setLicenseRevoked(lid, true);
    expect(store.user(uid)!.disabled).toBe(true);
    const admin = new Client();
    const token = (await import('node:crypto')).randomBytes(16).toString('hex');
    store.createAdminSession((await import('node:crypto')).createHash('sha256').update(token).digest('hex'), Date.now() + 3_600_000);
    admin.cookies.set('ml_admin', token);
    const r = await admin.call('PUT', `/api/admin/users/${uid}`, { disabled: false });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/restore (the|their) key/i);
    expect(store.user(uid)!.disabled).toBe(true);
  });
});

describe('History and each copy\'s line count every closed position (the trader closes about 100 a day)', () => {
  it('the totals cover all of them, real trades only once there are any; the list says it shows the latest 200', async () => {
    const { licenseHash, newLicenseKey } = await import('../src/licenses.js');
    const key = newLicenseKey();
    const lid = store.createLicense({ keyHash: licenseHash(key), hint: key.slice(-4), label: 'Busy', feeBps: null });
    const uid = store.createUser('Busy', 'x');
    store.redeemLicense(lid, uid);
    // (a session made directly: the login door of this test file was locked on purpose by the test above)
    const { createHash, randomBytes } = await import('node:crypto');
    const token = randomBytes(16).toString('hex');
    store.createSession(createHash('sha256').update(token).digest('hex'), uid, Date.now() + 3_600_000);
    const c = new Client();
    c.cookies.set('ml_session', token);
    const { validateSettings } = await import('../src/engine/settings.js');
    const copyId = store.createCopy(uid, validateSettings({ leader: 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih', buySol: 0.1, minLeaderBuySol: 0 }));
    const s = store.copy(copyId)!.settings;
    const close = (mode: 'live' | 'paper', cost: bigint, proceeds: bigint, fee: bigint) => {
      const id = store.insertPosition({ userId: uid, copyId, mint: `M${Math.random()}`, mode, leaderSig: `s${Math.random()}`, sell: s.sell, copyName: 'x', leader: s.leader, now: Date.now() });
      store.updatePosition(id, { status: 'closed', tokensBought: 1n, tokensHeld: 0n, costLamports: cost, proceedsLamports: proceeds, closedAt: Date.now() });
      store.insertFill({ positionId: id, userId: uid, side: 'sell', reason: 'timed', tokens: 1n, lamports: proceeds, signature: 'x', simulated: mode === 'paper', error: null, feeLamports: fee });
    };
    for (let i = 0; i < 50; i++) close('paper', 1_000_000_000n, 3_000_000_000n, 5n); // test trades: big wins, never paid fees
    for (let i = 0; i < 250; i++) close('live', 100_000_000n, i % 2 ? 110_000_000n : 95_000_000n, 1_000n);
    const h = await c.call('GET', '/api/history');
    expect(h.body.trades).toBe(250); // every real one, not the newest 200, and no test ones
    expect(h.body.wins).toBe(125);
    expect(h.body.totalPnlSol).toBeCloseTo((125 * 10_000_000 - 125 * 5_000_000) / 1e9, 9);
    expect(h.body.totalFeesSol).toBeCloseTo((250 * 1_000) / 1e9, 12); // fees really paid only
    expect((h.body.positions as unknown[]).length).toBe(200);
    expect(h.body.shown).toBe(200);
    const st = await c.call('GET', '/api/state');
    const copy = (st.body.copies as { id: number; stats: { closed: number; pnlSol: number } }[]).find((x) => x.id === copyId)!;
    expect(copy.stats.closed).toBe(250);
    expect(copy.stats.pnlSol).toBeCloseTo((125 * 10_000_000 - 125 * 5_000_000) / 1e9, 9);
  });
});
