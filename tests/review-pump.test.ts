// From the second review of the pump.fun venues (27 Nov 2026): mayhem curves that hold less SOL than a sell asks
// for, coins in between their curve and their PumpSwap pool, the platform fee on a partly filled buy, and the
// wrapped-SOL account of a PumpSwap trade.
import { afterEach, describe, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../src/config.js';
import { ChainExecutor } from '../src/engine/executor.js';
import { friendlyError } from '../src/log.js';
import { PumpFunVenue } from '../src/venues/pumpfun.js';
import { tradeState } from '../src/venues/pumpswap.js';
import { pumpSdk } from '../src/venues/sdk.js';
import { VenueError, type BuildResult, type ResolvedPool } from '../src/venues/types.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const saved = { ...config };
afterEach(() => {
  Object.assign(config, saved);
  vi.restoreAllMocks();
});

// Flat fees (no fee table): 0.95 % protocol + 0.30 % creator.
const GLOBAL = { feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30), creatorFeeConfigurable: false };
const VT = 600_000_000_000_000n; // virtual coin reserves (600M coins, 6 decimals)
const VQ = 50_000_000_000n; // virtual SOL reserves (50 SOL)
const gross = (tokens: bigint) => (tokens * VQ) / (VT + tokens); // what the curve pays out before fees
const curvePool = (): ResolvedPool => ({ kind: 'pumpfun_curve', pool: PublicKey.unique(), mint: PublicKey.unique(), tokenProgram: TOKEN_PROGRAM_ID });

function curveVenue(over: Record<string, unknown>) {
  const bondingCurve = {
    virtualTokenReserves: new BN(VT.toString()), virtualQuoteReserves: new BN(VQ.toString()),
    realTokenReserves: new BN('500000000000000'), realQuoteReserves: new BN('30000000000'),
    tokenTotalSupply: new BN('2000000000000000'), complete: false, creator: PublicKey.unique(), isMayhemMode: true,
    isCashbackCoin: false, quoteMint: WSOL, creatorFeeBps: new BN(0), ...over,
  };
  const state = { bondingCurve, quoteMint: WSOL, associatedUserAccountInfo: { data: Buffer.alloc(165) }, bondingCurveAccountInfo: {} };
  const v = new PumpFunVenue();
  (v as unknown as { online: unknown }).online = {
    fetchGlobal: async () => GLOBAL,
    fetchFeeConfig: async () => { throw new Error('no fee table in this test'); },
    fetchBuyState: async () => state, fetchSellState: async () => state, fetchBondingCurve: async () => bondingCurve,
  };
  return v;
}

describe('a mayhem curve that holds less SOL than the sell asks for', () => {
  it('sells what the curve can pay for (it used to ask for all of it and be refused with "Overflow" for ever)', async () => {
    const sellIx = vi.spyOn(pumpSdk.PUMP_SDK, 'sellInstructions').mockResolvedValue([]);
    const R = 1_000_000_000n; // the curve holds 1 SOL; selling 20M coins would need 1.61 SOL
    const want = 20_000_000_000_000n;
    expect(gross(want)).toBeGreaterThan(R);
    const built = await curveVenue({ realQuoteReserves: new BN(R.toString()) }).buildSell({ pool: curvePool(), user: PublicKey.unique(), tokensIn: want, slippagePct: 25 });
    expect(built.tokensIn).toBeDefined();
    expect(built.tokensIn!).toBeLessThan(want);
    expect(gross(built.tokensIn!)).toBeLessThanOrEqual(R); // the program accepts it
    expect(gross(built.tokensIn!)).toBeGreaterThan((R * 98n) / 100n); // and it takes nearly all the curve has
    expect(BigInt(sellIx.mock.calls[0]![0].amount.toString())).toBe(built.tokensIn);
    expect(built.expectedOut).toBeLessThanOrEqual(R);
  });

  it('a curve that holds no SOL at all: a clear refusal, nothing built', async () => {
    const sellIx = vi.spyOn(pumpSdk.PUMP_SDK, 'sellInstructions').mockResolvedValue([]);
    const err = await curveVenue({ realQuoteReserves: new BN(0) }).buildSell({ pool: curvePool(), user: PublicKey.unique(), tokensIn: 1_000_000n, slippagePct: 25 }).catch((e) => e);
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).code).toBe('curve_empty');
    expect(friendlyError(String((err as Error).message))).toMatch(/holds no SOL|too little SOL/);
    expect(sellIx).not.toHaveBeenCalled();
  });

  it('the value shown and the stop loss never count on more SOL than the curve holds', async () => {
    const R = 1_000_000_000n;
    const value = await curveVenue({ realQuoteReserves: new BN(R.toString()) }).quoteSell(curvePool(), 20_000_000_000_000n);
    expect(value).toBeLessThanOrEqual(R);
    expect(value).toBeGreaterThan(0n);
  });

  it('an ordinary sell on a curve with enough SOL is untouched', async () => {
    const sellIx = vi.spyOn(pumpSdk.PUMP_SDK, 'sellInstructions').mockResolvedValue([]);
    const built = await curveVenue({}).buildSell({ pool: curvePool(), user: PublicKey.unique(), tokensIn: 20_000_000_000_000n, slippagePct: 25 });
    expect(built.tokensIn).toBeUndefined();
    expect(sellIx.mock.calls[0]![0].amount.toString()).toBe('20000000000000');
  });

  it('pump.fun\'s "Overflow" refusal reads in plain words', () => {
    expect(friendlyError('sent but did not land: transaction errored (Overflow: Overflow)')).toMatch(/too little SOL/);
  });
});

