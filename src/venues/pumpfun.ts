// ported from velo/src/venues/pumpfun.ts
// pump.fun bonding curve, via the official @pump-fun/pump-sdk (v4). Nothing here lists program accounts by hand.
// Scope: SOL-quoted curves only. Token-quoted curves (quote mints) are refused in step 1.
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getFastConnection } from '../chain/connection.js';
import { pumpSdk, type FeeConfig, type Global } from './sdk.js';
import { VenueError, type BuildResult, type CurveHint, type ResolvedPool, type Venue } from './types.js';

const GLOBAL_TTL_MS = 5 * 60_000;
const { OnlinePumpSdk, PUMP_SDK, getBuySolAmountFromTokenAmount, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, isSolLikeQuoteMint, normalizeQuoteMint } = pumpSdk;
type OnlinePumpSdk = InstanceType<typeof OnlinePumpSdk>;
type Curve = { virtualTokenReserves: BN; virtualQuoteReserves: BN; realQuoteReserves: BN };

function bn(v: bigint): BN {
  return new BN(v.toString());
}
function big(v: BN): bigint {
  return BigInt(v.toString());
}

/**
 * How many of `tokensIn` the curve can pay for right now. A mayhem curve can hold less SOL than its price says
 * (pump.fun's own agent sells its free half of the 2-billion supply into it, without fees), and the program refuses
 * a sell whose payout is more than the SOL the curve holds (6024 "Overflow"): the whole sell fails, every retry too.
 * So: all of them when it can pay; otherwise the amount whose payout is the curve's SOL, less 1 % (others trade in
 * the meantime); 0 when it holds nothing.
 */
export function sellableTokens(curve: Curve, tokensIn: bigint): bigint {
  const vT = big(curve.virtualTokenReserves);
  const vQ = big(curve.virtualQuoteReserves);
  const held = big(curve.realQuoteReserves);
  if (vT === 0n || tokensIn <= 0n) return tokensIn;
  if ((tokensIn * vQ) / (vT + tokensIn) <= held) return tokensIn;
  if (held <= 0n || vQ <= held) return 0n;
  return ((held * vT) / (vQ - held) * 99n) / 100n;
}

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
/** The curve's total supply: 1 billion coins (6 decimals), mayhem coins included (read on mainnet, 27 Nov 2026). */
const SUPPLY = 1_000_000_000_000_000n;

/**
 * The buy state from pump.fun's own event of the copied wallet's trade: the curve's reserves right after it, its
 * creator, mayhem and cashback flags. pump.fun's exact-spend buy needs only these (the accounts come from the mint,
 * the wallet and the token program; the creator for the fee split is read by the program itself); the reserves price
 * the minimum, which at 100 % slippage is one coin anyway.
 */
function stateFromHint(c: CurveHint) {
  const bondingCurve = {
    virtualTokenReserves: bn(c.virtualTokenReserves), virtualQuoteReserves: bn(c.virtualQuoteReserves),
    realTokenReserves: bn(c.realTokenReserves), realQuoteReserves: bn(c.realQuoteReserves),
    tokenTotalSupply: bn(SUPPLY), complete: c.realTokenReserves === 0n,
    creator: new PublicKey(c.creator), isMayhemMode: c.mayhem, isCashbackCoin: c.cashback, quoteMint: WSOL,
    creatorFeeBps: new BN(0),
  };
  return { bondingCurve, quoteMint: WSOL, associatedUserAccountInfo: null, bondingCurveAccountInfo: null } as unknown as Awaited<ReturnType<OnlinePumpSdk['fetchBuyState']>>;
}

export class PumpFunVenue implements Venue {
  readonly kind = 'pumpfun_curve' as const;
  private online: OnlinePumpSdk | null = null;
  private globals: { global: Global; feeConfig: FeeConfig | null; at: number } | null = null;
  private lastFeeConfig: FeeConfig | null = null;

  private sdk(): OnlinePumpSdk {
    if (!this.online) this.online = new OnlinePumpSdk(getFastConnection());
    return this.online;
  }

  private refreshing: Promise<unknown> | null = null;

