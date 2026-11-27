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
  server = createApp({ store, engine, executor, masterKey: MASTER, secureCookies: false, forgetWallet: (id) => cache.delete(id), serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'test' }), feeBpsFor: (id) => (id === store.users()[0]?.id ? 100 : 0) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

import { licenseHash } from '../src/licenses.js';
/** A fresh, unused license key for a sign-up. */
function lic(): string {
  const key = `WM-TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}-AAAA-AAAA`;
  store.createLicense({ keyHash: licenseHash(key), hint: 'AAAA', label: 'test', feeBps: null });
  return key;
}

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

const aliceKey = () => (keys.alice ??= lic());
const keys: Record<string, string> = {};

describe('getting in', () => {
  it('the license key is all it takes: the first use opens the account, later uses come back to it', async () => {
    const c = new Client();
    expect((await c.call('POST', '/api/enter', { license: 'nope' })).status).toBe(403);
    const first = await c.call('POST', '/api/enter', { license: aliceKey() });
    expect(first.status).toBe(200);
    expect((await c.call('GET', '/api/state')).status).toBe(200);
    const again = new Client();
    expect((await again.call('POST', '/api/enter', { license: ` ${aliceKey().toLowerCase()} ` })).body.username).toBe(first.body.username);
    expect(store.users()).toHaveLength(1);
  });
  it('the site offers the ready-made presets (Scharo: one click fills the whole copy)', async () => {
    const cfg = await new Client().call('GET', '/api/config');
    const presets = cfg.body.presets as { id: string; name: string; settings: { leader: string; slippagePct: number; tipSol: number; priorityFeeSol: number; sell: { timedOf: string; timed: unknown[]; mirror: { mode: string } } } }[];
    const scharo = presets.find((p) => p.id === 'scharo')!;
    expect(scharo.name).toBe('Scharo');
    expect(scharo.settings).toMatchObject({
      leader: 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih', slippagePct: 100, priorityFeeSol: 0.001, tipSol: 0.005,
      sell: { timedOf: 'bag', mirror: { enabled: true, mode: 'exit' }, timed: [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 30 }, { afterSec: 6, percent: 100 }], stopLoss: [], deadCoin: { enabled: false } },
    });
  });
  it('there is no sign-up or password login any more', async () => {
    const c = new Client();
    expect((await c.call('POST', '/api/signup', { username: 'x', password: 'password1', license: lic() })).status).toBe(401);
    expect((await c.call('POST', '/api/login', { username: 'x', password: 'password1' })).status).toBe(401);
  });
  it('logged out: 401; a POST without the app header: 403', async () => {
    const c = new Client();
    expect((await c.call('GET', '/api/state')).status).toBe(401);
    expect((await c.call('POST', '/api/enter', { license: aliceKey() }, {})).status).toBe(403);
  });
});

describe('wallet and copies', () => {
  const alice = new Client();
  const bob = new Client();
  let copyId = 0;

  it('imports a key and never returns it', async () => {
    await alice.call('POST', '/api/enter', { license: aliceKey() });
    const bad = await alice.call('POST', '/api/wallet', { key: secret.publicKey.toBase58() });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/address, not a private key/);
    const r = await alice.call('POST', '/api/wallet', { key: bs58.encode(secret.secretKey) });
    expect(r.body.pubkey).toBe(secret.publicKey.toBase58());
    const state = await alice.call('GET', '/api/state');
    expect(state.text).not.toContain(bs58.encode(secret.secretKey));
    expect(state.text).not.toContain('v1:');
    expect((state.body.wallet as { sol: number }).sol).toBe(2);
    const row = store.wallet(store.users()[0]!.id)!;
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
    await bob.call('POST', '/api/enter', { license: lic() });
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

describe('browser protections', () => {
  it('pages and API answers carry the security headers: only our own scripts run, no framing, no plugins', async () => {
    for (const path of ['/', '/api/config']) {
      const res = await fetch(base + path);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    }
  });
  it('a wallet key is never accepted in a URL, only in a POST body, and never echoed in an error', async () => {
    const c = new Client();
    await c.call('POST', '/api/enter', { license: lic() });
    const bad = await c.call('POST', '/api/wallet', { key: 'x'.repeat(88) });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain('x'.repeat(20));
  });
});