describe('a mayhem curve near its end: the buy takes what is left and pays for only that', () => {
  it('the budget (and with it the platform fee and the cost booked) is lowered to the price of what is left', async () => {
    const buyIx = vi.spyOn(pumpSdk.PUMP_SDK, 'buyExactQuoteInV3Instructions').mockResolvedValue([]);
    const left = 5_000_000_000_000n; // 5M coins left on the curve: about 0.43 SOL of them
    const built = await curveVenue({ realTokenReserves: new BN(left.toString()) }).buildBuy({ pool: curvePool(), user: PublicKey.unique(), lamportsIn: 7_000_000_000n, slippagePct: 100 });
    expect(built.lamportsIn).toBeDefined();
    const price = (left * VQ) / (VT - left);
    expect(built.lamportsIn!).toBeGreaterThan(price); // enough for all that is left, fees included
    expect(built.lamportsIn!).toBeLessThan((price * 104n) / 100n);
    expect(built.expectedOut).toBe(left);
    const args = buyIx.mock.calls[0]![0];
    expect(args.quoteAmount.toString()).toBe(built.lamportsIn!.toString());
    expect(args.partialFill).toBe(true);
  });

  it('an ordinary curve is not touched (the exact-spend buy spends the whole budget there)', async () => {
    vi.spyOn(pumpSdk.PUMP_SDK, 'buyExactQuoteInV3Instructions').mockResolvedValue([]);
    const built = await curveVenue({ isMayhemMode: false, realTokenReserves: new BN('5000000000000') }).buildBuy({ pool: curvePool(), user: PublicKey.unique(), lamportsIn: 7_000_000_000n, slippagePct: 100 });
    expect(built.lamportsIn).toBeUndefined();
  });

  it('the coin account is always created if missing (one of our own sells may have just closed it)', async () => {
    const buyIx = vi.spyOn(pumpSdk.PUMP_SDK, 'buyExactQuoteInV3Instructions').mockResolvedValue([]);
    await curveVenue({}).buildBuy({ pool: curvePool(), user: PublicKey.unique(), lamportsIn: 100_000_000n, slippagePct: 25 });
    expect(buyIx.mock.calls[0]![0].associatedUserAccountInfo).toBeNull();
  });
});

