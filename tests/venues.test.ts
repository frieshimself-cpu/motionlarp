// The native venues and the transaction plumbing, offline (lessons from reading Velo and from the venue review,
// 27 Nov 2026).
import { afterEach, describe, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../src/config.js';
import { boundedFetch, getShortBlockhash, refreshBlockhash, setBlockhashesForTests, setConnectionForTests } from '../src/chain/connection.js';
import { confirmSignature } from '../src/tx/confirm.js';
import { programError } from '../src/tx/errors.js';
import { friendlyError } from '../src/log.js';
import { PfDispatcher } from '../src/venues/pf.js';
import { PumpFunVenue } from '../src/venues/pumpfun.js';
import { pumpSdk } from '../src/venues/sdk.js';
import { VenueError } from '../src/venues/types.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const saved = { ...config };
afterEach(() => {
  Object.assign(config, saved);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setConnectionForTests(null);
});
const pool = () => ({ kind: 'pumpfun_curve' as const, pool: PublicKey.unique(), mint: PublicKey.unique(), tokenProgram: TOKEN_PROGRAM_ID });
function venue(curve: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const v = new PumpFunVenue();
  const state = { bondingCurve: { complete: false, isCashbackCoin: false, isMayhemMode: false, ...curve }, quoteMint: WSOL, associatedUserAccountInfo: null };
  (v as unknown as { globals: unknown }).globals = { global: {}, feeConfig: {}, at: Date.now() };
  (v as unknown as { online: unknown }).online = { fetchBuyState: async () => state, fetchSellState: async () => state, fetchBondingCurve: async () => ({ ...state.bondingCurve, quoteMint: WSOL }), ...extra };
  return v;
}

describe('pump.fun curve, coin by coin', () => {
  it('a curve that completed: the price check is refused as "migrated" too (it was 0, which fired every stop loss)', async () => {
    const err = await venue({ complete: true }).quoteSell(pool(), 10n).catch((e) => e);
    expect((err as VenueError).code).toBe('migrated');
  });

  it('a cashback coin is bought through Jupiter (exact spend), never with the older buy that can take twice the amount', async () => {
    const older = vi.spyOn(pumpSdk.PUMP_SDK, 'buyInstructions');
    const err = await venue({ isCashbackCoin: true }).buildBuy({ pool: pool(), user: PublicKey.unique(), lamportsIn: 10n, slippagePct: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).code).toBe('unsupported_pool');
    expect(older).not.toHaveBeenCalled();
  });

  it('a failed read of the fee table is not kept for five minutes: the next call reads it again', async () => {
    let feeReads = 0;
    const v = new PumpFunVenue();
    (v as unknown as { online: unknown }).online = {
      fetchGlobal: async () => ({ ok: 1 }),
      fetchFeeConfig: async () => { feeReads++; if (feeReads === 1) throw new Error('429'); return { tiers: 1 }; },
    };
    const fetchGlobals = (v as unknown as { fetchGlobals: () => Promise<{ feeConfig: unknown }> }).fetchGlobals.bind(v);
    expect((await fetchGlobals()).feeConfig).toBeNull();
    expect((await fetchGlobals()).feeConfig).toEqual({ tiers: 1 });
    expect(feeReads).toBe(2);
    await fetchGlobals();
    expect(feeReads).toBe(2); // a good read is kept
  });
});

describe('a completed curve: in between, or long gone elsewhere', () => {
  const account = (owner: PublicKey) => ({ owner, data: Buffer.alloc(0), lamports: 1_000_000, executable: false });
  function chain(curve: { complete: boolean; realQuoteReserves: BN; realTokenReserves: BN }) {
    vi.spyOn(pumpSdk.PUMP_SDK, 'decodeBondingCurve').mockReturnValue(curve as never);
    setConnectionForTests({ getMultipleAccountsInfo: async () => [account(TOKEN_PROGRAM_ID), account(pumpSdk.PUMP_PROGRAM_ID), null] } as unknown as Connection);
  }
  it('graduated long ago to another exchange (nothing left on the curve, no PumpSwap pool): Jupiter, as "not native"', async () => {
    chain({ complete: true, realQuoteReserves: new BN(0), realTokenReserves: new BN(0) });
    const err = await new PfDispatcher().resolve('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump').catch((e) => e);
    expect((err as VenueError).code).toBe('unresolved');
  });
  it('just completed (its SOL still on the curve): the pool is seconds away, "migrating"', async () => {
    chain({ complete: true, realQuoteReserves: new BN(85_000_000_000), realTokenReserves: new BN(0) });
    const err = await new PfDispatcher().resolve('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump').catch((e) => e);
    expect((err as VenueError).code).toBe('migrating');
  });
});

describe('a transaction that failed on chain says why in words', () => {
  it('reads the program\'s own error from the logs', () => {
    const logs = [
      'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
      'Program log: Instruction: Sell',
      'Program log: AnchorError thrown in programs/pump/src/lib.rs:812. Error Code: TooLittleSolReceived. Error Number: 6003. Error Message: Slippage tolerance exceeded.',
      'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P failed: custom program error: 0x1773',
    ];
    expect(programError(logs)).toBe('TooLittleSolReceived: Slippage tolerance exceeded.');
    expect(programError(['Transfer: insufficient lamports 5156739, need 6000000', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1'])).toBe('insufficient lamports 5156739, need 6000000');
    expect(programError(['Program log: nothing to see'])).toBeNull();
  });
  it('the common ones read in plain words', () => {
    expect(friendlyError('transaction errored: x (BondingCurveComplete: The bonding curve has completed)')).toMatch(/moved to PumpSwap/);
    expect(friendlyError('transaction errored: x (NotEnoughTokensToBuy: Not enough tokens to buy)')).toMatch(/not enough coins left/);
    expect(friendlyError('transaction errored: x (insufficient lamports 5156739, need 6000000)')).toMatch(/not enough SOL/);
  });
});

describe('re-sending does not depend on the status checks working', () => {
  it('the same transaction is pushed again about once a second even while every status check fails', async () => {
    let polls = 0;
    setConnectionForTests({
      getSignatureStatuses: async () => { polls++; if (polls < 6) throw new Error('fetch failed'); return { value: [{ confirmationStatus: 'confirmed', slot: 1 }] }; },
      getBlockHeight: async () => 0,
    } as unknown as Connection);
    let resent = 0;
    const r = await confirmSignature('sig', 1_000, { resend: () => { resent++; }, pollMs: 10, resendEveryMs: 15 });
    expect(r).toEqual({ landed: true, slot: 1 });
    expect(resent).toBeGreaterThanOrEqual(2);
  });
});

describe('the blockhash a buy is signed with', () => {
  const NOW = 2_000_000;
  const conn = (bh: { blockhash: string; lastValidBlockHeight: number }) => setConnectionForTests({ getLatestBlockhash: async () => bh } as unknown as Connection);
  it('when the newest one was first seen more than 4 s ago (a stuck feed), the newest is used, not an older one', async () => {
    conn({ blockhash: 'x', lastValidBlockHeight: 0 });
    setBlockhashesForTests([
      { blockhash: 'old', lastValidBlockHeight: 1100, at: NOW - 30_000, firstSeen: NOW - 30_000 },
      { blockhash: 'newest', lastValidBlockHeight: 1150, at: NOW - 1000, firstSeen: NOW - 10_000 },
    ]);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    expect((await getShortBlockhash(NOW)).blockhash).toBe('newest');
  });
  it('a fetched blockhash older than one already held (a lagging node) is not taken as the newest', async () => {
    conn({ blockhash: 'lagging', lastValidBlockHeight: 1140 });
    setBlockhashesForTests([{ blockhash: 'held', lastValidBlockHeight: 1150, at: NOW - 3000, firstSeen: NOW - 3000 }]);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await refreshBlockhash();
    expect((await getShortBlockhash(NOW)).blockhash).toBe('held');
  });
});

describe('a second RPC link takes over when the main one fails', () => {
  it('the same request goes to the backup link when the main one times out or fails; the key is not sent along', async () => {
    config.rpcUrl = 'https://main.example/?api-key=SECRET';
    config.rpcBackupUrl = 'https://backup.example/';
    config.rpcTimeoutMs = 50;
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string; signal: AbortSignal }) => {
      seen.push(`${url} ${init.body}`);
      if (String(url).startsWith('https://main')) return new Response('down', { status: 503 });
      return new Response('{"jsonrpc":"2.0","id":1,"result":42}', { status: 200 });
    });
    const res = await boundedFetch('https://main.example/?api-key=SECRET', { method: 'POST', body: '{"method":"getSlot"}' });
    expect(await res.json()).toMatchObject({ result: 42 });
    expect(seen).toEqual(['https://main.example/?api-key=SECRET {"method":"getSlot"}', 'https://backup.example/ {"method":"getSlot"}']);
  });
  it('no backup set: the main link\'s answer is returned as it is', async () => {
    config.rpcBackupUrl = 'off';
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    expect((await boundedFetch('https://main.example/', { method: 'POST', body: '{}' })).status).toBe(503);
  });
});

describe('a coin Jupiter will not trade', () => {
  it('reads in plain words (no liquidity, flagged, or not listed yet)', () => {
    expect(friendlyError('jupiter: The token X is not tradable')).toMatch(/Jupiter will not trade this coin/);
    expect(friendlyError('jupiter: No routes found')).toMatch(/no market for this coin yet/);
  });
});
