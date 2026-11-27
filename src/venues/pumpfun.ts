// ported from velo/src/venues/pumpfun.ts
// pump.fun bonding curve, via the official @pump-fun/pump-sdk (v4). Nothing here lists program accounts by hand.
// Scope: SOL-quoted curves only. Token-quoted curves (quote mints) are refused in step 1.
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getFastConnection } from '../chain/connection.js';
import { pumpSdk, type FeeConfig, type Global } from './sdk.js';
import { VenueError, type BuildResult, type ResolvedPool, type Venue } from './types.js';

const GLOBAL_TTL_MS = 5 * 60_000;
const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, isSolLikeQuoteMint, normalizeQuoteMint } = pumpSdk;
type OnlinePumpSdk = InstanceType<typeof OnlinePumpSdk>;

function bn(v: bigint): BN {
  return new BN(v.toString());
}
function big(v: BN): bigint {
  return BigInt(v.toString());
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

  /** `Global` and `FeeConfig` change rarely; cache them for five minutes. */
  private async fetchGlobals(): Promise<{ global: Global; feeConfig: FeeConfig | null }> {
    // Kept only when the fee table was read: without it the SDK prices with a flat fee that is 0.24 % off.
    if (this.globals && this.globals.feeConfig !== null && Date.now() - this.globals.at < GLOBAL_TTL_MS) return this.globals;
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
    const { global, feeConfig } = await this.fetchGlobals();
    const curve = await this.sdk().fetchBondingCurve(pool.mint);
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
    const { global, feeConfig } = await this.fetchGlobals();
    const curve = await this.sdk().fetchBondingCurve(pool.mint);
    this.assertSolCurve(curve.quoteMint);
    // A completed curve quotes 0 (its reserves are gone): that would fire every stop loss. It trades on PumpSwap now.
    if (curve.complete) throw new VenueError('bonding curve is complete (migrated)', 'migrated');
    const out = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: bn(tokensIn),
    });
    return big(out);
  }

  async buildBuy({ pool, user, lamportsIn, slippagePct }: { pool: ResolvedPool; user: PublicKey; lamportsIn: bigint; slippagePct: number }): Promise<BuildResult> {
    const { global, feeConfig } = await this.fetchGlobals();
    const state = await this.sdk().fetchBuyState(pool.mint, user, pool.tokenProgram);
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
      let instructions;
      try {
        instructions = await PUMP_SDK.buyExactQuoteInV3Instructions({
          bondingCurve: state.bondingCurve,
          associatedUserAccountInfo: state.associatedUserAccountInfo,
          mint: pool.mint,
          user,
          amount,
          quoteAmount: solAmount,
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
      return { instructions, expectedOut, minOut };
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
    const { global, feeConfig } = await this.fetchGlobals();
    const state = await this.sdk().fetchSellState(pool.mint, user, pool.tokenProgram);
    this.assertSolCurve(state.quoteMint);
    // The curve completed while we held the coin: it trades on PumpSwap now ('migrated' re-routes it at once).
    if (state.bondingCurve.complete) throw new VenueError('bonding curve is complete (migrated)', 'migrated');
    const amount = bn(tokensIn);
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
    return { instructions, expectedOut, minOut };
  }
}
