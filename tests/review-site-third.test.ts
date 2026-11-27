// From the third review of the site fixes (27 Nov 2026): the server's part. Each test here failed on the code before
// its fix.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import * as pnl from '../src/pnl.js';

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

function userClient(name: string) {
  const uid = store.createUser(name, 'x');
  const token = randomBytes(16).toString('hex');
  store.createSession(sha256(token), uid, Date.now() + 3_600_000);
  const get = async (path: string) => (await (await fetch(base + path, { headers: { cookie: `ml_session=${token}` } })).json()) as Record<string, any>;
  return { uid, get };
}

/** A position written the way the engine writes one: closed (with `closedAt`, and a sell with a fee), or still open. */
function position(uid: number, copyId: number, mode: 'live' | 'paper', cost: bigint, proceeds: bigint, closedAt: number | null): void {
  const s = store.copy(copyId)!.settings;
  const id = store.insertPosition({ userId: uid, copyId, mint: `M${Math.random()}`, mode, leaderSig: `s${Math.random()}`, sell: s.sell, copyName: s.name, leader: s.leader, now: (closedAt ?? Date.now()) - 60_000 });
  if (closedAt === null) store.updatePosition(id, { status: 'open', tokensBought: 1000n, tokensHeld: 1000n, costLamports: cost, openedAt: Date.now() - 60_000 });
  else {
    store.updatePosition(id, { status: 'closed', tokensBought: 1n, tokensHeld: 0n, costLamports: cost, proceedsLamports: proceeds, closedAt });
    store.insertFill({ positionId: id, userId: uid, side: 'sell', reason: 'timed', tokens: 1n, lamports: proceeds, signature: 'x', simulated: mode === 'paper', error: null, feeLamports: 1_000n });
  }
}

const SOL = 1_000_000_000n;
const leader = () => Keypair.generate().publicKey.toBase58();

describe('N1: the dashboard\'s poll reads the closed positions once for the copy lines', () => {
  it('one pass for the copy lines and one for the days, with no pass over the fills (it was three of each kind, every 3 s per open page)', async () => {
    const { uid, get } = userClient('Busy poller');
    const copies = [0, 1, 2].map((i) => store.createCopy(uid, validateSettings({ leader: leader(), name: `c${i}`, buySol: 0.1 })));
    for (let i = 0; i < 30; i++) position(uid, copies[i % 3]!, i % 4 === 0 ? 'paper' : 'live', SOL, SOL + BigInt(i) * 1_000_000n, Date.now() - i * 3_600_000);
    position(uid, copies[0]!, 'live', SOL, 0n, null);
    const db = store as unknown as Record<'all' | 'get', (sql: string, ...p: unknown[]) => unknown>;
    const all = vi.spyOn(db, 'all');
    const one = vi.spyOn(db, 'get');
    try {
      await get('/api/state?tz=60&zone=Europe%2FBerlin');
      const sql = [...all.mock.calls, ...one.mock.calls].map((c) => String(c[0]).replace(/\s+/g, ' '));
      // The closed positions read whole (not the one-row lookup of the first and last closing time).
      const passes = sql.filter((s) => /status = 'closed'/.test(s) && !/MIN\(closed_at\)/.test(s));
      expect(passes, passes.join('\n')).toHaveLength(2);
      expect(sql.filter((s) => /FROM fills/.test(s)), 'a pass over the fills').toEqual([]);
    } finally {
      all.mockRestore();
      one.mockRestore();
    }
  });

  it('the copy lines say what they said: random accounts against the totals of every closed position', async () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % n; };
    for (let a = 0; a < 8; a++) {
      const { uid, get } = userClient(`Random ${a}`);
      const copies = Array.from({ length: 1 + rnd(4) }, (_, i) => store.createCopy(uid, validateSettings({ leader: leader(), name: `r${a}-${i}`, buySol: 0.1 })));
      for (let i = rnd(40); i > 0; i--) {
        const mode = rnd(3) === 0 ? 'live' : 'paper';
        const open = rnd(5) === 0;
        position(uid, copies[rnd(copies.length)]!, mode, BigInt(1 + rnd(5)) * SOL / 10n, BigInt(rnd(9)) * SOL / 10n, open ? null : Date.now() - rnd(90) * 86_400_000 - 1000);
      }
      // What the copy lines are: of one kind (real once a real position has closed), the other kind apart.
      const live = store.closedTotals(uid, 'live');
      const test = store.closedTotals(uid, 'paper');
      const shown = live.trades > 0 ? 'live' : 'test';
      const active = store.activePositions(uid);
      const want = (copyId: number) => {
        const part = (k: 'live' | 'test') => {
          const t = (k === 'live' ? live : test).byCopy.get(copyId);
          return { kind: k, open: active.filter((p) => p.copyId === copyId && (p.mode === 'live' ? 'live' : 'test') === k).length, closed: t?.closed ?? 0, pnlSol: Number((Number(t?.pnlLamports ?? 0n) / 1e9).toFixed(9)) };
        };
        const other = shown === 'live' ? 'test' : 'live';
        const { kind, ...main } = part(shown);
        return { kind, ...main, other: part(other) };
      };
      const st = await get('/api/state');
      for (const c of st.copies as { id: number; stats: unknown }[]) expect(c.stats, `account ${a}, copy ${c.id}`).toEqual(want(c.id));
    }
  });
});

