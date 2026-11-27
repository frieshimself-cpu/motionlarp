// From the every-button test of the site (findings B1-B20, written at 26bd31f): what was still wrong at af4bf0d.
// Each test here failed on the code before its fix.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { createApp, positionView } from '../src/http/app.js';
import { Engine } from '../src/engine/engine.js';
import type { Executor } from '../src/engine/executor.js';
import { Store, type Position } from '../src/store.js';
import { validateSettings } from '../src/engine/settings.js';
import { sha256 } from '../src/crypto.js';
import { friendlyError } from '../src/log.js';
import { saveOwnerSettings, type MutableConfig } from '../src/owner-settings.js';

const LEADER = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
const OTHER = 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih';
const THIRD = Keypair.generate().publicKey.toBase58();

// A site with no RPC link: every sell fails the way the real one does offline.
const executor: Executor = {
  buy: async (r) => ({ ok: true, signature: 'B', tokens: 1000n, lamports: r.lamports, simulated: true }),
  sell: async () => { throw new Error('RPC_URL is not configured'); },
  quoteSell: async () => 1n, solBalance: async () => 2_000_000_000n, tokenBalance: async () => 0n, isLive: () => false,
};
const wallet = Keypair.generate();

let server: Server;
let base: string;
let store: Store;

beforeAll(async () => {
  store = new Store(':memory:');
  const engine = new Engine({ store, executor, walletFor: () => wallet, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01, zeroRecheckMs: 1 });
  server = createApp({
    store, engine, executor, masterKey: '11'.repeat(32), secureCookies: false, forgetWallet: () => {},
    serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'offline' }),
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

/** A user with a session made directly (the login door is tested elsewhere). */
function userClient(name: string): { uid: number; c: Client } {
  const uid = store.createUser(name, 'x');
  const token = randomBytes(16).toString('hex');
  store.createSession(sha256(token), uid, Date.now() + 3_600_000);
  const c = new Client();
  c.cookies.set('ml_session', token);
  return { uid, c };
}

/** A closed position with its sell, written the way the engine writes one. */
function closed(uid: number, copyId: number, mode: 'live' | 'paper', cost: bigint, proceeds: bigint): void {
  const s = store.copy(copyId)!.settings;
  const id = store.insertPosition({ userId: uid, copyId, mint: `M${Math.random()}`, mode, leaderSig: `s${Math.random()}`, sell: s.sell, copyName: s.name, leader: s.leader, now: Date.now() });
  store.updatePosition(id, { status: 'closed', tokensBought: 1n, tokensHeld: 0n, costLamports: cost, proceedsLamports: proceeds, closedAt: Date.now() });
  store.insertFill({ positionId: id, userId: uid, side: 'sell', reason: 'timed', tokens: 1n, lamports: proceeds, signature: 'x', simulated: mode === 'paper', error: null, feeLamports: 1_000n });
}

describe('B3: the owner\'s Users table', () => {
  it('"Profit" is real money only; test profit is apart; "Closed" counts every closed position of both kinds', async () => {
    const { uid } = userClient('Mixed');
    const copyId = store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 0.1 }));
    closed(uid, copyId, 'live', 1_000_000_000n, 1_250_000_000n); // +0.25 real
    closed(uid, copyId, 'live', 1_000_000_000n, 900_000_000n); // -0.10 real
    closed(uid, copyId, 'paper', 1_000_000_000n, 4_000_000_000n); // +3 test: never money
    const testOnly = userClient('Tester');
    const t = store.createCopy(testOnly.uid, validateSettings({ leader: LEADER, buySol: 0.1 }));
    closed(testOnly.uid, t, 'paper', 1_000_000_000n, 6_000_000_000n);

    const admin = new Client();
    expect((await admin.call('POST', '/api/admin/login', { password: 'correct horse battery' })).status).toBe(200);
    const users = (await admin.call('GET', '/api/admin/state')).body.users as { username: string; closed: number; pnlSol: number; testPnlSol: number }[];
    const mixed = users.find((u) => u.username === 'Mixed')!;
    expect(mixed.pnlSol).toBeCloseTo(0.15, 9);
    expect(mixed.testPnlSol).toBeCloseTo(3, 9);
    expect(mixed.closed).toBe(3);
    const tester = users.find((u) => u.username === 'Tester')!;
    expect(tester.pnlSol).toBe(0); // never a real trade
    expect(tester.testPnlSol).toBeCloseTo(5, 9);
    expect(tester.closed).toBe(1);
  });
});

