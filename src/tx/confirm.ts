// ported from velo/src/tx/confirm.ts, reworked: a transaction is "not landed" only once its blockhash has expired
// (it can no longer land), not after a fixed timeout; RPC errors while polling are retried, not taken as failure.
import { getConnection } from '../chain/connection.js';

export type ConfirmOutcome = { landed: true; slot?: number } | { landed: false; reason: string; certain: boolean };

const POLL_MS = 300;
const HARD_CAP_MS = 150_000;

export async function confirmSignature(signature: string, lastValidBlockHeight?: number): Promise<ConfirmOutcome> {
  if (signature.startsWith('SIMULATED_') || signature.startsWith('PAPER_')) return { landed: true };
  const connection = getConnection();
  const deadline = Date.now() + HARD_CAP_MS;
  let polls = 0;
  while (Date.now() < deadline) {
    try {
      const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
      const status = res.value[0];
      if (status?.err) return { landed: false, reason: `transaction errored: ${JSON.stringify(status.err)}`, certain: true };
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return { landed: true, slot: status.slot };
      if (lastValidBlockHeight !== undefined && polls % 10 === 9) {
        const height = await connection.getBlockHeight('confirmed');
        if (height > lastValidBlockHeight) {
          // Expired: one last look, then it is certain the transaction will never land.
          const last = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
          if (last && !last.err && last.confirmationStatus) return { landed: true, slot: last.slot };
          return { landed: false, reason: 'expired before landing', certain: true };
        }
      }
    } catch {
      // RPC hiccup: keep polling.
    }
    polls++;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { landed: false, reason: 'confirmation unknown (RPC unreachable)', certain: false };
}
