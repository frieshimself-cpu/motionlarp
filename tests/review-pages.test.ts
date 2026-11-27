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
