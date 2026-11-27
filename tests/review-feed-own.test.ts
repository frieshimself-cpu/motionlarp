// Timing fuzzer cases 12 and 13 (27 Nov 2026).
// 12: the rest of a Sell now that is owed on a coin that cannot be sold was tried again by the settling pass every
//     30 s, and every try wrote the same failure line into the feed (2,880 a day; the feed keeps 5,000 lines).
// 13: the last step of a "% of the original bag" ladder sold whatever the wallet held, the coins the user had bought
//     by hand with it.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/store.js';
import { validateSettings } from '../src/engine/settings.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const SOL = 1_000_000_000n;
const LEADER = 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih';
const MINT = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';

function live(sell: Record<string, unknown>, opts: { ownCoins?: bigint; sellsFail?: boolean } = {}) {
  const store = new Store(':memory:');
  const uid = store.createUser('u', 'x');
  const wallet = Keypair.generate();
  store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
  store.createCopy(uid, validateSettings({ leader: LEADER, buySol: 1, minLeaderBuySol: 0, sell }));
  let clock = 1_000_000;
  let held = opts.ownCoins ?? 0n;
  const sold: bigint[] = [];
  const executor = {
    buy: async (r: { onSigned?: (s: string) => void }) => { r.onSigned?.('BUY'); held += 1_000_000n; return { ok: true as const, signature: 'BUY', tokens: 1_000_000n, lamports: SOL, simulated: false }; },
    sell: async (r: { tokens: bigint }) => {
      if (opts.sellsFail) return { ok: false as const, error: 'custom program error: 0x1772' };
      const n = r.tokens < held ? r.tokens : held;
      held -= n;
      sold.push(n);
      return { ok: true as const, signature: `S${sold.length}`, tokens: n, lamports: n * 1_000n, simulated: false };
    },
    quoteSell: async (_m: string, t: bigint) => t * 1_000n, solBalance: async () => 10n * SOL, tokenBalance: async () => held, isLive: () => true,
  };
  const engine = new Engine({ store, executor, walletFor: () => wallet, now: () => clock, priceMs: 2_000, maxSolPerBuy: 10, feeReserveSol: 0.01, zeroRecheckMs: 1, fastRetryMs: [0], slowRetryMs: 1_000 });
  const trade = (): LeaderTrade => ({ signature: `s${Math.random()}`, leader: LEADER, mint: MINT, side: 'buy', solLamports: 2n * SOL, tokenAmount: 5n, tokensBefore: 0n, tokensAfter: 5n, venue: 'pumpfun', slot: 1, blockTime: null });
  return {
    store, uid, engine, sold, wallet: () => held,
    buy: async () => { await engine.onLeaderTrade(trade()); await engine.idle(); },
    advance: async (ms: number) => { clock += ms; await engine.tick(); await engine.idle(); },
    feed: () => store.events(uid, 200).map((e) => e.message),
  };
}

describe('the rest of a Sell now that is owed, on a coin that cannot be sold', () => {
  it('says it failed once, not on every try of the settling pass', async () => {
    const s = live({ mirror: { enabled: true, mode: 'exit' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } }, { sellsFail: true });
    await s.buy();
    const id = s.store.activePositions(s.uid)[0]!.id;
    s.store.updatePosition(id, { exitOwed: { reason: 'manual' } }); // as Sell now leaves it when its coins were out
    for (let i = 0; i < 6; i++) { await s.engine.restore(); await s.engine.idle(); } // three minutes of settling passes
    const lines = s.feed().filter((m) => /you pressed Sell now\) failed/.test(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/tried again every 30 s until it sells/);
  });

  it('each press of Sell now still gets its own answer', async () => {
    const s = live({ mirror: { enabled: true, mode: 'exit' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } }, { sellsFail: true });
    await s.buy();
    const id = s.store.activePositions(s.uid)[0]!.id;
    for (let i = 0; i < 3; i++) { await s.engine.sellNow(s.uid, id); await s.engine.idle(); }
    expect(s.feed().filter((m) => /you pressed Sell now\) failed/.test(m))).toHaveLength(3);
  });
});

describe('coins of the same coin the user bought by hand', () => {
  const scharo = { mirror: { enabled: false, mode: 'exit' }, timedOf: 'bag', timed: [{ afterSec: 2, percent: 40 }, { afterSec: 4, percent: 20 }, { afterSec: 6, percent: 100 }], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } };

  it('are left alone by the last step of a "% of the original bag" ladder (it sells what is left of the copy\'s bag)', async () => {
    const s = live(scharo, { ownCoins: 3_000_000n });
    await s.buy();
    for (let t = 0; t < 4; t++) await s.advance(2_000);
    expect(s.sold).toEqual([400_000n, 200_000n, 400_000n]);
    expect(s.wallet()).toBe(3_000_000n);
    expect(s.store.position(1)).toMatchObject({ status: 'closed', tokensHeld: 0n });
  });

  it('without any, the last step still sweeps up a remainder a little above the books (the count came in low)', async () => {
    const s = live(scharo);
    await s.buy();
    await s.advance(2_000); await s.advance(2_000); // 600,000 sold: 400,000 left in the wallet
    s.store.updatePosition(1, { tokensHeld: 395_000n }); // the books 1.3 % short of it (a count that came in low)
    await s.advance(2_000);
    expect(s.sold.at(-1)).toBe(400_000n); // all of it: the copy's own remainder
    expect(s.wallet()).toBe(0n);
  });
});
