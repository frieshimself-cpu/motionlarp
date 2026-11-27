// The RPC connections of the process, plus a background-refreshed blockhash so the hot path never waits on one.
//
//  * Every request has a time limit, and a rate-limit answer (429) is retried within a fraction of a second.
//    (web3.js on its own waits for a stalled answer for minutes and sleeps 0.5–4 s on a 429: a stalled read once
//    our buy had landed would leave it "opening" and its exit unsold for that long.)
//  * Two views of the chain: 'confirmed' for what must be settled (balances after a trade, blockhashes), and
//    'processed' for the buy path: a leader's trade is heard at 'processed', and a coin bought in the very slot it
//    was created in does not exist yet at 'confirmed'.
//  * Blockhashes of the last half minute are kept: a BUY is signed with one that has only a few seconds of life
//    left, so a copy that did not land at once cannot land half a minute later at any price.
import { Connection, type BlockhashWithExpiryBlockHeight, type Commitment } from '@solana/web3.js';
import { config } from '../config.js';
import { log } from '../log.js';

let connection: Connection | null = null;
let fast: Connection | null = null;
let injected: Connection | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

/** A blockhash can be used for 150 blocks after the one it comes from. */
export const BLOCKHASH_LIFE_BLOCKS = 150;
/** Fastest block time seen on mainnet (about 0.2 s in Nov 2026): used to guess, on the safe side, how many blocks went by. */
const FASTEST_SLOT_MS = 200;
/** A buy is signed with a blockhash that has at least this many blocks left (about 8 s) and as few more as possible. */
export const BUY_BLOCKHASH_MIN_BLOCKS = 40;

/** `at`: last time the RPC gave it; `firstSeen`: when it first appeared (its age decides how much life it has left). */
export interface StampedBlockhash extends BlockhashWithExpiryBlockHeight { at: number; firstSeen?: number }
let recent: StampedBlockhash[] = [];

/**
 * fetch with a time limit; a 429 is tried again after 80, 160 and 320 ms. When the main link still fails (no answer,
 * 5xx, 429), the same request goes to the backup link (RPC_BACKUP_URL; the public endpoint by default) and its answer
 * is used: an outage of the main provider must not stop every sell. Only the request body travels to the backup,
 * never the main link's key.
 */
export async function boundedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], timeoutMs = config.rpcTimeoutMs): Promise<Response> {
  let res: Response | null = null;
  let failure: unknown = null;
  try {
    for (let attempt = 0; ; attempt++) {
      res = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 429 || attempt >= 3) break;
      await new Promise((r) => setTimeout(r, 80 * 2 ** attempt));
    }
  } catch (err) {
    failure = err;
  }
  if (res && res.status !== 429 && res.status < 500) return res;
  const backup = config.rpcBackupUrl;
  if (backup && backup !== 'off' && backup !== String(input)) {
    try {
      const other = await fetch(backup, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (other.ok) {
        noteBackupUsed();
        return other;
      }
    } catch {
      // the backup failed too: the main link's answer (or error) stands
    }
  }
  if (res) return res;
  throw failure;
}

let backupUsedAt = 0;
function noteBackupUsed(): void {
  if (Date.now() - backupUsedAt > 60_000) log.warn('the main RPC link failed: a request was answered by the backup link');
  backupUsedAt = Date.now();
}
/** When the backup link last answered for the main one (0: never). */
export function backupLastUsed(): number {
  return backupUsedAt;
}

function make(commitment: Commitment): Connection {
  if (!config.rpcUrl) throw new Error('RPC_URL is not configured');
  return new Connection(config.rpcUrl, { commitment, disableRetryOnRateLimit: true, fetch: boundedFetch as never });
}

/** Settled state ('confirmed'). */
export function getConnection(): Connection {
  if (injected) return injected;
  return (connection ??= make('confirmed'));
}

/** The freshest state ('processed'), for resolving and building a buy the moment a leader's trade is heard. */
export function getFastConnection(): Connection {
  if (injected) return injected;
  return (fast ??= make('processed'));
}

/** For tests: inject a fake connection (used for both views). */
export function setConnectionForTests(c: Connection | null): void {
  injected = c;
  connection = null;
  fast = null;
  recent = [];
}

/** For tests: the blockhashes "fetched" so far, oldest first. */
export function setBlockhashesForTests(list: StampedBlockhash[]): void {
  recent = [...list];
}

export async function refreshBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
  const bh = await getConnection().getLatestBlockhash('confirmed');
  const now = Date.now();
  const newest = recent[recent.length - 1];
  // A node that lags behind the one that answered last time: its blockhash is older than one already held. Keep the
  // newer one (signing with the older would shorten the life of every transaction).
  if (newest && bh.lastValidBlockHeight < newest.lastValidBlockHeight) {
    newest.at = now;
    return newest;
  }
  if (newest?.blockhash !== bh.blockhash) recent.push({ ...bh, at: now, firstSeen: now });
  else newest.at = now;
  // Keep what can still be useful: about 40 s of history.
  recent = recent.filter((r) => now - r.at < 40_000).slice(-40);
  return bh;
}

/** The newest blockhash: cached when fresh (< 5 s; refreshed every 2 s in the background), otherwise fetched. */
export async function getBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
  const latest = recent[recent.length - 1];
  if (latest && Date.now() - latest.at < 5_000) return latest;
  return refreshBlockhash();
}

/**
 * A blockhash for a BUY: still valid, but only for a few seconds more (the oldest one kept that has at least
 * BUY_BLOCKHASH_MIN_BLOCKS left). A buy that misses its first block leaders then expires in about 8–10 s instead of
 * 30: it cannot fill long after the copied wallet has moved on. Falls back to the newest one when there is no
 * history yet (just after a start).
 */
export async function getShortBlockhash(now = Date.now()): Promise<BlockhashWithExpiryBlockHeight> {
  const latest = await getBlockhash();
  const newest = recent[recent.length - 1];
  if (!newest) return latest;
  // The feed has not moved for a while (the RPC keeps answering with the same blockhash): the height cannot be
  // guessed, so take the newest, as Velo does.
  const born = newest.firstSeen ?? newest.at;
  if (now - born > 4_000) return newest;
  // The chain's height now, guessed high (so a blockhash is never thought to live longer than it does).
  const height = newest.lastValidBlockHeight - BLOCKHASH_LIFE_BLOCKS + Math.ceil(Math.max(0, now - born) / FASTEST_SLOT_MS);
  let pick: StampedBlockhash | null = null;
  for (const r of recent) {
    const left = r.lastValidBlockHeight - height;
    if (left >= BUY_BLOCKHASH_MIN_BLOCKS && (!pick || r.lastValidBlockHeight < pick.lastValidBlockHeight)) pick = r;
  }
  log.debug('buy blockhash', { blocksLeft: (pick ?? newest).lastValidBlockHeight - height, kept: recent.length });
  return pick ?? latest;
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
