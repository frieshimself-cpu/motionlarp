// The only place a transaction can leave the process: LIVE_TRADING=true AND the caller asked for live.
//
// A live transaction goes out on every lane at once: the RPC's sendTransaction, and for a tipped trade Helius
// Sender (or Jito's block engine when Sender is off). The same signed bytes can only land once, so sending them
// more than once, on more than one lane, is always safe; signing a second transaction for the same trade is not.
//
//  * The first lane that takes the transaction is enough: the trade does not wait for a slow lane to give up.
//  * When no lane answers (timeouts, 5xx, 429), the transaction may still have gone out: the result says
//    "uncertain", the caller watches the chain (and keeps re-sending the same bytes) until it lands or its
//    blockhash expires. Only when every lane refused the transaction itself was it not sent.
//  * Both Helius lanes are asked to route around validators linked to sandwich attacks (MEV Protect).
import bs58 from 'bs58';
import type { VersionedTransaction } from '@solana/web3.js';
import { config } from '../config.js';
import { getConnection } from '../chain/connection.js';
import { log, safeErrorMessage } from '../log.js';
import { GLOBAL_SENDER } from './sender-region.js';
import { senderEndpoint } from './tip.js';

export type SendOutcome =
  | {
      ok: true; signature: string; simulated: boolean; computeUnits?: number;
      /** No lane confirmed taking it (network trouble): it may still have gone out. The chain decides. */
      uncertain?: boolean;
    }
  | { ok: false; error: string; logs?: string[] };

type LaneName = 'rpc' | 'sender' | 'jito';

/** Answers that say nothing about the transaction itself: the lane was busy, slow or unreachable. */
const TRANSIENT = /\b429\b|\b5\d\d\b|rate.?limit|too many|time.?out|timed out|abort|fetch failed|socket|ECONN|ENOTFOUND|EAI_AGAIN|network|unavailable|overload|busy|upstream|terminated/i;

/** How each lane has done since the server started (shown on the status line, so a dead lane is visible). */
export const laneStats = {
  counts: {} as Record<string, { ok: number; failed: number }>,
  hit(lane: LaneName, ok: boolean): void {
    const c = (this.counts[lane] ??= { ok: 0, failed: 0 });
    if (ok) c.ok++; else c.failed++;
  },
  reset(): void { this.counts = {}; },
  text(): string {
    const parts = Object.entries(this.counts).map(([lane, c]) => `${lane} ${c.ok}/${c.ok + c.failed}`);
    return parts.length ? parts.join(', ') : 'nothing sent yet';
  },
};

/** A transaction's signature is its first signature: known the moment it is signed, whatever a lane answers. */
export function signatureOf(tx: VersionedTransaction): string {
  return bs58.encode(tx.signatures[0] ?? new Uint8Array(64));
}

export async function simulate(tx: VersionedTransaction): Promise<SendOutcome> {
  const sim = await getConnection().simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const programLog = logs.filter((l) => /failed|Error|error|insufficient/i.test(l)).slice(-3).join(' | ');
    return { ok: false, error: `simulation failed: ${JSON.stringify(sim.value.err)} ${programLog}`.slice(0, 300), logs };
  }
  const sig = Buffer.from(tx.signatures[0] ?? new Uint8Array(0)).toString('hex').slice(0, 16);
  return { ok: true, signature: `SIMULATED_${sig}`, simulated: true, computeUnits: sim.value.unitsConsumed };
}

/** True only when the server is in live mode; a copy set to live on a test server still only simulates. */
export function canSendLive(): boolean {
  return config.liveTrading && !!config.rpcUrl;
}

/** The RPC's own sendTransaction. On Helius, with the request to stay away from sandwiching validators. */
function rpcSendUrl(): string {
  if (!config.mevProtect) return config.rpcUrl;
  try {
    const u = new URL(config.rpcUrl);
    if (!u.hostname.endsWith('helius-rpc.com')) return config.rpcUrl;
    u.searchParams.set('mev-protect', 'true');
    return u.toString();
  } catch {
    return config.rpcUrl;
  }
}

