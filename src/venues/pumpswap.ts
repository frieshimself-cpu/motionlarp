// ported from velo/src/venues/pumpswap.ts
// PumpSwap AMM (graduated pump.fun tokens), via the official @pump-fun/pump-swap-sdk (v2).
// Scope: pools quoted in (W)SOL only; the SDK wraps/unwraps WSOL and creates the user's missing ATA.
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection } from '../chain/connection.js';
import { pumpSwapSdk, type SwapSolanaState } from './sdk.js';
import { VenueError, type BuildResult, type ResolvedPool, type Venue } from './types.js';

const { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, sellBaseInput, isSolLikeQuoteMint, supportsTradeV2 } = pumpSwapSdk;
type OnlinePumpAmmSdk = InstanceType<typeof OnlinePumpAmmSdk>;

function bn(v: bigint): BN {
  return new BN(v.toString());
}
function big(v: BN): bigint {
  return BigInt(v.toString());
}

function poolArgs(s: SwapSolanaState) {
  return {
    baseReserve: s.poolBaseAmount,
    quoteReserve: s.poolQuoteAmount,
    virtualQuoteReserves: s.pool.virtualQuoteReserves,
    feeBucketsTotal: s.pool.protocolFees.add(s.pool.creatorFees),
    globalConfig: s.globalConfig,
    feeConfig: s.feeConfig,
    baseMint: s.baseMint,
    baseMintAccount: s.baseMintAccount,
    coinCreator: s.pool.coinCreator,
    creator: s.pool.creator,
    quoteMint: s.pool.quoteMint,
    isMayhemMode: s.pool.isMayhemMode,
    creatorFeeBps: s.pool.creatorFeeBps,
    quoteTransferFee: s.quoteTransferFee,
  };
}

export class PumpSwapVenue implements Venue {
  readonly kind = 'pumpswap' as const;
  private online: OnlinePumpAmmSdk | null = null;

  private sdk(): OnlinePumpAmmSdk {
    if (!this.online) this.online = new OnlinePumpAmmSdk(getConnection());
    return this.online;
  }

  private async state(pool: ResolvedPool, user: PublicKey): Promise<SwapSolanaState> {
    const s = await this.sdk().swapSolanaState(pool.pool, user);
    if (!isSolLikeQuoteMint(s.pool.quoteMint)) throw new VenueError('non-SOL quoted pools are not supported yet', 'unsupported_quote');
    return s;
  }

  async quoteBuy(pool: ResolvedPool, lamportsIn: bigint): Promise<bigint> {
    const s = await this.state(pool, PublicKey.default);
    const q = buyQuoteInput({ ...poolArgs(s), quote: bn(lamportsIn), slippage: 0, tradeV2: supportsTradeV2(s.pool) });
    return big(q.base);
  }

  async quoteSell(pool: ResolvedPool, tokensIn: bigint): Promise<bigint> {
    const s = await this.state(pool, PublicKey.default);
    const q = sellBaseInput({ ...poolArgs(s), base: bn(tokensIn), slippage: 0 });
    return big(q.uiQuote);
  }

  async buildBuy({ pool, user, lamportsIn, slippagePct }: { pool: ResolvedPool; user: PublicKey; lamportsIn: bigint; slippagePct: number }): Promise<BuildResult> {
    const s = await this.state(pool, user);
    // Spend exactly `lamportsIn` (fees included) and take whatever coins that buys, at least the quote less
    // slippage: a price that moved means fewer coins, never more SOL. The SDK's usual buy (buyQuoteInput) asks for
    // a fixed number of coins and lets the pool take up to lamportsIn x (1 + slippage): at 100 % slippage it wraps
    // TWICE the amount (a 7 SOL buy needs 14 SOL in the wallet and can spend up to 14). Only the newer instruction
    // (buy_exact_quote_in_v2) spends a fixed budget; pools it does not accept (cashback coins) are not traded
    // here: 'unsupported_pool' sends them through Jupiter, which also spends an exact amount.
    if (!supportsTradeV2(s.pool)) throw new VenueError('this pool does not take the exact-spend buy (a cashback coin): traded through Jupiter', 'unsupported_pool');
    const q = buyQuoteInput({ ...poolArgs(s), quote: bn(lamportsIn), slippage: 0, tradeV2: true });
    if (q.base.isZero()) throw new VenueError('quote returned zero tokens for this amount', 'zero_quote');
    const expectedOut = big(q.base);
    let minOut = expectedOut - (expectedOut * BigInt(Math.round(Math.min(100, Math.max(0, slippagePct)) * 10))) / 1000n;
    if (minOut < 1n) minOut = 1n; // the program refuses a minimum of zero
    const instructions = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(s, bn(lamportsIn), bn(minOut));
    return { instructions, expectedOut, minOut };
  }

  async buildSell({ pool, user, tokensIn, slippagePct }: { pool: ResolvedPool; user: PublicKey; tokensIn: bigint; slippagePct: number }): Promise<BuildResult> {
    const s = await this.state(pool, user);
    const q = sellBaseInput({ ...poolArgs(s), base: bn(tokensIn), slippage: slippagePct });
    const instructions = await PUMP_AMM_SDK.sellBaseInput(s, bn(tokensIn), slippagePct, { v2: true });
    return { instructions, expectedOut: big(q.uiQuote), minOut: big(q.minQuote) };
  }
}