describe('B2: History says when its list is cut', () => {
  it('also when real and test positions together pass 200 while neither kind alone does', async () => {
    const { uid, c } = userClient('Both kinds');
    const copyId = store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 0.1 }));
    for (let i = 0; i < 150; i++) closed(uid, copyId, 'live', 100n, 110n);
    for (let i = 0; i < 100; i++) closed(uid, copyId, 'paper', 100n, 90n);
    const h = (await c.call('GET', '/api/history')).body;
    expect(h.trades).toBe(150); // the heading: real ones only
    expect(h.kind).toBe('live'); // …and it says so ("150 real"), since the list under it holds test ones too
    expect(h.shown).toBe(200); // the newest 200 of both kinds are listed
    expect(h.closedAll).toBe(250); // so the page can say "the latest 200 of 250 closed positions (real and test) are listed"
  });
});

describe('B6: one copy per wallet', () => {
  it('a second copy of a wallet already copied is refused, naming the copy (paused or not); a deleted one does not count', async () => {
    const { c } = userClient('Twice');
    const first = await c.call('POST', '/api/copies', { leader: LEADER, name: 'Cupsey', buySol: 0.1 });
    expect(first.status).toBe(200);
    const again = await c.call('POST', '/api/copies', { leader: LEADER, name: 'Cupsey again', buySol: 0.2 });
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toMatch(/already cop(y|ies) this wallet/);
    expect(String(again.body.error)).toContain('"Cupsey"');
    // (a wallet typed with spaces around it is the same wallet)
    expect((await c.call('POST', '/api/copies', { leader: ` ${LEADER} `, buySol: 0.2 })).status).toBe(409);
    const st = await c.call('GET', '/api/state');
    expect((st.body.copies as { leader: string }[]).filter((x) => x.leader === LEADER)).toHaveLength(1);

    // Paused: still a copy of that wallet, and the refusal says it is paused.
    await c.call('PUT', `/api/copies/${first.body.id}`, { leader: LEADER, name: 'Cupsey', buySol: 0.1, enabled: false });
    const paused = await c.call('POST', '/api/copies', { leader: LEADER, buySol: 0.2 });
    expect(paused.status).toBe(409);
    expect(String(paused.body.error)).toMatch(/"Cupsey" \(paused\)/);

    // Deleted: gone, so the wallet can be copied again.
    expect((await c.call('DELETE', `/api/copies/${first.body.id}`)).status).toBe(200);
    expect((await c.call('POST', '/api/copies', { leader: LEADER, name: 'Cupsey 2', buySol: 0.1 })).status).toBe(200);
  });

  it('editing a copy onto a wallet another copy follows is refused; saving a copy with its own wallet is not', async () => {
    const { c } = userClient('Editor');
    const a = await c.call('POST', '/api/copies', { leader: LEADER, name: 'A', buySol: 0.1 });
    const b = await c.call('POST', '/api/copies', { leader: OTHER, name: 'B', buySol: 0.1 });
    expect((await c.call('PUT', `/api/copies/${a.body.id}`, { leader: LEADER, name: 'A', buySol: 0.3 })).status).toBe(200);
    const moved = await c.call('PUT', `/api/copies/${b.body.id}`, { leader: LEADER, name: 'B', buySol: 0.1 });
    expect(moved.status).toBe(409);
    expect(String(moved.body.error)).toContain('"A"');
    expect((await c.call('PUT', `/api/copies/${b.body.id}`, { leader: THIRD, name: 'B', buySol: 0.1 })).status).toBe(200);
  });

  it('two copies of one wallet saved before this rule can still each be paused and edited (only a move onto the wallet is refused)', async () => {
    const { uid, c } = userClient('Before the rule');
    const a = store.createCopy(uid, validateSettings({ leader: OTHER, name: 'Old A', buySol: 0.1 }));
    const b = store.createCopy(uid, validateSettings({ leader: OTHER, name: 'Old B', buySol: 0.2 }));
    expect((await c.call('PUT', `/api/copies/${a}`, { leader: OTHER, name: 'Old A', buySol: 0.1, enabled: false })).status).toBe(200);
    expect((await c.call('PUT', `/api/copies/${b}`, { leader: OTHER, name: 'Old B', buySol: 0.3 })).status).toBe(200);
    expect(store.copy(a)!.settings.enabled).toBe(false);
    expect(store.copy(b)!.settings.buySol).toBe(0.3);
  });

  it('two different accounts may copy the same wallet', async () => {
    const one = userClient('One');
    const two = userClient('Two');
    expect((await one.c.call('POST', '/api/copies', { leader: OTHER, buySol: 0.1 })).status).toBe(200);
    expect((await two.c.call('POST', '/api/copies', { leader: OTHER, buySol: 0.1 })).status).toBe(200);
  });
});

