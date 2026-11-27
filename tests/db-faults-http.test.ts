// The site while its database cannot be written (a full disk): the dashboard still loads. Renewing a session (once a
// day, on the page's refresh) is a write: one that fails waits for a later refresh instead of failing the page.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/http/app.js';
import type { Engine } from '../src/engine/engine.js';
import type { Executor } from '../src/engine/executor.js';
import { Store } from '../src/store.js';
import { sha256 } from '../src/crypto.js';

const executor: Executor = {
  buy: async () => ({ ok: false, error: 'no' }), sell: async () => ({ ok: false, error: 'no' }),
  quoteSell: async () => 1n, solBalance: async () => 1n, tokenBalance: async () => 0n, isLive: () => false,
};
const engine = { knownBalance: () => null } as unknown as Engine;

let server: Server;
let base: string;
let store: Store;
let token = '';

beforeAll(async () => {
  store = new Store(':memory:');
  server = createApp({
    store, engine, executor, masterKey: '11'.repeat(32), secureCookies: false, forgetWallet: () => {},
    serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'offline' }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const uid = store.createUser('Viewer', 'x');
  token = randomBytes(16).toString('hex');
  store.createSession(sha256(token), uid, Date.now() + 80 * 86_400_000); // ten days old: renewed on the next refresh
});
afterAll(() => server.close());

describe('the dashboard while the database cannot be written', () => {
  it('loads, though the session it would renew cannot be written (it answered 500 for every session a day old)', async () => {
    const extend = store.extendSession.bind(store);
    store.extendSession = () => { throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 }); };
    const res = await fetch(`${base}/api/state`, { headers: { cookie: `ml_session=${token}`, 'x-requested-with': 'motionlarp' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull(); // not renewed: tried again on a later refresh
    store.extendSession = extend;
    const again = await fetch(`${base}/api/state`, { headers: { cookie: `ml_session=${token}`, 'x-requested-with': 'motionlarp' } });
    expect(again.status).toBe(200);
    expect(again.headers.get('set-cookie')).toMatch(/ml_session=/); // renewed once the database takes it
  });
});