describe('N2: the time-zone caches are kept under the zone\'s own name, and bounded', () => {
  const DAY = 86_400_000;
  const NOV27 = Date.UTC(2026, 10, 27, 12, 0);
  const setup = () => {
    const s = new Store(':memory:');
    const u = s.createUser('z', 'x');
    const copy = s.createCopy(u, validateSettings({ leader: leader(), buySol: 0.1 }));
    const close = (closedAt: number) => {
      const id = s.insertPosition({ userId: u, copyId: copy, mint: `m${Math.random()}`, mode: 'live', leaderSig: 'x', sell: validateSettings({ leader: leader(), buySol: 0.1 }).sell, copyName: 'c', leader: 'L', now: closedAt - 60_000 });
      s.updatePosition(id, { mode: 'live', status: 'closed', costLamports: SOL, proceedsLamports: 2n * SOL, closedAt });
    };
    return { s, u, close };
  };
  const days = (p: ReturnType<typeof pnl.pnlSummary>) => p.days.map((d) => d.date);
  const sizes = () => (pnl as Record<string, any>).zoneCacheSizes() as { names: number; clocks: number; offsets: number };
  /** Every letter case of a name, as many as asked (the page may send any; Intl takes them all). */
  const spellings = (zone: string, n: number) => Array.from({ length: n }, (_, i) => [...zone].map((ch, k) => ((i >> (k % 20)) & 1 ? ch.toUpperCase() : ch.toLowerCase())).join(''));

  it('2,000 letter cases of one zone are one clock and one stretch of offsets (each was a new clock and a new pass over the whole history)', () => {
    const { s, u, close } = setup();
    close(Date.UTC(2026, 9, 18, 22, 30)); // 19:30 on 18 Oct in Buenos Aires (UTC−3)
    close(Date.UTC(2025, 2, 1, 2, 30)); // 23:30 on 28 Feb 2025 there
    const before = sizes();
    for (const z of spellings('America/Argentina/Buenos_Aires', 2000)) expect(days(pnl.pnlSummary(s, u, -180, NOV27, z)), z).toEqual(['2026-10-18', '2025-02-28']);
    const after = sizes();
    expect(after.clocks - before.clocks).toBeLessThanOrEqual(1);
    expect(after.offsets - before.offsets).toBeLessThanOrEqual(1);
    expect(after.names - before.names).toBeLessThanOrEqual(1);
  });

  it('a zone under another of its names is the same zone (US/Pacific, America/Los_Angeles; Asia/Calcutta, Asia/Kolkata)', () => {
    const { s, u, close } = setup();
    close(Date.UTC(2026, 9, 25, 7, 30)); // 00:30 on 25 Oct in Los Angeles (summer time), 13:00 in Kolkata
    close(Date.UTC(2026, 9, 25, 18, 45)); // 11:45 on 25 Oct in Los Angeles, 00:15 on 26 Oct in Kolkata
    expect(days(pnl.pnlSummary(s, u, -480, NOV27, 'America/Los_Angeles'))).toEqual(['2026-10-25']);
    const la = sizes();
    expect(days(pnl.pnlSummary(s, u, -480, NOV27, 'US/Pacific'))).toEqual(['2026-10-25']);
    expect(days(pnl.pnlSummary(s, u, -480, NOV27, 'us/pacific'))).toEqual(['2026-10-25']);
    expect(sizes().clocks).toBe(la.clocks);
    expect(sizes().offsets).toBe(la.offsets);
    expect(days(pnl.pnlSummary(s, u, 330, NOV27, 'Asia/Kolkata'))).toEqual(['2026-10-26', '2026-10-25']);
    expect(days(pnl.pnlSummary(s, u, 330, NOV27, 'Asia/Calcutta'))).toEqual(['2026-10-26', '2026-10-25']);
  });

  it('however many zones are asked for, the caches stay bounded, and a zone asked again after being forgotten is still right', () => {
    const { s, u, close } = setup();
    close(Date.UTC(2026, 9, 18, 22, 30)); // 00:30 on 19 Oct in Berlin (summer time)
    expect(days(pnl.pnlSummary(s, u, 60, NOV27, 'Europe/Berlin'))).toEqual(['2026-10-19']);
    const zones = Intl.supportedValuesOf('timeZone');
    expect(zones.length).toBeGreaterThan(300);
    for (const z of zones) pnl.pnlSummary(s, u, 0, NOV27, z);
    for (const z of zones) pnl.pnlSummary(s, u, 0, NOV27, z.toUpperCase());
    const n = sizes();
    expect(n.clocks).toBeLessThanOrEqual(64);
    expect(n.offsets).toBeLessThanOrEqual(64);
    expect(n.names).toBeLessThanOrEqual(1024);
    expect(days(pnl.pnlSummary(s, u, 60, NOV27, 'Europe/Berlin'))).toEqual(['2026-10-19']);
    expect(days(pnl.pnlSummary(s, u, 60, NOV27 + DAY, 'europe/berlin'))).toEqual(['2026-10-19']);
  });

  it('a name this machine does not know is still refused, and falls back to the offset the page sent', () => {
    const { s, u, close } = setup();
    close(Date.UTC(2026, 9, 18, 22, 30));
    for (const z of ['Mars/Olympus', 'Europe/Berlinn', '', 'x'.repeat(65), '../etc/passwd']) {
      expect(pnl.knownZone(z), JSON.stringify(z)).toBeNull();
      expect(days(pnl.pnlSummary(s, u, 60, NOV27, z)), JSON.stringify(z)).toEqual(['2026-10-18']);
    }
    // A known zone is still known as the page spelled it.
    for (const z of ['Europe/Berlin', 'europe/berlin', 'US/Pacific', 'UTC']) expect(pnl.knownZone(z)).toBe(z);
  });
});
