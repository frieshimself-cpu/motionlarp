// ported from velo/src/venues/pf.ts
// Picks bonding curve vs PumpSwap for a mint (a completed curve trades on its canonical PumpSwap pool).
import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from '../chain/connection.js';
import { pumpSdk, pumpSwapSdk } from './sdk.js';
import { PumpFunVenue } from './pumpfun.js';
import { PumpSwapVenue } from './pumpswap.js';
import { VenueError, type ResolvedPool, type Venue } from './types.js';

const RESOLVE_TTL_MS = 60_000;
const { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda } = pumpSdk;
const { PUMP_AMM_SDK } = pumpSwapSdk;

export class PfDispatcher {
  readonly curve = new PumpFunVenue();
  readonly amm = new PumpSwapVenue();
  private readonly cache = new Map<string, { pool: ResolvedPool; at: number }>();

  venueFor(pool: ResolvedPool): Venue {
    return pool.kind === 'pumpswap' ? this.amm : this.curve;
  }

  /** Resolve a coin by its mint: live bonding curve, or the PumpSwap pool it migrated to. Cached for a minute. */
  async resolve(mint: string, opts: { forceRefresh?: boolean } = {}): Promise<ResolvedPool> {
    const hit = this.cache.get(mint);
    if (hit && !opts.forceRefresh && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.pool;
    const resolved = await this.fromMint(getConnection(), new PublicKey(mint));
    if (!resolved) throw new VenueError('not a pump.fun or PumpSwap coin', 'unresolved');
    this.cache.set(mint, { pool: resolved, at: Date.now() });
    return resolved;
  }

  /** One round trip: the mint, its bonding curve and its canonical PumpSwap pool, fetched together. */
  private async fromMint(connection: Connection, mint: PublicKey): Promise<ResolvedPool | null> {
    const curvePda = bondingCurvePda(mint);
    const poolPda = canonicalPumpPoolPda(mint);
    const [mintInfo, curveInfo, poolInfo] = await connection.getMultipleAccountsInfo([mint, curvePda, poolPda], 'confirmed');
    if (!mintInfo) throw new VenueError(`mint ${mint.toBase58()} not found`, 'unresolved');
    const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : mintInfo.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : null;
    if (!tokenProgram) throw new VenueError(`${mint.toBase58()} is not a token mint`, 'unresolved');
    const ammPool = poolInfo && poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID) ? poolPda : null;
    if (curveInfo && curveInfo.owner.equals(PUMP_PROGRAM_ID)) {
      const curve = PUMP_SDK.decodeBondingCurve(curveInfo as never);
      if (!curve.complete) return { kind: 'pumpfun_curve', pool: curvePda, mint, tokenProgram };
      if (!ammPool) throw new VenueError('curve is complete but its PumpSwap pool was not found yet', 'migrating');
      return { kind: 'pumpswap', pool: ammPool, mint, tokenProgram, migratedFrom: curvePda };
    }
    if (ammPool) return { kind: 'pumpswap', pool: ammPool, mint, tokenProgram };
    return this.otherAmmPool(connection, mint, tokenProgram);
  }

  /**
   * A PumpSwap pool that is not the coin's canonical one (coins not launched on pump.fun). Found by its base mint
   * (byte offset 43 of the pool account, checked against a decoded pool on mainnet) and confirmed by decoding.
   * Only SOL-quoted pools are used; a pool laid out the other way round (SOL as base) is refused.
   */
  private async otherAmmPool(connection: Connection, mint: PublicKey, tokenProgram: PublicKey): Promise<ResolvedPool | null> {
    const res = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, { commitment: 'confirmed', filters: [{ memcmp: { offset: 43, bytes: mint.toBase58() } }] });
    let best: { pool: PublicKey; reserve: bigint } | null = null;
    for (const r of res) {
      const d = PUMP_AMM_SDK.decodePoolNullable(r.account as never);
      if (!d || !d.baseMint.equals(mint) || !pumpSwapSdk.isSolLikeQuoteMint(d.quoteMint)) continue;
      const reserve = BigInt(r.account.lamports);
      if (!best || reserve > best.reserve) best = { pool: r.pubkey, reserve };
    }
    if (best) return { kind: 'pumpswap', pool: best.pool, mint, tokenProgram };
    const reversed = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, { commitment: 'confirmed', filters: [{ memcmp: { offset: 75, bytes: mint.toBase58() } }], dataSlice: { offset: 0, length: 0 } });
    if (reversed.length) throw new VenueError('this coin\'s pool is quoted the other way round (SOL as the base) — not supported', 'unsupported_pool');
    return null;
  }
}