describe('the executor books what was really sold', () => {
  function executor(built: BuildResult, held: bigint) {
    const ex = new ChainExecutor();
    const seen: { ixs: unknown[] | null; read: unknown[] | null } = { ixs: null, read: null };
    const venue = { buildSell: async () => built, buildBuy: async () => built };
    ex.isLive = () => true;
    (ex.pf as unknown as { venueFor: () => unknown }).venueFor = () => venue;
    const anyEx = ex as unknown as Record<string, unknown>;
    anyEx.ataBalance = async () => held;
    anyEx.tokenBalance = async () => 0n;
    anyEx.nativeTx = async (_req: unknown, ixs: unknown[]) => { seen.ixs = ixs; return { tx: {}, lastValidBlockHeight: 1 }; };
    anyEx.sendAndRead = async (...args: unknown[]) => { seen.read = args; return { ok: true, signature: 's', tokens: args[4], lamports: args[5], simulated: false }; };
    return { ex, seen };
  }
  const req = (over: Record<string, unknown> = {}) => ({ wallet: Keypair.generate(), mint: PublicKey.unique().toBase58(), slippagePct: 25, priorityFeeSol: 0.001, tipSol: 0, live: true, feeBps: 100, ...over });

  it('a sell the curve could pay only part of: that part is sent and booked, and the coin account is not closed', async () => {
    config.feeWallet = Keypair.generate().publicKey.toBase58();
    const { ex, seen } = executor({ instructions: [], expectedOut: 900_000_000n, minOut: 0n, tokensIn: 600n }, 1_000n);
    const nativeSell = (ex as unknown as { nativeSell: (r: unknown, p: ResolvedPool) => Promise<unknown> }).nativeSell.bind(ex);
    await nativeSell({ ...req(), tokens: 1_000n, closeIfEmpty: true }, curvePool());
    expect(seen.read![4]).toBe(600n); // the tokens booked
    expect((seen.ixs as { programId: PublicKey }[]).some((ix) => ix.programId.equals(TOKEN_PROGRAM_ID))).toBe(false); // no close
  });

  it('a part so small its SOL would not even pay the transaction is not sent (it waits for SOL to come back)', async () => {
    const { ex, seen } = executor({ instructions: [], expectedOut: 3_000n, minOut: 0n, tokensIn: 5n }, 1_000n);
    const nativeSell = (ex as unknown as { nativeSell: (r: unknown, p: ResolvedPool) => Promise<{ ok: boolean; error?: string }> }).nativeSell.bind(ex);
    const r = await nativeSell({ ...req(), tokens: 1_000n }, curvePool());
    expect(r.ok).toBe(false);
    expect(friendlyError(r.error!)).toMatch(/too little SOL/);
    expect(seen.read).toBeNull();
  });

  it('a partly filled buy pays the platform fee on what it can really spend, and books that cost', async () => {
    config.feeWallet = Keypair.generate().publicKey.toBase58();
    const { ex, seen } = executor({ instructions: [], expectedOut: 5_000n, minOut: 0n, lamportsIn: 430_000_000n }, 0n);
    const nativeBuy = (ex as unknown as { nativeBuy: (r: unknown, p: ResolvedPool) => Promise<unknown> }).nativeBuy.bind(ex);
    await nativeBuy({ ...req(), lamports: 7_000_000_000n }, curvePool());
    expect(seen.read![7]).toBe(4_300_000n); // 1 % of 0.43 SOL, not of 7 SOL
    expect(seen.read![5]).toBe(430_000_000n + 4_300_000n + 5_000n + 1_000_000n); // spend + fee + base fee + priority fee
  });
});

describe('a coin in between its curve and its PumpSwap pool', () => {
  function executor() {
    const ex = new ChainExecutor();
    ex.isLive = () => true;
    let resolves = 0;
    (ex.pf as unknown as { resolve: () => Promise<never> }).resolve = async () => { resolves++; throw new VenueError('curve is complete but its PumpSwap pool was not found yet', 'migrating'); };
    const jup = vi.spyOn(ex.jup, 'route').mockRejectedValue(new Error('Jupiter must not be asked'));
    return { ex, jup, resolves: () => resolves };
  }
  const req = () => ({ wallet: Keypair.generate(), mint: PublicKey.unique().toBase58(), slippagePct: 25, priorityFeeSol: 0.001, tipSol: 0, live: true, feeBps: 0 });

  it('a sell fails at once (its own retries sell on PumpSwap the moment the pool is there), not handed to Jupiter for 20 s', async () => {
    const { ex, jup, resolves } = executor();
    const r1 = await ex.sell({ ...req(), tokens: 10n });
    expect(r1).toMatchObject({ ok: false });
    expect(friendlyError((r1 as { error: string }).error)).toMatch(/moving to PumpSwap/);
    await ex.sell({ ...req(), tokens: 10n });
    expect(resolves()).toBe(2); // looked at again on the very next try: no pin
    expect(jup).not.toHaveBeenCalled();
  });

  it('a copy buy in that moment is skipped (no 15 s wait for a Jupiter route and a buy at any price)', async () => {
    const { ex, jup } = executor();
    expect(await ex.buy({ ...req(), lamports: 7_000_000_000n })).toMatchObject({ ok: false });
    expect(jup).not.toHaveBeenCalled();
  });
});

describe('a PumpSwap trade and the wallet\'s wrapped-SOL account', () => {
  it('the wrapped-SOL account (and a buy\'s coin account) is always created if missing inside the trade, so a second trade signed meanwhile does not fail', () => {
    // The builders hand the SDK a state whose account infos say "missing": the SDK then adds an idempotent create
    // (a no-op when the account exists). The trade itself still closes the wrapped-SOL account afterwards.
    const buyState = tradeState({ userQuoteAccountInfo: { a: 1 }, userBaseAccountInfo: { b: 1 } } as never, 'buy') as unknown as Record<string, unknown>;
    expect(buyState.userQuoteAccountInfo).toBeNull();
    expect(buyState.userBaseAccountInfo).toBeNull();
    const sellState = tradeState({ userQuoteAccountInfo: { a: 1 }, userBaseAccountInfo: { b: 1 } } as never, 'sell') as unknown as Record<string, unknown>;
    expect(sellState.userQuoteAccountInfo).toBeNull();
    expect(sellState.userBaseAccountInfo).toEqual({ b: 1 }); // a sell's coin account exists: we hold the coin
  });
});
