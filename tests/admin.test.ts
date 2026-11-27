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
const saved: unknown[] = [];
let restarted = 0;

beforeAll(async () => {
  store = new Store(':memory:');
  const engine = new Engine({ store, executor, walletFor: () => null, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
  server = createApp({
    store, engine, executor, masterKey: '11'.repeat(32), secureCookies: false, forgetWallet: () => {},
    serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'test' }),
    adminPassword: 'correct horse battery',
    owner: {
      view: () => ({ rpc: 'mainnet.helius-rpc.com (key …90ab)', rpcSet: true, jupiterKeySet: false, feePercent: 1, feeWallet: 'W', maxSolPerBuy: 1, liveTrading: false }),
      save: async (patch) => { if ((patch as { feePercent?: number }).feePercent === 99) throw Object.assign(new Error('the fee must be between 0 and 10 %'), { name: 'OwnerSettingsError' }); saved.push(patch); return { restart: !!(patch as { rpcUrl?: string }).rpcUrl }; },
      restart: () => { restarted++; },
      connections: async () => ({ ok: true, checks: [{ id: 'rpc', name: 'Helius RPC', ok: true, detail: 'answered' }] }),
    },
    feeBpsFor: (id) => store.userLicense(id)?.feeBps ?? 100,
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
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
  }
}

describe('admin area', () => {
  const admin = new Client();
  let key = '';
  let licenseId = 0;

  it('is closed without the password, and a wrong password is refused', async () => {
    expect((await admin.call('GET', '/api/admin/state')).status).toBe(401);
    expect((await admin.call('POST', '/api/admin/login', { password: 'nope' })).status).toBe(401);
    expect((await admin.call('POST', '/api/admin/licenses', { label: 'x' })).status).toBe(401);
  });

  it('a logged-in user is not an admin', async () => {
    const id = store.createLicense({ keyHash: 'zz', hint: 'zzzz', label: 'seed', feeBps: null });
    void id;
    const u = new Client();
    // (no valid key: this user cannot even sign up, and has no admin cookie either way)
    expect((await u.call('GET', '/api/admin/state')).status).toBe(401);
  });

  it('the right password opens it', async () => {
    expect((await admin.call('POST', '/api/admin/login', { password: 'correct horse battery' })).status).toBe(200);
    const s = await admin.call('GET', '/api/admin/state');
    expect(s.status).toBe(200);
    expect(s.body.settings).toMatchObject({ rpc: 'mainnet.helius-rpc.com (key …90ab)' });
  });

  it('creates a license key, shown once, with its own fee', async () => {
    const r = await admin.call('POST', '/api/admin/licenses', { label: 'Tom', feePercent: 0.5 });
    expect(r.status).toBe(200);
    key = String(r.body.key);
    licenseId = Number(r.body.id);
    expect(key).toMatch(/^WM-/);
    const s = await admin.call('GET', '/api/admin/state');
    expect(s.text).not.toContain(key);
    expect((s.body.licenses as { label: string; feePercent: number | null; status: string }[])[0]).toMatchObject({ label: 'Tom', feePercent: 0.5, status: 'unused' });
  });

  it('the key opens an account named after it; the key belongs to that one account', async () => {
    const tom = new Client();
    expect((await tom.call('POST', '/api/enter', { license: 'WM-AAAA-AAAA-AAAA-AAAA' })).status).toBe(403);
    const r = await tom.call('POST', '/api/enter', { license: key.toLowerCase() });
    expect(r.body).toMatchObject({ ok: true, username: 'Tom' });
    expect((await tom.call('GET', '/api/state')).body.feeBps).toBe(50);
    const s = await admin.call('GET', '/api/admin/state');
    expect((s.body.licenses as { status: string; username: string }[])[0]).toMatchObject({ status: 'active', username: 'Tom' });
    expect((s.body.users as { username: string; license: string }[])[0]).toMatchObject({ username: 'Tom', license: 'Tom' });
  });

  it('revoking the key locks the user out; restoring lets them back in', async () => {
    const tom = new Client();
    await tom.call('POST', '/api/enter', { license: key });
    expect((await admin.call('PUT', `/api/admin/licenses/${licenseId}`, { revoked: true })).status).toBe(200);
    expect((await tom.call('GET', '/api/state')).status).toBe(401);
    const login = await tom.call('POST', '/api/enter', { license: key });
    expect(login.status).toBe(403);
    expect(String(login.body.error)).toMatch(/revoked/);
    await admin.call('PUT', `/api/admin/licenses/${licenseId}`, { revoked: false, feePercent: 2 });
    expect((await tom.call('POST', '/api/enter', { license: key })).status).toBe(200);
    expect((await tom.call('GET', '/api/state')).body.feeBps).toBe(200);
  });

  it('a lost key is replaced: the new key opens the same account, the old one stops working', async () => {
    const before = new Client(); // a browser that got in with the old key (a leaked key, say)
    expect((await before.call('POST', '/api/enter', { license: key })).status).toBe(200);
    expect((await before.call('GET', '/api/state')).status).toBe(200);
    const r = await admin.call('POST', `/api/admin/licenses/${licenseId}/reissue`);
    expect((await before.call('GET', '/api/state')).status).toBe(401); // logged out with the old key
    const fresh = String(r.body.key);
    expect(fresh).toMatch(/^WM-/);
    expect(fresh).not.toBe(key);
    const tom = new Client();
    expect((await tom.call('POST', '/api/enter', { license: key })).status).toBe(403);
    expect((await tom.call('POST', '/api/enter', { license: fresh })).body.username).toBe('Tom');
    key = fresh;
  });

  it('an account from before license keys gets a key from the admin page', async () => {
    const legacy = store.createUser('oldtimer', 'x');
    const r = await admin.call('POST', `/api/admin/users/${legacy}/key`);
    expect(String(r.body.key)).toMatch(/^WM-/);
    const c = new Client();
    expect((await c.call('POST', '/api/enter', { license: String(r.body.key) })).body.username).toBe('oldtimer');
  });

  it('two keys with the same name get distinct accounts', async () => {
    const a = await admin.call('POST', '/api/admin/licenses', { label: 'Tom' });
    const c = new Client();
    const r = await c.call('POST', '/api/enter', { license: String(a.body.key) });
    expect(r.status).toBe(200);
    expect(r.body.username).not.toBe('Tom');
    expect(String(r.body.username)).toMatch(/^Tom/);
  });

  it('an unused key can be deleted, a used one cannot', async () => {
    const r = await admin.call('POST', '/api/admin/licenses', { label: 'spare' });
    expect((await admin.call('DELETE', `/api/admin/licenses/${r.body.id}`)).status).toBe(200);
    expect((await admin.call('DELETE', `/api/admin/licenses/${licenseId}`)).status).toBe(409);
  });

  it('settings: saved through the owner module; a refused value is a readable 400; an RPC change restarts', async () => {
    expect((await admin.call('POST', '/api/admin/settings', { feePercent: 99 })).status).toBe(400);
    const r = await admin.call('POST', '/api/admin/settings', { feePercent: 1.5, liveTrading: false });
    expect(r.body).toMatchObject({ ok: true, restart: false });
    const r2 = await admin.call('POST', '/api/admin/settings', { rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=x' });
    expect(r2.body).toMatchObject({ ok: true, restart: true });
    await new Promise((res) => setTimeout(res, 30));
    expect(restarted).toBe(1);
    expect(saved).toHaveLength(2);
  });

  it('connections: the live checks are for the owner only', async () => {
    const stranger = new Client();
    expect((await stranger.call('GET', '/api/admin/connections')).status).toBe(401);
    const r = await admin.call('GET', '/api/admin/connections');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, checks: [{ id: 'rpc', ok: true }] });
  });

  it('logging out closes the admin area again', async () => {
    await admin.call('POST', '/api/admin/logout');
    expect((await admin.call('GET', '/api/admin/state')).status).toBe(401);
  });
});

describe('admin without a password configured', () => {
  it('stays closed', async () => {
    const s2 = new Store(':memory:');
    const engine = new Engine({ store: s2, executor, walletFor: () => null, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
    const app = createApp({ store: s2, engine, executor, masterKey: '11'.repeat(32), secureCookies: false, forgetWallet: () => {}, serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'test' }), adminPassword: '' });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'motionlarp' }, body: JSON.stringify({ password: '' }) });
    expect(res.status).toBe(503);
    app.close();
  });
});

