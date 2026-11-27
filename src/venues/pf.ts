// ported from velo/src/venues/pf.ts
// Picks bonding curve vs PumpSwap for a pump.fun coin (a completed curve trades on its canonical PumpSwap pool).
// Every other coin is not resolved here: the executor sends it through Jupiter.
import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from '../chain/connection.js';
import { pumpSdk } from './sdk.js';
import { PumpFunVenue } from './pumpfun.js';
import { PumpSwapVenue } from './pumpswap.js';
import { VenueError, type ResolvedPool, type Venue } from './types.js';

const RESOLVE_TTL_MS = 60_000;
const { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda } = pumpSdk;


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
    // Not a pump.fun coin. Anyone can open a PumpSwap pool for any coin, and such side pools are usually tiny: on
    // mainnet (27 Nov 2026) the ones for BONK, WIF and JUP gave 25–55 % of the market's coins for 0.01 SOL and
    // 0.04–0.17 % for 7 SOL (scripts/check-side-pool.ts). They are never traded directly: the coin is "unresolved"
    // here and goes through Jupiter, which takes the best route across every venue, such a pool included when it
    // really is the best.
    return null;
  }
}