  /**
   * `Global` and `FeeConfig` change rarely; cached for five minutes. Once read, a trade never waits for them again:
   * an older copy is used at once while a fresh one is read in the background.
   */
  private async fetchGlobals(): Promise<{ global: Global; feeConfig: FeeConfig | null }> {
    // Kept only when the fee table was read: without it the SDK prices with a flat fee that is 0.24 % off.
    if (this.globals && this.globals.feeConfig !== null && Date.now() - this.globals.at < GLOBAL_TTL_MS) return this.globals;
    if (this.globals && this.globals.feeConfig !== null) {
      if (!this.refreshing) this.refreshing = this.readGlobals().catch(() => undefined).finally(() => { this.refreshing = null; });
      return this.globals;
    }
    return this.readGlobals();
  }

  /** Reads the tables ahead of the first trade (the server calls it at start). */
  async warmGlobals(): Promise<void> {
    await this.fetchGlobals().catch(() => undefined);
  }

  private async readGlobals(): Promise<{ global: Global; feeConfig: FeeConfig | null }> {
    const sdk = this.sdk();
    const [global, fee] = await Promise.all([
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig().catch(() => null),
    ]);
    if (fee) this.lastFeeConfig = fee;
    this.globals = { global, feeConfig: fee ?? this.lastFeeConfig, at: Date.now() };
    return this.globals;
  }

  private assertSolCurve(quoteMint: PublicKey): void {
    if (!isSolLikeQuoteMint(normalizeQuoteMint(quoteMint))) {
      throw new VenueError('token-quoted bonding curves are not supported yet', 'unsupported_quote');
    }
  }

