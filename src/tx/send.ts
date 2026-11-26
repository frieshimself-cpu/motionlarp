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

/**
 * Test mode: simulate only. Live (request AND server): send at once; simulating first is optional (SIMULATE_LIVE)
 * because every round trip before the send is time the coin's price keeps moving. Slippage limits still apply
 * on-chain, so a bad fill fails instead of filling badly.
 */
export async function sendTransaction(tx: VersionedTransaction, live: boolean): Promise<SendOutcome> {
  if (!config.rpcUrl) return { ok: false, error: 'no RPC_URL configured' };
  if (!(live && canSendLive())) return simulate(tx);
  if (config.simulateLive) {
    const sim = await simulate(tx);
    if (!sim.ok) return sim;
  }
  try {
    const signature = await getConnection().sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    return { ok: true, signature, simulated: false };
  } catch (err) {
    return { ok: false, error: `send failed: ${safeErrorMessage(err)}` };
  }
}
