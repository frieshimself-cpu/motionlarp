import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RawTransaction } from '../src/chain/rpc.js';
import { parseLeaderTrades, soldShare } from '../src/watch/parse.js';

const fx = (name: string) => JSON.parse(readFileSync(`tests/fixtures/tx/${name}.json`, 'utf8')) as RawTransaction;

describe('parseLeaderTrades on real mainnet transactions', () => {
  it('pump.fun curve buy (v1 transaction, leader paid the fee)', () => {
    const [t, ...rest] = parseLeaderTrades(fx('curve_buy'), '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB');
    expect(rest).toHaveLength(0);
    expect(t).toMatchObject({ side: 'buy', mint: 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump', venue: 'pumpfun', tokenAmount: 23810684081348n });
    // 350528613 lamports left the wallet, 9000 of them the network fee.
    expect(t!.solLamports).toBe(350528613n - 9000n);
  });

  it('pump.fun curve buy where another wallet paid the fee (a bot relayer)', () => {
    const [t] = parseLeaderTrades(fx('curve_buy_fee_payer_bot'), '2SaSfQt2BnS133wWk9Xcaztq8uBCbuZkZXSTvEMVTRaY');
    expect(t).toMatchObject({ side: 'buy', venue: 'pumpfun', tokenAmount: 239669439879n, solLamports: 8699823n });
  });

  it('pump.fun curve sell of the whole bag', () => {
    const [t] = parseLeaderTrades(fx('curve_wallet_sell'), 'GEXh5zqvGrydevffihQ37KKz2s2mQxfDP6tDkQcaCVCM');
    expect(t).toMatchObject({ side: 'sell', venue: 'pumpfun', tokensBefore: 155255828267n, tokensAfter: 0n, tokenAmount: 155255828267n });
    expect(t!.solLamports).toBeGreaterThan(0n);
    expect(soldShare(t!)).toBe(1);
  });

  it('PumpSwap partial sell: share of the bag sold', () => {
    const [t] = parseLeaderTrades(fx('amm_wallet_partial_sell'), '2VQaXQmtqqG6imqYaCQra4JbikZdDzQBQsXu2pXXBujT');
    expect(t).toMatchObject({ side: 'sell', venue: 'pumpswap', tokensBefore: 5262389988n, tokensAfter: 4370983740n });
    expect(soldShare(t!)).toBeCloseTo((5262389988 - 4370983740) / 5262389988, 5);
    expect(t!.solLamports).toBeGreaterThan(0n);
  });

  it('PumpSwap buy logged as "Sell": balances decide; new token-account rent is not counted as spent', () => {
    const [t] = parseLeaderTrades(fx('amm_sell'), '6MCCTXAKMobYUdinDzPn4yKYMmCC8qnAqNsKywzZ18Tb');
    expect(t).toMatchObject({ side: 'buy', venue: 'pumpswap', tokenAmount: 130671625n });
    // The pool received 114865 lamports; what the wallet spent is that plus trading fees, far below the 1.6M it moved.
    expect(t!.solLamports).toBeGreaterThanOrEqual(114865n);
    expect(t!.solLamports).toBeLessThan(200000n);
  });

  it('PumpSwap sell by a non-payer wallet, arbitrage transaction', () => {
    const [t] = parseLeaderTrades(fx('amm_buy'), '3pZC7wr5KmisA7FaUVg6coWE8k9CB9tcazxXYbYKAsJC');
    expect(t).toMatchObject({ side: 'sell', venue: 'pumpswap', tokenAmount: 6285151800637n, solLamports: 6110952123n });
    expect(soldShare(t!)).toBeGreaterThan(0);
    expect(soldShare(t!)).toBeLessThanOrEqual(1);
  });

  it('ignores failed transactions, other wallets, and non-pump transactions', () => {
    expect(parseLeaderTrades(fx('failed'), '2UcS1C7PoEodaZ4hBu3QjSBvTmii73AAPSuMFER4tfEb')).toEqual([]);
    expect(parseLeaderTrades(fx('curve_buy'), '11111111111111111111111111111111')).toEqual([]);
    const tx = fx('curve_buy');
    const notPump: RawTransaction = { ...tx, transaction: { ...tx.transaction, message: { accountKeys: tx.transaction.message.accountKeys.map((k) => (k === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' ? 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' : k)) } } };
    expect(parseLeaderTrades(notPump, '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB')).toEqual([]);
  });
});