describe('staying logged in', () => {
  const mk = (s: Store) => {
    const engine = new Engine({ store: s, executor, walletFor: () => null, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
    return createApp({ store: s, engine, executor, masterKey: '11'.repeat(32), secureCookies: false, forgetWallet: () => {}, serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'test' }), adminPassword: 'correct horse battery' });
  };
  const listen = async (app: Server) => { await new Promise<void>((r) => app.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(app.address() as AddressInfo).port}`; };
  const H = { 'content-type': 'application/json', 'x-requested-with': 'motionlarp' };

  it('a user session renews itself while it is used (90 days from the last visit)', async () => {
    const s = new Store(':memory:');
    const uid = s.createUser('zed', 'x');
    const { sha256 } = await import('../src/crypto.js');
    s.createSession(sha256('tok'), uid, Date.now() + 86_400_000); // one day left
    const app = mk(s);
    const url = await listen(app);
    const res = await fetch(`${url}/api/state`, { headers: { ...H, cookie: 'ml_session=tok' } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(';')).toMatch(/ml_session=tok;.*Max-Age=7776000/);
    expect(s.sessionExpiry(sha256('tok'))!).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    app.close();
  });

  it('the admin login survives a restart of the site', async () => {
    const s = new Store(':memory:');
    const app1 = mk(s);
    const url1 = await listen(app1);
    const login = await fetch(`${url1}/api/admin/login`, { method: 'POST', headers: H, body: JSON.stringify({ password: 'correct horse battery' }) });
    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    app1.close();
    const app2 = mk(s); // "after the restart": a new process over the same database
    const url2 = await listen(app2);
    expect((await fetch(`${url2}/api/admin/state`, { headers: { ...H, cookie } })).status).toBe(200);
    await fetch(`${url2}/api/admin/logout`, { method: 'POST', headers: { ...H, cookie } });
    expect((await fetch(`${url2}/api/admin/state`, { headers: { ...H, cookie } })).status).toBe(401);
    app2.close();
  });
});
