// ported from velo/src/tx/send.ts (Jito path removed: copies go through the RPC with a priority fee).
// The only place a transaction can leave the process: LIVE_TRADING=true AND the caller asked for live.
import type { VersionedTransaction } from '@solana/web3.js';
import { config } from '../config.js';
import { getConnection } from '../chain/connection.js';
import { log, safeErrorMessage } from '../log.js';
import { senderEndpoint } from './tip.js';

export type SendOutcome =
  | { ok: true; signature: string; simulated: boolean; computeUnits?: number }
  | { ok: false; error: string; logs?: string[] };

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

async function sendViaRpc(tx: VersionedTransaction): Promise<string> {
  return getConnection().sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
}

async function postTransaction(url: string, tx: VersionedTransaction, what: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`${what}: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return body.result;
}

/**
 * Test mode: simulate only. Live (request AND server): send at once; simulating first is optional (SIMULATE_LIVE)
 * because every round trip before the send is time the coin's price keeps moving. Slippage limits still apply
 * on-chain, so a bad fill fails instead of filling badly. A tipped transaction goes out through Helius Sender (or
 * Jito's block engine when Sender is off) and the RPC at once: the same signed transaction can only land once, and
 * either path is enough.
 */
export async function sendTransaction(tx: VersionedTransaction, live: boolean, tip = 0n): Promise<SendOutcome> {
  if (!config.rpcUrl) return { ok: false, error: 'no RPC_URL configured' };
  if (!(live && canSendLive())) return simulate(tx);
  if (config.simulateLive) {
    const sim = await simulate(tx);
    if (!sim.ok) return sim;
  }
  const paths = [sendViaRpc(tx)];
  if (tip > 0n) {
    const sender = senderEndpoint(config.senderUrl, config.rpcUrl, tip);
    if (sender) paths.push(postTransaction(sender, tx, 'sender'));
    else if (config.jitoUrl) paths.push(postTransaction(`${config.jitoUrl.replace(/\/$/, '')}/api/v1/transactions`, tx, 'jito'));
  }
  const results = await Promise.allSettled(paths);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => safeErrorMessage(r.reason));
  const ok = results.find((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled');
  if (ok) {
    // One lane is enough for the trade; a fast lane that refused it is worth knowing about.
    if (failed.length) log.warn('a send path failed (the trade still went out)', { failed });
    return { ok: true, signature: ok.value, simulated: false };
  }
  return { ok: false, error: `send failed: ${failed.join(' | ')}` };
}
