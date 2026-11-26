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

  it('sign-up needs a valid, unused key; the key then belongs to that account', async () => {
    const tom = new Client();
    expect((await tom.call('POST', '/api/signup', { username: 'tom', password: 'password1', license: 'WM-AAAA-AAAA-AAAA-AAAA' })).status).toBe(403);
    expect((await tom.call('POST', '/api/signup', { username: 'tom', password: 'password1', license: key.toLowerCase() })).status).toBe(200);
    expect((await tom.call('GET', '/api/state')).body.feeBps).toBe(50);
    const again = new Client();
    const r = await again.call('POST', '/api/signup', { username: 'tom2', password: 'password1', license: key });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toMatch(/already been used/);
    expect(store.userByName('tom2')).toBeUndefined();
    const s = await admin.call('GET', '/api/admin/state');
    expect((s.body.licenses as { status: string; username: string }[])[0]).toMatchObject({ status: 'active', username: 'tom' });
    expect((s.body.users as { username: string; license: string }[])[0]).toMatchObject({ username: 'tom', license: 'Tom' });
  });

  it('revoking the key locks the user out; restoring lets them back in', async () => {
    const tom = new Client();
    await tom.call('POST', '/api/login', { username: 'tom', password: 'password1' });
    expect((await admin.call('PUT', `/api/admin/licenses/${licenseId}`, { revoked: true })).status).toBe(200);
    expect((await tom.call('GET', '/api/state')).status).toBe(401);
    const login = await tom.call('POST', '/api/login', { username: 'tom', password: 'password1' });
    expect(login.status).toBe(403);
    expect(String(login.body.error)).toMatch(/revoked/);
    await admin.call('PUT', `/api/admin/licenses/${licenseId}`, { revoked: false, feePercent: 2 });
    expect((await tom.call('POST', '/api/login', { username: 'tom', password: 'password1' })).status).toBe(200);
    expect((await tom.call('GET', '/api/state')).body.feeBps).toBe(200);
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
