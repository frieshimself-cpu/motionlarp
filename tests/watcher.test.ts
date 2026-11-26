import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RawTransaction, SignatureInfo } from '../src/chain/rpc.js';
import { Watcher } from '../src/watch/watcher.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const LEADER = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
const buyTx = JSON.parse(readFileSync('tests/fixtures/tx/curve_buy.json', 'utf8')) as RawTransaction;
const SIG = buyTx.transaction.signatures[0]!;

function setup() {
  let sigs: SignatureInfo[] = [{ signature: 'old1', slot: 1, err: null, blockTime: 1 }];
  const fetched: string[] = [];
  const trades: LeaderTrade[] = [];
  let logCb: ((sig: string, logs?: string[]) => void) | null = null;
  const w = new Watcher({
    leaders: () => [LEADER],
    onTrade: async (t) => { trades.push(t); },
    pollMs: 0,
    getSignatures: async () => sigs,
    getTransaction: async (s) => { fetched.push(s); return s === SIG ? buyTx : null; },
    subscribe: (_leader, cb) => { logCb = cb; return () => { logCb = null; }; },
    fetchRetryMs: 1,
  });
  return { w, trades, fetched, push: (s: SignatureInfo[]) => { sigs = [...s, ...sigs]; }, ws: (s: string, logs?: string[]) => logCb?.(s, logs) };
}

describe('Watcher', () => {
  it('the first poll only sets the starting point: history is never copied', async () => {
    const { w, fetched } = setup();
    await w.sync();
    expect(fetched).toEqual([]);
  });

  it('a new signature from the poller is fetched, parsed and passed on', async () => {
    const { w, push, trades } = setup();
    await w.sync();
    push([{ signature: SIG, slot: 2, err: null, blockTime: 2 }]);
    await w.sync();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: 'buy', leader: LEADER });
  });

  it('the same signature from the socket and the poller is handled once', async () => {
    const { w, push, trades, ws, fetched } = setup();
    await w.sync();
    ws(SIG);
    push([{ signature: SIG, slot: 2, err: null, blockTime: 2 }]);
    await w.sync();
    await w.drain();
    expect(trades).toHaveLength(1);
    expect(fetched.filter((s) => s === SIG)).toHaveLength(1);
  });

  it('failed signatures are not fetched; a transaction that never appears is dropped after retries', async () => {
    const { w, push, fetched, trades } = setup();
    await w.sync();
    push([{ signature: 'bad', slot: 3, err: { x: 1 }, blockTime: 3 }, { signature: 'missing', slot: 3, err: null, blockTime: 3 }]);
    await w.sync();
    expect(fetched.includes('bad')).toBe(false);
    expect(fetched.filter((s) => s === 'missing').length).toBeGreaterThan(1);
    expect(trades).toEqual([]);
  });

  it('a socket notification whose logs never touch pump.fun is not fetched', async () => {
    const { w, ws, fetched } = setup();
    await w.sync();
    ws('transfer1', ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success']);
    ws(SIG, ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]']);
    await w.drain();
    expect(fetched).toEqual([SIG]);
  });

  it('never runs more than the allowed fetches at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const w = new Watcher({
      leaders: () => [LEADER], onTrade: async () => {}, pollMs: 0, getSignatures: async () => [], maxConcurrentFetches: 2, fetchRetryMs: 1,
      getTransaction: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return buyTx; },
    });
    for (let i = 0; i < 10; i++) w.handle(`s${i}`, LEADER);
    await w.drain();
    expect(peak).toBe(2);
  });

  it('a wallet with no history yet: later polls send no empty cursor and pick up its first trade', async () => {
    const untils: (string | undefined)[] = [];
    let sigs: SignatureInfo[] = [];
    const trades: LeaderTrade[] = [];
    const w = new Watcher({
      leaders: () => [LEADER], onTrade: async (t) => { trades.push(t); }, pollMs: 0, fetchRetryMs: 1,
      getSignatures: async (_l, until) => { untils.push(until); return sigs; },
      getTransaction: async (s) => (s === SIG ? buyTx : null),
    });
    await w.sync();
    sigs = [{ signature: SIG, slot: 2, err: null, blockTime: 2 }];
    await w.sync();
    expect(untils).toEqual([undefined, undefined]);
    expect(trades).toHaveLength(1);
  });

  it('unsubscribes a leader nobody follows any more', async () => {
    let leaders = [LEADER];
    let unsubscribed = 0;
    const w = new Watcher({ leaders: () => leaders, onTrade: async () => {}, pollMs: 0, getSignatures: async () => [], getTransaction: async () => null, subscribe: () => () => { unsubscribed++; }, fetchRetryMs: 1 });
    await w.sync();
    leaders = [];
    await w.sync();
    expect(unsubscribed).toBe(1);
    expect(w.watching()).toEqual([]);
  });
});
