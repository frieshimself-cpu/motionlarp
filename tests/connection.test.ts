// The RPC connection rules found in review (27 Nov 2026): requests with no time limit, a hidden 0.5–4 s back-off on
// a rate limit, and buys signed with a blockhash that stays valid for half a minute.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { config } from '../src/config.js';
import { BUY_BLOCKHASH_MIN_BLOCKS, boundedFetch, getBlockhash, getShortBlockhash, setBlockhashesForTests, setConnectionForTests } from '../src/chain/connection.js';

const saved = { ...config };
afterEach(() => {
  Object.assign(config, saved);
  vi.unstubAllGlobals();
  setConnectionForTests(null);
});

describe('a blockhash for a buy lives only a few seconds more', () => {
  const NOW = 1_000_000;
  // One blockhash fetched every 2 s (10 blocks apart at 0.2 s a block), the newest just now at height 1000.
  const history = (n: number) => Array.from({ length: n }, (_, i) => {
    const age = n - 1 - i; // in fetches
    return { blockhash: `bh${age}`, lastValidBlockHeight: 1000 + 150 - age * 10, at: NOW - age * 2000 };
  });
  const fresh = () => setConnectionForTests({ getLatestBlockhash: async () => ({ blockhash: 'fetched', lastValidBlockHeight: 9999 }) } as unknown as Connection);

  it('picks the oldest one that still has the minimum left', async () => {
    fresh();
    setBlockhashesForTests(history(16)); // ages 0..15 -> 150, 140, ... 0 blocks left
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const bh = await getShortBlockhash(NOW);
    expect(bh.lastValidBlockHeight - 1000).toBe(BUY_BLOCKHASH_MIN_BLOCKS); // exactly 40 blocks left: about 8 s
    expect(bh.blockhash).toBe('bh11');
    vi.restoreAllMocks();
  });

  it('counts the blocks that went by since the last fetch, on the safe side', async () => {
    fresh();
    setBlockhashesForTests(history(16));
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1000);
    // 1 s later: at least 5 more blocks, so the 40-left one may have only 35: the next younger one is used.
    const bh = await getShortBlockhash(NOW + 1000);
    expect(bh.blockhash).toBe('bh10');
    expect(bh.lastValidBlockHeight - (1000 + 5)).toBeGreaterThanOrEqual(BUY_BLOCKHASH_MIN_BLOCKS);
    vi.restoreAllMocks();
  });

  it('just after a start there is no history: the newest one is used', async () => {
    fresh();
    setBlockhashesForTests(history(1));
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    expect((await getShortBlockhash(NOW)).blockhash).toBe('bh0');
    vi.restoreAllMocks();
  });

  it('a sell still gets the newest one (full life)', async () => {
    fresh();
    setBlockhashesForTests(history(16));
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    expect((await getBlockhash()).blockhash).toBe('bh0');
    vi.restoreAllMocks();
  });
});

describe('every RPC request is bounded', () => {
  it('a rate-limit answer is tried again within a fraction of a second, not after web3.js\'s 0.5–4 s', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => (++n < 3 ? new Response('busy', { status: 429 }) : new Response('{"ok":true}', { status: 200 })));
    const t0 = Date.now();
    const res = await boundedFetch('https://rpc.test');
    expect(res.status).toBe(200);
    expect(n).toBe(3);
    expect(Date.now() - t0).toBeLessThan(450);
  });

  it('after a few tries the 429 is handed back (the caller decides)', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => { n++; return new Response('busy', { status: 429 }); });
    expect((await boundedFetch('https://rpc.test')).status).toBe(429);
    expect(n).toBe(4);
  });

  it('a request that never answers is cut off', async () => {
    config.rpcTimeoutMs = 40;
    vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout')))));
    await expect(boundedFetch('https://rpc.test')).rejects.toThrow(/aborted|timeout/i);
  });
});
