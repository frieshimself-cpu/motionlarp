// ported from velo/src/tx/confirm.ts
// Confirmation: poll signature statuses until confirmed/finalized, errored, or the timeout.
import { config } from '../config.js';
import { getConnection } from '../chain/connection.js';

export type ConfirmOutcome = { landed: true; slot?: number } | { landed: false; reason: string };

const POLL_MS = 1000;

export async function confirmSignature(signature: string, timeoutMs = config.confirmTimeoutMs): Promise<ConfirmOutcome> {
  if (signature.startsWith('SIMULATED_') || signature.startsWith('STUB_')) return { landed: true };
  const connection = getConnection();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const status = res.value[0];
    if (status) {
      if (status.err) return { landed: false, reason: `transaction errored: ${JSON.stringify(status.err)}` };
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return { landed: true, slot: status.slot };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { landed: false, reason: `not confirmed within ${timeoutMs} ms` };
}