  async quoteBuy(pool: ResolvedPool, lamportsIn: bigint): Promise<bigint> {
    // The fee tables and the curve are read together (one round trip less before the trade).
    const [{ global, feeConfig }, curve] = await Promise.all([this.fetchGlobals(), this.sdk().fetchBondingCurve(pool.mint)]);
    this.assertSolCurve(curve.quoteMint);
    if (curve.complete) throw new VenueError('bonding curve is complete (migrated)', 'migrated');
    const out = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: bn(lamportsIn),
      quoteMint: normalizeQuoteMint(curve.quoteMint),
    });
    return big(out);
  }

  async quoteSell(pool: ResolvedPool, tokensIn: bigint): Promise<bigint> {
    const [{ global, feeConfig }, curve] = await Promise.all([this.fetchGlobals(), this.sdk().fetchBondingCurve(pool.mint)]);
    this.assertSolCurve(curve.quoteMint);
    // A completed curve quotes 0 (its reserves are gone): that would fire every stop loss. It trades on PumpSwap now.
    if (curve.complete) throw new VenueError('bonding curve is complete (migrated)', 'migrated');
    // What selling would really bring now: never more than the SOL the curve holds (a mayhem curve can hold less
    // than its price says), so the value shown and the stop loss do not count on SOL that is not there.
    const amount = sellableTokens(curve, tokensIn);
    if (amount <= 0n) return 0n;
    const out = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: bn(amount),
    });
    return big(out);
  }

  async buildBuy({ pool, user, lamportsIn, slippagePct, curve }: { pool: ResolvedPool; user: PublicKey; lamportsIn: bigint; slippagePct: number; curve?: CurveHint }): Promise<BuildResult> {
    // With the copied wallet's own trade event in hand, the curve as their buy left it is known: no read at all.
    const [{ global, feeConfig }, state] = await Promise.all([this.fetchGlobals(), curve ? Promise.resolve(stateFromHint(curve)) : this.sdk().fetchBuyState(pool.mint, user, pool.tokenProgram)]);
    this.assertSolCurve(state.quoteMint);
    if (state.bondingCurve.complete) throw new VenueError('bonding curve is complete (migrated)', 'migrated');
    // A cashback coin (an older kind) does not take the exact-spend buy, and the older buy can take up to the amount
    // times (1 + slippage): it is bought through Jupiter, which spends exactly the amount set.
    if (state.bondingCurve.isCashbackCoin && process.env.PUMP_EXACT_BUY !== 'off') throw new VenueError('a cashback coin: bought through Jupiter (exact spend)', 'unsupported_pool');
    const solAmount = bn(lamportsIn);
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: solAmount,
      quoteMint: state.quoteMint,
    });
    if (amount.isZero()) throw new VenueError('quote returned zero tokens for this amount', 'zero_quote');
    const expectedOut = big(amount);
    // Spend exactly `lamportsIn` (fees included) and take whatever tokens that buys, at least the quote less
    // slippage: the price moving against us means fewer tokens, never more SOL. (pump.fun's older buy asks for a
    // fixed number of tokens and lets the program take up to lamportsIn + slippage: at 100 % slippage a buy could
    // cost twice what the user set.) Simulated on mainnet with scripts/check-exact-buy.ts.
    if (process.env.PUMP_EXACT_BUY !== 'off') {
      // A mayhem curve near its end sells only what it has left (partial fill): the budget is lowered to the price of
      // that rest (plus 1 %), so the platform fee and the cost booked are for what is really bought, not the full
      // amount. (An ordinary curve completes and the exact-spend buy spends the whole budget: nothing to lower.)
      let budget = solAmount;
      const left = state.bondingCurve.realTokenReserves;
      if (state.bondingCurve.isMayhemMode && left && left.gtn(0) && amount.gte(left)) {
        const price = big(getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply: state.bondingCurve.tokenTotalSupply, bondingCurve: state.bondingCurve, amount: left, quoteMint: state.quoteMint }));
        const lowered = price + price / 100n + 1n;
        if (price > 0n && lowered < lamportsIn) budget = bn(lowered);
      }
      let instructions;
      try {
        instructions = await PUMP_SDK.buyExactQuoteInV3Instructions({
          bondingCurve: state.bondingCurve,
          // Always "missing": the SDK then adds an idempotent create of the coin account (a no-op when it exists).
          // One of our own sells may have closed it a moment ago, after this state was read.
          associatedUserAccountInfo: null,
          mint: pool.mint,
          user,
          amount,
          quoteAmount: budget,
          slippage: slippagePct,
          tokenProgram: pool.tokenProgram,
          // A mayhem curve near its end: buy what is left instead of failing (ordinary curves complete and carry on).
          partialFill: !!state.bondingCurve.isMayhemMode,
        });
      } catch (err) {
        // Never fall back to the older buy (it can spend up to twice the amount): Jupiter spends an exact amount.
        throw new VenueError(`the exact-spend buy cannot be built for this coin (${err instanceof Error ? err.message : err}): bought through Jupiter`, 'unsupported_pool');
      }
      const minOut = expectedOut - (expectedOut * BigInt(Math.round(Math.min(100, Math.max(0, slippagePct)) * 10))) / 1000n;
      return { instructions, expectedOut, minOut, ...(budget !== solAmount ? { lamportsIn: big(budget) } : {}) };
    }
    // The SDK applies `slippage` (percent) to solAmount as the max SOL the program may take.
    const instructions = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint: pool.mint,
      user,
      amount,
      solAmount,
      slippage: slippagePct,
      tokenProgram: pool.tokenProgram,
    });
    return { instructions, expectedOut, minOut: expectedOut };
  }

  async buildSell({ pool, user, tokensIn, slippagePct }: { pool: ResolvedPool; user: PublicKey; tokensIn: bigint; slippagePct: number }): Promise<BuildResult> {
    const [{ global, feeConfig }, state] = await Promise.all([this.fetchGlobals(), this.sdk().fetchSellState(pool.mint, user, pool.tokenProgram)]);
    this.assertSolCurve(state.quoteMint);
    // The curve completed while we held the coin: it trades on PumpSwap now ('migrated' re-routes it at once).
    if (state.bondingCurve.complete) throw new VenueError('bonding curve is complete (migrated)', 'migrated');
    // Never ask the curve for more SOL than it holds (the program would refuse the whole sell): sell what it can pay
    // for and say so (`tokensIn`), so exactly that is booked and the rest stays for a later sell.
    const selling = sellableTokens(state.bondingCurve, tokensIn);
    if (selling <= 0n) throw new VenueError('the curve holds no SOL right now: nothing can be sold on it until someone buys', 'curve_empty');
    const amount = bn(selling);
    const solAmount = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount,
    });
    const instructions = await PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      mint: pool.mint,
      user,
      amount,
      solAmount,
      slippage: slippagePct,
      tokenProgram: pool.tokenProgram,
      mayhemMode: state.bondingCurve.isMayhemMode,
      cashback: state.bondingCurve.isCashbackCoin,
    });
    const expectedOut = big(solAmount);
    const minOut = expectedOut - (expectedOut * BigInt(Math.round(Math.min(100, Math.max(0, slippagePct)) * 10))) / 1000n;
    return { instructions, expectedOut, minOut, ...(selling < tokensIn ? { tokensIn: selling } : {}) };
  }
}
