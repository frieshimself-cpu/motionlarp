// ported from velo/src/tx/send.ts (Jito path removed: copies go through the RPC with a priority fee).
// The only place a transaction can leave the process: LIVE_TRADING=true AND the caller asked for live.
import type { VersionedTransaction } from '@solana/web3.js';
import { config } from '../config.js';
import { getConnection } from '../chain/connection.js';
import { safeErrorMessage } from '../log.js';

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

/** Jito's block engine: where a tipped transaction competes on its tip. */
async function sendViaJito(tx: VersionedTransaction): Promise<string> {
  const res = await fetch(`${config.jitoUrl.replace(/\/$/, '')}/api/v1/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64' }] }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`jito: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return body.result;
}

/**
 * Test mode: simulate only. Live (request AND server): send at once; simulating first is optional (SIMULATE_LIVE)
 * because every round trip before the send is time the coin's price keeps moving. Slippage limits still apply
 * on-chain, so a bad fill fails instead of filling badly. A tipped transaction goes out through Jito's block
 * engine and the RPC at once: the same signed transaction can only land once, and either path is enough.
 */
export async function sendTransaction(tx: VersionedTransaction, live: boolean, tipped = false): Promise<SendOutcome> {
  if (!config.rpcUrl) return { ok: false, error: 'no RPC_URL configured' };
  if (!(live && canSendLive())) return simulate(tx);
  if (config.simulateLive) {
    const sim = await simulate(tx);
    if (!sim.ok) return sim;
  }
  const paths = tipped && config.jitoUrl ? [sendViaRpc(tx), sendViaJito(tx)] : [sendViaRpc(tx)];
  const results = await Promise.allSettled(paths);
  const ok = results.find((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled');
  if (ok) return { ok: true, signature: ok.value, simulated: false };
  const why = results.map((r) => (r.status === 'rejected' ? safeErrorMessage(r.reason) : '')).filter(Boolean).join(' | ');
  return { ok: false, error: `send failed: ${why}` };
}
