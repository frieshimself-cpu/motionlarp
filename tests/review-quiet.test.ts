// Updates restart the app only at a quiet moment (27 Nov 2026): the app says how busy it is, to the updater on its own
// machine only (deploy/update.sh asks from inside the app's container; tests/update.test.ts covers the updater).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/http/app.js';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/store.js';
import { validateSettings } from '../src/engine/settings.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const SOL = 1_000_000_000n;
const LEADER = 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih';
const MINT = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';

function setup(sell: Record<string, unknown>) {
  const store = new Store(':memory:');
  const uid = store.createUser('u', 'x');
  const wallet = Keypair.generate();
  store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
  store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 1, minLeaderBuySol: 0, sell }));
  let clock = 1_000_000;
  let hold: Promise<void> | null = null;
  const executor = {
    buy: async (r: { lamports: bigint }) => { if (hold) await hold; return { ok: true as const, signature: 'B', tokens: 1_000_000n, lamports: r.lamports, simulated: true }; },
    sell: async (r: { tokens: bigint }) => ({ ok: true as const, signature: 'S', tokens: r.tokens, lamports: SOL, simulated: true }),
    quoteSell: async () => SOL, solBalance: async () => 10n * SOL, tokenBalance: async () => 0n, isLive: () => false,
  };
  const engine = new Engine({ store, executor, walletFor: () => wallet, now: () => clock, priceMs: 2_000, maxSolPerBuy: 10, feeReserveSol: 0.01 });
  const trade = (): LeaderTrade => ({ signature: `s${Math.random()}`, leader: LEADER, mint: MINT, side: 'buy', solLamports: 2n * SOL, tokenAmount: 1n, tokensBefore: 0n, tokensAfter: 1n, venue: 'pumpfun', slot: 1, blockTime: null });
  return { store, engine, trade, advance: (ms: number) => { clock += ms; }, holdBuys: (p: Promise<void> | null) => { hold = p; } };
}

describe('how busy the engine is', () => {
  const mirrorOnly = { mirror: { enabled: true, mode: 'exit' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } };
  const scharo = { mirror: { enabled: true, mode: 'exit' }, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 30 }, { afterSec: 60, percent: 100 }], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } };

  it('idle with nothing open; trading while a buy is under way', async () => {
    const s = setup(mirrorOnly);
    expect(s.engine.quietness()).toBe('idle');
    let release: () => void = () => undefined;
    s.holdBuys(new Promise((r) => { release = r; }));
    await s.engine.onLeaderTrade(s.trade());
    expect(s.engine.quietness()).toBe('trading');
    release();
    await s.engine.idle();
  });

  it('calm with a position open whose only exit waits for the copied wallet', async () => {
    const s = setup(mirrorOnly);
    await s.engine.onLeaderTrade(s.trade());
    await s.engine.idle();
    expect(s.store.activePositions()).toHaveLength(1);
    expect(s.engine.quietness()).toBe('calm');
  });

  it('due while a timed sell comes up within 30 s; calm again once only the far one is left', async () => {
    const s = setup(scharo);
    await s.engine.onLeaderTrade(s.trade());
    await s.engine.idle();
    expect(s.engine.quietness()).toBe('due'); // the +2 s step
    s.advance(5_000);
    await s.engine.tick();
    await s.engine.idle();
    expect(s.engine.quietness()).toBe('calm'); // the +60 s step is 55 s away
    s.advance(30_000);
    expect(s.engine.quietness()).toBe('due');
  });
});

describe('the quiet answer is for this machine only', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    const s = setup({ mirror: { enabled: true, mode: 'exit' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } });
    server = createApp({
      store: s.store, engine: s.engine, executor: { buy: async () => ({ ok: false, error: 'x' }), sell: async () => ({ ok: false, error: 'x' }), quoteSell: async () => 1n, solBalance: async () => 1n, tokenBalance: async () => 0n, isLive: () => false },
      masterKey: '11'.repeat(32), secureCookies: false, forgetWallet: () => {}, trustProxy: true,
      serverInfo: () => ({ live: false, maxSolPerBuy: 1, watching: 0, mode: 'test' }),
    });
    await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('asked from this machine, it answers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/quiet`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'idle' });
  });

  it('asked from another address it does not exist, whatever a forwarded header says', async () => {
    const outside = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!outside) return; // no other interface here to ask from
    const res = await fetch(`http://${outside}:${port}/api/quiet`, { headers: { 'x-forwarded-for': '127.0.0.1' } });
    expect(res.status).toBe(404);
  });
});