describe('B12: Sell now on a site with no RPC link', () => {
  it('says so in plain words, never the setting\'s name', async () => {
    expect(friendlyError('RPC_URL is not configured')).not.toMatch(/RPC_URL|configured/);
    expect(friendlyError('RPC_URL is not configured')).toMatch(/no connection to Solana/);

    const { uid, c } = userClient('Seller');
    const copyId = store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 0.1 }));
    const s = store.copy(copyId)!.settings;
    const id = store.insertPosition({ userId: uid, copyId, mint: 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump', mode: 'paper', leaderSig: 'L', sell: s.sell, copyName: s.name, leader: s.leader, now: Date.now() });
    store.updatePosition(id, { status: 'open', tokensBought: 1000n, tokensHeld: 1000n, costLamports: 100_000_000n, openedAt: Date.now() });
    const r = await c.call('POST', `/api/positions/${id}/sell`);
    expect(r.status).toBe(502);
    expect(String(r.body.error)).not.toMatch(/RPC_URL/);
    expect(String(r.body.error)).toMatch(/no connection to Solana/);
    expect(store.events(uid, 1)[0]!.message).not.toMatch(/RPC_URL/);
  });
});

describe('B14: the owner\'s "Max per buy"', () => {
  const cfg = (): MutableConfig => ({ rpcUrl: '', rpcWsUrl: '', jupiterUrl: '', jupiterApiKey: '', feeBps: 0, feeWallet: '', maxSolPerBuy: 30, liveTrading: false, masterKey: '11'.repeat(32) });
  const checks = { balance: async () => 5_000_000_000n };
  it('above the limit is refused with the limit, not with "must be above 0"', async () => {
    const err = await saveOwnerSettings(new Store(':memory:'), cfg(), { maxSolPerBuy: 2000 }, checks).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/at most 1000 SOL/);
    expect((err as Error).message).not.toMatch(/above 0/);
  });
  it('0 and below, or no number at all, are refused as before; 1000 is taken', async () => {
    for (const v of [0, -1, Number.NaN]) {
      const err = await saveOwnerSettings(new Store(':memory:'), cfg(), { maxSolPerBuy: v }, checks).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/above 0 SOL/);
    }
    const c = cfg();
    await saveOwnerSettings(new Store(':memory:'), c, { maxSolPerBuy: 1000 }, checks);
    expect(c.maxSolPerBuy).toBe(1000);
  });
});

describe('B18: a buy still on its way', () => {
  const pos = (over: Partial<Position>): Position => ({
    id: 1, userId: 1, copyId: 1, mint: 'M', mode: 'live', status: 'open', tokensBought: 100n, tokensHeld: 100n, costLamports: 10n, proceedsLamports: 0n,
    openedAt: Date.now(), closedAt: null, leaderSig: 'L', buySig: null, exitOwed: null, firedTimed: [], firedStop: [], deadFired: false, refValueLamports: null, lastChangeAt: Date.now(),
    sell: { mirror: { enabled: false, mode: 'same' }, timed: [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 30 }], timedOf: 'bag', stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } },
    copyName: 'Scharo', leader: 'X', decimals: 6, ...over,
  });
  it('does not count down to a timed sell (the timed sells count from our confirmed buy)', () => {
    expect(positionView(pos({ status: 'opening', openedAt: Date.now() - 20_000 })).nextTimedSell).toBeNull();
  });
  it('an open position still does, from its confirmed buy', () => {
    const v = positionView(pos({ status: 'open', openedAt: Date.now() - 1_000 })).nextTimedSell!;
    expect(v.percent).toBe(40);
    expect(v.inSec).toBe(1);
  });
});
