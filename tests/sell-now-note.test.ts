// Sell now that sells nothing itself (every coin already in a sell of ours on its way) has a note saying what happens
// instead: the endpoint passes it on, and the page shows it in place of "Sold".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/http/app.js';
import type { Engine } from '../src/engine/engine.js';
import type { Executor } from '../src/engine/executor.js';
import { Store } from '../src/store.js';
import { sha256 } from '../src/crypto.js';

const NOTE = 'All of it is already being sold by another sell of ours on its way: whatever that one does not sell is sold right after it.';
const executor: Executor = {
  buy: async () => ({ ok: false, error: 'no' }), sell: async () => ({ ok: false, error: 'no' }),
  quoteSell: async () => 1n, solBalance: async () => 1n, tokenBalance: async () => 0n, isLive: () => false,
};
let answer: { ok: boolean; error?: string; note?: string } = { ok: true };
const engine = { sellNow: async () => answer } as unknown as Engine;

let server: Server;
let base: string;
let store: Store;
let cookie = '';

beforeAll(async () => {
  store = new Store(':memory:');
  server = createApp({
    store, engine, executor, masterKey: '11'.repeat(32), secureCookies: false, forgetWallet: () => {},
    serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'offline' }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const uid = store.createUser('Seller', 'x');
  const token = randomBytes(16).toString('hex');
  store.createSession(sha256(token), uid, Date.now() + 3_600_000);
  cookie = `ml_session=${token}`;
  void Keypair; // (the wallet is not needed: the engine is a stand-in)
});
afterAll(() => server.close());

const press = async () => {
  const res = await fetch(`${base}/api/positions/1/sell`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'motionlarp', cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('Sell now\'s note', () => {
  it('is passed on by the endpoint when the press sold nothing itself', async () => {
    answer = { ok: true, note: NOTE };
    expect(await press()).toEqual({ status: 200, body: { ok: true, note: NOTE } });
  });

  it('is absent on an ordinary sale', async () => {
    answer = { ok: true };
    expect(await press()).toEqual({ status: 200, body: { ok: true } });
  });

  it('is what the page shows in place of "Sold"', () => {
    const page = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const press = /api\('POST', `\/api\/positions\/\$\{b\.dataset\.sell\}\/sell`\)[^\n]*/.exec(page)?.[0] ?? '';
    expect(press).toMatch(/\.note/);
    expect(press).toMatch(/'Sold'/);
  });
});
