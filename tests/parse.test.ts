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

  it('ignores failed transactions and other wallets; reads the same trade on any venue', () => {
    expect(parseLeaderTrades(fx('failed'), '2UcS1C7PoEodaZ4hBu3QjSBvTmii73AAPSuMFER4tfEb')).toEqual([]);
    expect(parseLeaderTrades(fx('curve_buy'), '11111111111111111111111111111111')).toEqual([]);
    const tx = fx('curve_buy');
    const notPump: RawTransaction = { ...tx, transaction: { ...tx.transaction, message: { accountKeys: tx.transaction.message.accountKeys.map((k) => (k === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' ? 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' : k)) } } };
    // the same trade routed elsewhere is still a trade, on venue 'other'
    expect(parseLeaderTrades(notPump, '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB')[0]).toMatchObject({ side: 'buy', venue: 'other' });
  });
});

describe('any launchpad / any exchange (balance changes, SOL on the other side)', () => {
  it.each([
    ['launchlab_buy', '9f8ma9n3DXCfPGmCh71pMxanSp4Cjj2h9HScnNp7GxTJ', 'buy'],
    ['launchlab_sell', '5zncQ1CKFzEhqqVpdk6jpY43zCT6TgYgyCF85Df2q23F', 'sell'],
    ['meteora_dbc_buy', '29FjxAEv6x8Z5MzgHDQneetTsY9NTyX3w7FgZyYeigsg', 'buy'],
    ['meteora_dbc_sell', 'FH9YdWibhW865sfZxh4yMqjmfkG23ufN5gdhA8TR2m32', 'sell'],
    ['jupiter_buy', '8LECDx3cbysSEJnGdAgjKKoGcWDhL2Kx9aCcUXoFYYtQ', 'buy'],
    ['jupiter_sell', '5eg6iiCSHnaJVxZa9WBTgfcnXZNybW5y9eWX6q4z1ccz', 'sell'],
  ])('%s is read as a %s with its SOL amount', (name, leader, side) => {
    const trades = parseLeaderTrades(fx(name), leader);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.side).toBe(side);
    expect(trades[0]!.solLamports).toBeGreaterThan(50_000n);
    expect(trades[0]!.tokenAmount).toBeGreaterThan(0n);
  });

  it('a plain token transfer (no SOL on the other side) is not a trade', () => {
    const tx = fx('launchlab_buy');
    const leader = '9f8ma9n3DXCfPGmCh71pMxanSp4Cjj2h9HScnNp7GxTJ';
    const keys = tx.transaction.message.accountKeys as string[];
    const i = keys.indexOf(leader);
    const pre = [...tx.meta!.preBalances];
    const post = [...tx.meta!.postBalances];
    post[i] = pre[i]! - tx.meta!.fee; // only the network fee left the wallet
    const transfer: RawTransaction = { ...tx, meta: { ...tx.meta!, preBalances: pre, postBalances: post, preTokenBalances: (tx.meta!.preTokenBalances ?? []).filter((b) => b.owner === leader), postTokenBalances: (tx.meta!.postTokenBalances ?? []).filter((b) => b.owner === leader) } };
    expect(parseLeaderTrades(transfer, leader)).toEqual([]);
  });
});

describe('coins paired with anything', () => {
  const leader = '9f8ma9n3DXCfPGmCh71pMxanSp4Cjj2h9HScnNp7GxTJ';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const OTHER = 'Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA';
  /** The real LaunchLab buy, rewritten so the wallet paid with `mint` instead of SOL. */
  function paidWith(mint: string, amount: number): RawTransaction {
    const tx = fx('launchlab_buy');
    const keys = tx.transaction.message.accountKeys as string[];
    const i = keys.indexOf(leader);
    const post = [...tx.meta!.postBalances];
    post[i] = tx.meta!.preBalances[i]! - tx.meta!.fee;
    const idx = keys.length; // a token account of the wallet for the paying mint
    return {
      ...tx,
      transaction: { ...tx.transaction, message: { accountKeys: [...keys, 'PayAcct1111111111111111111111111111111111111'] } },
      meta: {
        ...tx.meta!, postBalances: [...post, 2039280], preBalances: [...tx.meta!.preBalances, 2039280],
        preTokenBalances: [...(tx.meta!.preTokenBalances ?? []), { accountIndex: idx, mint, owner: leader, uiTokenAmount: { amount: String(amount), decimals: 6 } }],
        postTokenBalances: [...(tx.meta!.postTokenBalances ?? []), { accountIndex: idx, mint, owner: leader, uiTokenAmount: { amount: '0', decimals: 6 } }],
      },
    };
  }
  it('a coin bought with USDC is a buy, with the USDC paid as its counter (valued in SOL later)', () => {
    const [t, ...rest] = parseLeaderTrades(paidWith(USDC, 250_000_000), leader);
    expect(rest).toHaveLength(0); // USDC itself is not "a coin sold"
    expect(t).toMatchObject({ side: 'buy', mint: 'FXVj1cT44nNDZiHQfQTBpsmp7TM1fgQxzLm71CGysnow', solLamports: 0n, counter: { mint: USDC, amount: 250_000_000n } });
  });
  it('a coin-for-coin swap: the bought coin is a buy, the paid coin a sell', () => {
    const trades = parseLeaderTrades(paidWith(OTHER, 5_000_000), leader);
    expect(trades.find((x) => x.side === 'buy')).toMatchObject({ mint: 'FXVj1cT44nNDZiHQfQTBpsmp7TM1fgQxzLm71CGysnow', counter: { mint: OTHER } });
    expect(trades.find((x) => x.side === 'sell')).toMatchObject({ mint: OTHER, tokenAmount: 5_000_000n });
  });
});
