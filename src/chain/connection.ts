// ported from velo/src/chain/connection.ts
// One RPC connection for the process, plus a background-refreshed blockhash so the hot path never waits on one.
import { Connection, type BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
import { config } from '../config.js';
import { log } from '../log.js';

let connection: Connection | null = null;
let cached: BlockhashWithExpiryBlockHeight | null = null;
let cachedAt = 0;
let refreshTimer: NodeJS.Timeout | null = null;

export function getConnection(): Connection {
  if (connection) return connection;
  if (!config.rpcUrl) throw new Error('RPC_URL is not configured');
  connection = new Connection(config.rpcUrl, { commitment: 'confirmed' });
  return connection;
}

/** For tests: inject a fake connection. */
export function setConnectionForTests(c: Connection | null): void {
  connection = c;
  cached = null;
}

export async function refreshBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
  const bh = await getConnection().getLatestBlockhash('confirmed');
  cached = bh;
  cachedAt = Date.now();
  return bh;
}

/** Cached when fresh (< 5 s; refreshed every 2 s in the background), otherwise fetched. */
export async function getBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
  if (cached && Date.now() - cachedAt < 5_000) return cached;
  return refreshBlockhash();
}

export function startBlockhashRefresher(): void {
  if (!config.rpcUrl || refreshTimer) return;
  const tick = async () => {
    try {
      await refreshBlockhash();
    } catch (err) {
      log.warn('blockhash refresh failed', { error: String(err) });
    }
  };
  void tick();
  refreshTimer = setInterval(tick, config.blockhashRefreshMs);
  refreshTimer.unref();
}

export function stopBlockhashRefresher(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}
