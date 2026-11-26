// ported from velo/src/venues/pf.ts
// Picks bonding curve vs PumpSwap for a mint (a completed curve trades on its canonical PumpSwap pool).
import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from '../chain/connection.js';
import { pumpSdk } from './sdk.js';
import { PumpFunVenue } from './pumpfun.js';
import { PumpSwapVenue } from './pumpswap.js';
import { VenueError, type ResolvedPool, type Venue } from './types.js';

const RESOLVE_TTL_MS = 60_000;
const { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, bondingCurvePda, canonicalPumpPoolPda, OnlinePumpSdk } = pumpSdk;

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

  private async fromMint(connection: Connection, mint: PublicKey): Promise<ResolvedPool | null> {
    const tokenProgram = await this.tokenProgramOf(connection, mint);
    const curvePda = bondingCurvePda(mint);
    const curveInfo = await connection.getAccountInfo(curvePda, 'confirmed');
    if (curveInfo && curveInfo.owner.equals(PUMP_PROGRAM_ID)) {
      const curve = await new OnlinePumpSdk(connection).fetchBondingCurve(mint);
      if (curve.complete) return this.migrated(connection, mint, tokenProgram, curvePda);
      return { kind: 'pumpfun_curve', pool: curvePda, mint, tokenProgram };
    }
    // No curve: maybe a PumpSwap canonical pool exists anyway.
    const poolPda = canonicalPumpPoolPda(mint);
    const poolInfo = await connection.getAccountInfo(poolPda, 'confirmed');
    if (poolInfo && poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) return { kind: 'pumpswap', pool: poolPda, mint, tokenProgram };
    return null;
  }

  private async migrated(connection: Connection, mint: PublicKey, tokenProgram: PublicKey, curve: PublicKey): Promise<ResolvedPool> {
    const poolPda = canonicalPumpPoolPda(mint);
    const poolInfo = await connection.getAccountInfo(poolPda, 'confirmed');
    if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) {
      throw new VenueError('curve is complete but its PumpSwap pool was not found yet', 'migrating');
    }
    return { kind: 'pumpswap', pool: poolPda, mint, tokenProgram, migratedFrom: curve };
  }

  private async tokenProgramOf(connection: Connection, mint: PublicKey): Promise<PublicKey> {
    const info = await connection.getAccountInfo(mint, 'confirmed');
    if (!info) throw new VenueError(`mint ${mint.toBase58()} not found`, 'unresolved');
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
    throw new VenueError(`${mint.toBase58()} is not a token mint`, 'unresolved');
  }
}
