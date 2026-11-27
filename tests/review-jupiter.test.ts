// From the second review of the Jupiter route (27 Nov 2026): a copy buy that waited 15 s for a route and then bought at
// any price, a sell blocked by our own transfers, a smaller route taken without looking at its price, price checks
// that saw a 4-second-old price, a coin with no route asked again on every price check, a request that could hang 10 s.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ChainExecutor, jupiterAttempts, smallerRouteOk } from '../src/engine/executor.js';
import { Jupiter, ROUTE_LARGE, ROUTE_SMALL } from '../src/venues/jupiter.js';
import { VenueError } from '../src/venues/types.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = Keypair.generate().publicKey.toBase58();
const noRoute = () => new Response(JSON.stringify({ error: 'No routes found', errorCode: 'NO_ROUTES_FOUND' }), { status: 400 });
const route = () => new Response(JSON.stringify({ inAmount: '1', outAmount: '9', otherAmountThreshold: '8', routePlan: [{}] }), { status: 200 });
afterEach(() => vi.restoreAllMocks());

describe('a copy buy of a coin Jupiter has not picked up yet', () => {
  it('waits only a moment (about 2.5 s by default), then is skipped: never bought 15 s late at any price', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', async () => { n++; return noRoute(); }, 1, 1, { buyWaitMs: 300 });
    const t0 = Date.now();
    const err = await j.route(SOL, MINT, 10n, 100, true).catch((e) => e);
    expect(String(err)).toMatch(/not bought late/);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(n).toBeGreaterThan(2); // it did ask again within that moment
  });

  it('a coin picked up within that moment is bought', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', async () => (++n < 4 ? noRoute() : route()), 1, 1, { buyWaitMs: 2_000 });
    expect((await j.route(SOL, MINT, 10n, 100, true)).quote.outAmount).toBe('9');
  });
});

describe('a Jupiter request that hangs or drops', () => {
  it('is cut off after a few seconds (not 10) and tried once more at once', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', (_url, init) => {
      n++;
      if (n === 1) return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout'))));
      return Promise.resolve(route());
    }, 1, 1, { timeoutMs: 100 });
    const t0 = Date.now();
    expect((await j.quote(SOL, MINT, 10n, 100)).outAmount).toBe('9');
    expect(n).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a dropped connection is tried once more too; twice in a row is an error', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', async () => { n++; throw new TypeError('fetch failed'); }, 1, 1, { timeoutMs: 100 });
    await expect(j.quote(SOL, MINT, 10n, 100)).rejects.toThrow(/fetch failed/);
    expect(n).toBe(2);
  });
});

describe('when Jupiter\'s transaction does not fit with our fee and tip', () => {
  it('the best route goes without the tip before a smaller route is tried, and a sell finally goes without our transfers at all', () => {
    expect(jupiterAttempts(ROUTE_SMALL, 'buy')).toEqual([
      { size: null, tip: true, fee: true }, { size: null, tip: false, fee: true },
      { size: 32, tip: true, fee: true }, { size: 20, tip: true, fee: true },
    ]);
    expect(jupiterAttempts(ROUTE_LARGE, 'sell')).toEqual([
      { size: null, tip: true, fee: true }, { size: null, tip: false, fee: true },
      { size: null, tip: false, fee: false }, // an exit is never blocked by the site's own transfers
    ]);
    expect(jupiterAttempts(ROUTE_LARGE, 'buy').some((a) => !a.fee)).toBe(false); // a buy that does not fit is skipped
  });

  it('a smaller route is taken only when it pays nearly as much as the best one (within 1 %)', () => {
    expect(smallerRouteOk(1_000_000n, 995_000n)).toBe(true);
    expect(smallerRouteOk(1_000_000n, 990_000n)).toBe(true);
    expect(smallerRouteOk(1_000_000n, 989_999n)).toBe(false);
  });
});

describe('price checks of a Jupiter coin', () => {
  function executor(answer: () => Promise<{ quote: { outAmount: string }; maxAccounts: number }>) {
    const ex = new ChainExecutor();
    (ex.pf as unknown as { resolve: () => Promise<never> }).resolve = async () => { throw new VenueError('not a pump.fun or PumpSwap coin', 'unresolved'); };
    const spy = vi.spyOn(ex.jup, 'route').mockImplementation(answer as never);
    return { ex, spy };
  }

  it('each price check (every 2 s) gets a fresh price: no 4-second-old answer from a cache', async () => {
    let price = 1000;
    const { ex, spy } = executor(async () => ({ quote: { outAmount: String(price) }, maxAccounts: 48 }));
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    expect(await ex.quoteSell(MINT, 10n)).toBe(1000n);
    price = 900;
    now.mockReturnValue(1_002_000);
    expect(await ex.quoteSell(MINT, 10n)).toBe(900n);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a coin with no route is not asked again on every check (Jupiter\'s request budget is shared by the whole site)', async () => {
    const { ex, spy } = executor(async () => { throw new Error('jupiter: No routes found'); });
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(2_000_000);
    await expect(ex.quoteSell(MINT, 10n)).rejects.toThrow(/No routes/);
    now.mockReturnValue(2_010_000);
    await expect(ex.quoteSell(MINT, 10n)).rejects.toThrow(/No routes/);
    expect(spy).toHaveBeenCalledTimes(1);
    now.mockReturnValue(2_031_000); // half a minute later it is asked again
    await expect(ex.quoteSell(MINT, 10n)).rejects.toThrow(/No routes/);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
