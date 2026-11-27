// From two reviews of the site fixes (27 Nov 2026), each finding reproduced in a browser: the server's part. Each test
// here failed on the code before its fix.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/http/app.js';
import { Engine } from '../src/engine/engine.js';
import type { Executor } from '../src/engine/executor.js';
import { Store } from '../src/store.js';
import { validateSettings } from '../src/engine/settings.js';
import { sha256 } from '../src/crypto.js';

const executor: Executor = {
  buy: async (r) => ({ ok: true, signature: 'B', tokens: 1000n, lamports: r.lamports, simulated: true }),
  sell: async () => { throw new Error('RPC_URL is not configured'); },
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
    serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'offline' }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A user with a session made directly, and a way to call the API as them. */
function userClient(name: string) {
  const uid = store.createUser(name, 'x');
  const token = randomBytes(16).toString('hex');
  store.createSession(sha256(token), uid, Date.now() + 3_600_000);
  const get = async (path: string) => (await (await fetch(base + path, { headers: { cookie: `ml_session=${token}` } })).json()) as Record<string, any>;
  return { uid, get };
}

/** A position written the way the engine writes one: closed (with `closedAt`), or still open. */
function position(uid: number, copyId: number, mode: 'live' | 'paper', cost: bigint, proceeds: bigint, closedAt: number | null): void {
  const s = store.copy(copyId)!.settings;
  const id = store.insertPosition({ userId: uid, copyId, mint: `M${Math.random()}`, mode, leaderSig: `s${Math.random()}`, sell: s.sell, copyName: s.name, leader: s.leader, now: (closedAt ?? Date.now()) - 60_000 });
  if (closedAt === null) store.updatePosition(id, { status: 'open', tokensBought: 1000n, tokensHeld: 1000n, costLamports: cost, openedAt: Date.now() - 60_000 });
  else store.updatePosition(id, { status: 'closed', tokensBought: 1n, tokensHeld: 0n, costLamports: cost, proceedsLamports: proceeds, closedAt });
}

const SOL = 1_000_000_000n;
const leader = () => Keypair.generate().publicKey.toBase58();

describe('6: a copy\'s line on the dashboard is of one kind, the other kind apart', () => {
  it('open positions are counted of the shown kind only (real once there are real trades); the test ones come apart, with their closed ones and profit', async () => {
    const { uid, get } = userClient('Both kinds on one copy');
    const copyId = store.createCopy(uid, validateSettings({ leader: leader(), name: 'AllOn all', buySol: 0.1 }));
    position(uid, copyId, 'live', SOL, SOL + SOL / 4n, Date.now() - 3_600_000); // real, closed: +0.25
    position(uid, copyId, 'paper', SOL, 0n, null); // test, still open
    position(uid, copyId, 'paper', SOL, 2n * SOL, Date.now() - 7_200_000); // test, closed: +1
    position(uid, copyId, 'paper', SOL, SOL / 2n, Date.now() - 7_200_000); // test, closed: −0.5
    const st = await get('/api/state');
    const c = (st.copies as { id: number; stats: unknown }[]).find((x) => x.id === copyId)!;
    // It read "1 open · 1 closed · +0.25 SOL": the open one was a test position, the closed ones and profit real ones.
    expect(c.stats).toEqual({ kind: 'live', open: 0, closed: 1, pnlSol: 0.25, other: { kind: 'test', open: 1, closed: 2, pnlSol: 0.5 } });
  });

  it('before any real trade has closed the line is of test trades, and a real position already open is counted apart', async () => {
    const { uid, get } = userClient('First real buy');
    const copyId = store.createCopy(uid, validateSettings({ leader: leader(), buySol: 0.1 }));
    position(uid, copyId, 'paper', SOL, 3n * SOL, Date.now() - 3_600_000); // test, closed: +2
    position(uid, copyId, 'live', SOL, 0n, null); // the first real buy, open
    const c = ((await get('/api/state')).copies as { id: number; stats: unknown }[]).find((x) => x.id === copyId)!;
    expect(c.stats).toEqual({ kind: 'test', open: 0, closed: 1, pnlSol: 2, other: { kind: 'live', open: 1, closed: 0, pnlSol: 0 } });
    // A copy with nothing yet has the same shape (the page reads both parts).
    const empty = store.createCopy(uid, validateSettings({ leader: leader(), buySol: 0.1 }));
    const e = ((await get('/api/state')).copies as { id: number; stats: unknown }[]).find((x) => x.id === empty)!;
    expect(e.stats).toEqual({ kind: 'test', open: 0, closed: 0, pnlSol: 0, other: { kind: 'live', open: 0, closed: 0, pnlSol: 0 } });
  });
});

describe('8 (B17): the days of History follow the viewer\'s time zone, across a change of the clocks', () => {
  it('a trade closed at 22:30 UTC on 18 October is listed on the 19th for a viewer in Berlin; an unknown zone falls back to the offset', async () => {
    const { uid, get } = userClient('Berliner');
    const copyId = store.createCopy(uid, validateSettings({ leader: leader(), buySol: 0.1 }));
    position(uid, copyId, 'live', SOL, 2n * SOL, Date.UTC(2026, 9, 18, 22, 30));
    const days = (h: Record<string, any>) => (h.pnl.days as { date: string }[]).map((d) => d.date);
    expect(days(await get('/api/history?tz=60&zone=Europe%2FBerlin'))).toEqual(['2026-10-19']);
    expect(days(await get('/api/history?tz=60&zone=Mars%2FOlympus'))).toEqual(['2026-10-18']);
    expect(days(await get('/api/history?tz=60'))).toEqual(['2026-10-18']);
  });

  it('"today" on the dashboard is the viewer\'s day in their zone, whatever offset came with it', async () => {
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles']) {
      const { uid, get } = userClient(`Viewer in ${zone}`);
      const copyId = store.createCopy(uid, validateSettings({ leader: leader(), buySol: 0.1 }));
      const local = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
      const utc = (t: number) => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      // A closing time in the last day that is "today" on one of the two calendars and not on the other.
      const t = Array.from({ length: 23 }, (_, k) => now - (k + 1) * 3_600_000).find((x) => (local(x) === local(now)) !== (utc(x) === utc(now)))!;
      position(uid, copyId, 'live', SOL, 2n * SOL, t);
      const st = await get(`/api/state?tz=0&zone=${encodeURIComponent(zone)}`);
      expect(st.pnl.live.todaySol, `${zone}: closed ${new Date(t).toISOString()}`).toBe(local(t) === local(now) ? 1 : 0);
    }
  });
});
