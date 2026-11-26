import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RawTransaction } from '../src/chain/rpc.js';
import { fastBuysFromLogs } from '../src/watch/events.js';
import { parseLeaderTrades } from '../src/watch/parse.js';

const fx = (name: string) => JSON.parse(readFileSync(`tests/fixtures/tx/${name}.json`, 'utf8')) as RawTransaction;

describe('fast path: buys straight from websocket logs', () => {
  it('reads a pump.fun curve buy (real mainnet logs) and agrees with the full parser', () => {
    const tx = fx('curve_buy');
    const leader = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
    const [fast] = fastBuysFromLogs(tx.meta!.logMessages!, 'sig', leader, 5)!;
    const [full] = parseLeaderTrades(tx, leader);
    expect(fast).toMatchObject({ side: 'buy', mint: full!.mint, tokenAmount: full!.tokenAmount, slot: 5 });
    // SOL from the event (amount + fees) is within 1 % of the balance-based figure
    expect(Number(fast!.solLamports)).toBeGreaterThan(Number(full!.solLamports) * 0.99);
    expect(Number(fast!.solLamports)).toBeLessThan(Number(full!.solLamports) * 1.01);
  });
  it('another wallet in the logs is not the leader', () => {
    expect(fastBuysFromLogs(fx('curve_buy').meta!.logMessages!, 'sig', '11111111111111111111111111111111', 1)).toBeNull();
  });
  it('sells and PumpSwap go the slow way (null)', () => {
    expect(fastBuysFromLogs(fx('curve_wallet_sell').meta!.logMessages!, 's', 'GEXh5zqvGrydevffihQ37KKz2s2mQxfDP6tDkQcaCVCM', 1)).toBeNull();
    expect(fastBuysFromLogs(fx('amm_sell').meta!.logMessages!, 's', '6MCCTXAKMobYUdinDzPn4yKYMmCC8qnAqNsKywzZ18Tb', 1)).toBeNull();
  });
});
