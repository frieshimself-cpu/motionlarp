import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createApp } from '../src/http/app.js';
import { Engine } from '../src/engine/engine.js';
import type { Executor } from '../src/engine/executor.js';
import { Store } from '../src/store.js';
import { decryptSecret } from '../src/crypto.js';

const MASTER = '11'.repeat(32);
const LEADER = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
const MINT = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';

const executor: Executor = {
  buy: async (r) => ({ ok: true, signature: 'B', tokens: 1000n, lamports: r.lamports, simulated: true }),
  sell: async (r) => ({ ok: true, signature: 'S', tokens: r.tokens, lamports: 1n, simulated: true }),
  quoteSell: async () => 1n,
  solBalance: async () => 2_000_000_000n,
  tokenBalance: async () => 0n,
  isLive: () => false,
};

let server: Server;
let base: string;
let store: Store;
let engine: Engine;
const secret = Keypair.generate();

beforeAll(async () => {
  store = new Store(':memory:');
  const cache = new Map<number, Keypair>();
  const walletFor = (id: number) => {
    const w = store.wallet(id);
    return w ? (cache.get(id) ?? Keypair.fromSecretKey(decryptSecret(w.encKey, id, MASTER))) : null;
  };
  engine = new Engine({ store, executor, walletFor, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
  server = createApp({ store, engine, executor, masterKey: MASTER, signupCode: 'friends', secureCookies: false, forgetWallet: (id) => cache.delete(id), serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'test' }), feeBpsFor: (id) => (store.user(id)?.username === 'bob' ? 0 : 100) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-requested-with': 'motionlarp' }) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: this.cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
  }
}

describe('accounts', () => {
  it('sign-up needs the invite code', async () => {
    const c = new Client();
    expect((await c.call('POST', '/api/signup', { username: 'alice', password: 'password1', code: 'nope' })).status).toBe(403);
    expect((await c.call('POST', '/api/signup', { username: 'alice', password: 'password1', code: 'friends' })).status).toBe(200);
    expect((await c.call('GET', '/api/state')).status).toBe(200);
  });
  it('refuses a taken username, a short password, a wrong password', async () => {
    const c = new Client();
    expect((await c.call('POST', '/api/signup', { username: 'ALICE', password: 'password1', code: 'friends' })).status).toBe(409);
    expect((await c.call('POST', '/api/signup', { username: 'carol', password: 'short', code: 'friends' })).status).toBe(400);
    expect((await c.call('POST', '/api/login', { username: 'alice', password: 'wrong-pass' })).status).toBe(401);
    expect((await c.call('POST', '/api/login', { username: 'alice', password: 'password1' })).status).toBe(200);
  });
  it('logged out: 401; a POST without the app header: 403', async () => {
    const c = new Client();
    expect((await c.call('GET', '/api/state')).status).toBe(401);
    expect((await c.call('POST', '/api/login', { username: 'alice', password: 'password1' }, {})).status).toBe(403);
  });
});

describe('wallet and copies', () => {
  const alice = new Client();
  const bob = new Client();
  let copyId = 0;

  it('imports a key and never returns it', async () => {
    await alice.call('POST', '/api/login', { username: 'alice', password: 'password1' });
    const bad = await alice.call('POST', '/api/wallet', { key: secret.publicKey.toBase58() });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/address, not a private key/);
    const r = await alice.call('POST', '/api/wallet', { key: bs58.encode(secret.secretKey) });
    expect(r.body.pubkey).toBe(secret.publicKey.toBase58());
    const state = await alice.call('GET', '/api/state');
    expect(state.text).not.toContain(bs58.encode(secret.secretKey));
    expect(state.text).not.toContain('v1:');
    expect((state.body.wallet as { sol: number }).sol).toBe(2);
    const row = store.wallet(store.userByName('alice')!.id)!;
    expect(row.encKey).not.toContain(bs58.encode(secret.secretKey));
  });

  it('creates a copy; validation errors are readable', async () => {
    const bad = await alice.call('POST', '/api/copies', { leader: LEADER, buySol: 0 });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/buy amount/);
    const r = await alice.call('POST', '/api/copies', { leader: LEADER, name: 'Cupsey', buySol: 0.1, minLeaderBuySol: 1, sell: { timed: [{ afterSec: 3, percent: 25 }] } });
    copyId = Number(r.body.id);
    const state = await alice.call('GET', '/api/state');
    expect((state.body.copies as { name: string }[])[0]).toMatchObject({ name: 'Cupsey', buySol: 0.1 });
  });

  it("another user cannot see or change alice's copy", async () => {
    await bob.call('POST', '/api/signup', { username: 'bob', password: 'password2', code: 'friends' });
    expect((await bob.call('PUT', `/api/copies/${copyId}`, { leader: LEADER, buySol: 1 })).status).toBe(404);
    expect((await bob.call('DELETE', `/api/copies/${copyId}`)).status).toBe(404);
    expect(((await bob.call('GET', '/api/state')).body.copies as unknown[]).length).toBe(0);
    // the platform fee each user pays is shown to them (bob is exempt)
    expect((await bob.call('GET', '/api/state')).body.feeBps).toBe(0);
    expect((await alice.call('GET', '/api/state')).body.feeBps).toBe(100);
  });

  it('an open position blocks removing the wallet; Sell now closes it and only for its owner', async () => {
    await engine.onLeaderTrade({ signature: 'x1', leader: LEADER, mint: MINT, side: 'buy', solLamports: 2_000_000_000n, tokenAmount: 1n, tokensBefore: 0n, tokensAfter: 1n, venue: 'pumpfun', slot: 1, blockTime: null });
    await engine.idle();
    const state = await alice.call('GET', '/api/state');
    const [pos] = state.body.positions as { id: number; costSol: number }[];
    expect(pos!.costSol).toBe(0.1);
    expect((await alice.call('DELETE', '/api/wallet')).status).toBe(409);
    expect((await bob.call('POST', `/api/positions/${pos!.id}/sell`)).status).toBe(404);
    expect((await alice.call('POST', `/api/positions/${pos!.id}/sell`)).status).toBe(200);
    expect(((await alice.call('GET', '/api/state')).body.positions as unknown[]).length).toBe(0);
    const hist = await alice.call('GET', '/api/history');
    expect(hist.body.trades).toBe(1);
    expect((await alice.call('DELETE', '/api/wallet')).status).toBe(200);
  });
});