async function post(url: string, raw: string, what: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // maxRetries 0: re-sending is ours to do (resend(), about once a second until the transaction lands).
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
    signal: AbortSignal.timeout(config.sendLaneTimeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`${what}: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return body.result;
}

let senderStrikes = 0;
/** A Sender region that keeps failing is dropped for the global address (the server re-picks a region later). */
function senderResult(ok: boolean): void {
  if (ok) { senderStrikes = 0; return; }
  if (++senderStrikes >= 3 && config.senderUrl !== GLOBAL_SENDER && config.senderUrl !== 'off') {
    log.warn('the Sender region failed three times in a row: using the global Sender address', { was: config.senderUrl });
    config.senderUrl = GLOBAL_SENDER;
    senderStrikes = 0;
  }
}

async function lane(name: LaneName, url: string, raw: string): Promise<string> {
  try {
    const sig = await post(url, raw, name);
    laneStats.hit(name, true);
    if (name === 'sender') senderResult(true);
    return sig;
  } catch (err) {
    laneStats.hit(name, false);
    if (name === 'sender') senderResult(false);
    throw err;
  }
}

/** One attempt on every lane; each promise settles on its own. */
function broadcast(tx: VersionedTransaction, tip: bigint): Promise<string>[] {
  const raw = Buffer.from(tx.serialize()).toString('base64');
  const only = config.sendOnly;
  const lanes: Promise<string>[] = [];
  if (only !== 'sender') lanes.push(lane('rpc', rpcSendUrl(), raw));
  if (tip > 0n && only !== 'rpc') {
    const sender = senderEndpoint(config.senderUrl, config.rpcUrl, tip, config.mevProtect);
    if (sender) lanes.push(lane('sender', sender, raw));
    else if (config.jitoUrl) lanes.push(lane('jito', `${config.jitoUrl.replace(/\/$/, '')}/api/v1/transactions`, raw));
  }
  if (!lanes.length) lanes.push(lane('rpc', rpcSendUrl(), raw));
  return lanes;
}

/**
 * Test mode: simulate only. Live (request AND server): send at once; simulating first is optional (SIMULATE_LIVE)
 * because every round trip before the send is time the coin's price keeps moving. Slippage limits still apply
 * on-chain, so a bad fill fails instead of filling badly.
 */
export async function sendTransaction(tx: VersionedTransaction, live: boolean, tip = 0n, opts: { exit?: boolean; simulateFirst?: boolean } = {}): Promise<SendOutcome> {
  if (!config.rpcUrl) return { ok: false, error: 'no RPC_URL configured' };
  // The Live switch stops new real buys. A sell of a position bought for real (exit) still goes out.
  if (!(live && (canSendLive() || opts.exit))) return simulate(tx);
  // A retry is simulated first: one that cannot work (the curve moved on, the tokens already sold) costs nothing.
  if (config.simulateLive || opts.simulateFirst) {
    const sim = await simulate(tx);
    if (!sim.ok) return sim;
  }
  const signature = signatureOf(tx);
  const attempts = broadcast(tx, tip);
  try {
    await Promise.any(attempts);
    // A lane that fails after another took the trade is worth knowing about, not worth waiting for.
    void Promise.allSettled(attempts).then((all) => {
      const failed = all.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => safeErrorMessage(r.reason));
      if (failed.length) log.warn('a send path failed (the trade still went out)', { failed });
    });
    return { ok: true, signature, simulated: false };
  } catch (err) {
    const reasons = (err instanceof AggregateError ? err.errors : [err]).map((e) => safeErrorMessage(e));
    if (reasons.every((r) => !TRANSIENT.test(r))) return { ok: false, error: `send refused: ${reasons.join(' | ')}` };
    log.warn('no send path answered: watching the chain for the transaction', { reasons });
    return { ok: true, signature, simulated: false, uncertain: true };
  }
}

/** Puts the same signed transaction on every lane again (same signature: it can only land once). Never throws. */
export function resend(tx: VersionedTransaction, tip = 0n, exit = false): void {
  if (!config.rpcUrl || !(canSendLive() || exit)) return;
  try {
    for (const attempt of broadcast(tx, tip)) attempt.catch(() => undefined);
  } catch {
    // nothing to do: the next re-send tries again
  }
}
