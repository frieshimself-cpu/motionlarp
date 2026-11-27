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
  let logCb: ((sig: string, logs?: string[], slot?: number) => void) | null = null;
  const w = new Watcher({
    leaders: () => [LEADER],
    onTrade: async (t) => { trades.push(t); },
    pollMs: 0,
    getSignatures: async () => sigs,
    getTransaction: async (s) => { fetched.push(s); return s === SIG ? buyTx : null; },
    subscribe: (_leader, cb) => { logCb = cb; return () => { logCb = null; }; },
    fetchRetryMs: 1,
  });
  return { w, trades, fetched, push: (s: SignatureInfo[]) => { sigs = [...s, ...sigs]; }, ws: (s: string, logs?: string[], slot?: number) => logCb?.(s, logs, slot) };
}

describe('Watcher', () => {
  it('the first poll only sets the starting point: history is never copied', async () => {
    const { w, fetched } = setup();
    await w.sync();
    expect(fetched).toEqual([]);
  });

  it("a buy that came by the Helius stream or a fetch carries pump.fun's curve from its event too (the copy needs no read)", async () => {
    const viaStream = setup();
    await viaStream.w.sync();
    viaStream.w.handleStreamTx(buyTx);
    await viaStream.w.drain();
    const viaPoll = setup();
    await viaPoll.w.sync();
    viaPoll.push([{ signature: SIG, slot: 2, err: null, blockTime: 2 }]);
    await viaPoll.w.sync();
    for (const { trades } of [viaStream, viaPoll]) {
      expect(trades).toHaveLength(1);
      expect(trades[0]!.side).toBe('buy');
      expect(trades[0]!.curve).toMatchObject({ tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', mayhem: true, cashback: false }); // (this coin is a mayhem coin)
      expect(trades[0]!.curve!.realTokenReserves).toBeGreaterThan(0n);
      expect(trades[0]!.heardAt).toBeGreaterThan(0);
      expect(trades[0]!.approx).toBeUndefined(); // the amounts are the full transaction's own (exact), not the event's
    }
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

  it('a plain transfer is not fetched; anything touching a trading program is (any DEX or launchpad)', async () => {
    const { w, ws, fetched } = setup();
    await w.sync();
    ws('transfer1', ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]']);
    ws('raydium1', ['Program LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj invoke [1]']);
    await w.drain();
    expect(fetched.filter((s) => s === 'transfer1')).toHaveLength(0);
    expect(fetched.filter((s) => s === 'raydium1').length).toBeGreaterThan(0);
  });

  it('a coin bought with another currency is valued in SOL before it reaches the engine', async () => {
    const tx = JSON.parse(readFileSync('tests/fixtures/tx/launchlab_buy.json', 'utf8')) as RawTransaction;
    const leader = '9f8ma9n3DXCfPGmCh71pMxanSp4Cjj2h9HScnNp7GxTJ';
    const keys = tx.transaction.message.accountKeys as string[];
    const i = keys.indexOf(leader);
    const post = [...tx.meta!.postBalances]; post[i] = tx.meta!.preBalances[i]! - tx.meta!.fee;
    const usdcTx: RawTransaction = { ...tx, transaction: { ...tx.transaction, message: { accountKeys: [...keys, 'PayAcct1111111111111111111111111111111111111'] } }, meta: { ...tx.meta!, postBalances: [...post, 1], preBalances: [...tx.meta!.preBalances, 1], preTokenBalances: [...(tx.meta!.preTokenBalances ?? []), { accountIndex: keys.length, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: leader, uiTokenAmount: { amount: '100000000', decimals: 6 } }], postTokenBalances: [...(tx.meta!.postTokenBalances ?? []), { accountIndex: keys.length, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: leader, uiTokenAmount: { amount: '0', decimals: 6 } }] } };
    const trades: LeaderTrade[] = [];
    const w = new Watcher({ leaders: () => [leader], onTrade: async (t) => { trades.push(t); }, pollMs: 0, getSignatures: async () => [], getTransaction: async () => usdcTx, fetchRetryMs: 1, valueInSol: async (mint, amount) => (mint.startsWith('EPjF') ? amount * 7n : 0n) });
    w.handle('usdcbuy', leader);
    await w.drain();
    expect(trades[0]).toMatchObject({ side: 'buy', solLamports: 700_000_000n });
  });

  it('fast path: a pump.fun buy in the socket logs is passed on without fetching the transaction', async () => {
    const { w, ws, fetched, trades } = setup();
    await w.sync();
    ws(SIG, buyTx.meta!.logMessages!, 123);
    await w.drain();
    expect(fetched).toEqual([]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: 'buy', leader: LEADER, slot: 123 });
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

  describe('with the Helius transaction stream', () => {
    const sellTx = JSON.parse(readFileSync('tests/fixtures/tx/curve_wallet_sell.json', 'utf8')) as RawTransaction;
    const SELLER = 'GEXh5zqvGrydevffihQ37KKz2s2mQxfDP6tDkQcaCVCM';
    function streamSetup(healthy: () => boolean) {
      const fetched: string[] = [];
      const trades: LeaderTrade[] = [];
      let sigs: SignatureInfo[] = [];
      let logCb: ((sig: string, logs?: string[], slot?: number) => void) | null = null;
      const w = new Watcher({
        leaders: () => [SELLER], onTrade: async (t) => { trades.push(t); }, pollMs: 0, fetchRetryMs: 1, streamHealthy: healthy,
        getSignatures: async () => sigs,
        getTransaction: async (s) => { fetched.push(s); return s === sellTx.transaction.signatures[0] ? sellTx : null; },
        subscribe: (_l, cb) => { logCb = cb; return () => {}; },
      });
      return { w, trades, fetched, push: (s: SignatureInfo[]) => { sigs = [...s, ...sigs]; }, ws: (s: string, logs?: string[], slot?: number) => logCb?.(s, logs, slot) };
    }
    const SELL_SIG = sellTx.transaction.signatures[0]!;
    const sellLogs = ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]'];

    it('a sell arrives as a full transaction: passed on at once, never fetched', async () => {
      const { w, trades, fetched } = streamSetup(() => true);
      await w.sync();
      w.handleStreamTx(sellTx);
      await w.drain();
      expect(trades).toHaveLength(1);
      expect(trades[0]).toMatchObject({ side: 'sell', leader: SELLER, tokensAfter: 0n });
      expect(fetched).toEqual([]);
    });

    it('while the stream is healthy the standard socket does not fetch what the stream will bring', async () => {
      const { w, ws, trades, fetched } = streamSetup(() => true);
      await w.sync();
      ws(SELL_SIG, sellLogs, 5);
      await w.drain();
      expect(fetched).toEqual([]);
      w.handleStreamTx(sellTx);
      w.handleStreamTx(sellTx); // delivered twice by the stream: handled once
      await w.drain();
      expect(trades).toHaveLength(1);
    });

    it('if the stream missed one, the poll still catches it', async () => {
      const { w, ws, trades, push } = streamSetup(() => true);
      await w.sync();
      ws(SELL_SIG, sellLogs, 5); // seen by the socket, left for the stream… which never delivers
      push([{ signature: SELL_SIG, slot: 9, err: null, blockTime: 9 }]);
      await w.sync();
      expect(trades).toHaveLength(1);
    });

    it('stream down: the standard socket fetches as before', async () => {
      const { w, ws, trades, fetched } = streamSetup(() => false);
      await w.sync();
      ws(SELL_SIG, sellLogs, 5);
      await w.drain();
      expect(fetched).toEqual([SELL_SIG]);
      expect(trades).toHaveLength(1);
    });

    it('a transaction of a wallet nobody copies is ignored', async () => {
      const { w, trades } = streamSetup(() => true);
      await w.sync();
      w.handleStreamTx(buyTx); // LEADER is not in this watcher's list
      await w.drain();
      expect(trades).toEqual([]);
    });
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
