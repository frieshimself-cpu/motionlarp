// A transaction is "not landed" only once its blockhash has expired (it can no longer land), not after a fixed
// timeout; RPC errors while polling are retried, not taken as failure. While waiting, the same signed transaction is
// re-sent about once a second: one that was dropped on the way to a block leader gets another chance at the next
// leader instead of sitting until it expires (about 30 s).
import { getConnection } from '../chain/connection.js';

export type ConfirmOutcome = { landed: true; slot?: number } | { landed: false; reason: string; certain: boolean };

const POLL_MS = 300;
const HARD_CAP_MS = 150_000;
/** Re-send every this many polls (0.9 s at the normal pace). */
const RESEND_EVERY_POLLS = 3;

export interface ConfirmOptions {
  /** Puts the same signed transaction out again (never a newly signed one). */
  resend?: () => void;
  /** Re-send only for this long after the first poll (a buy); omitted = until it lands or expires (a sell). */
  resendForMs?: number;
  /** For tests. */
  pollMs?: number;
}

export async function confirmSignature(signature: string, lastValidBlockHeight?: number, opts: ConfirmOptions = {}): Promise<ConfirmOutcome> {
  if (signature.startsWith('SIMULATED_') || signature.startsWith('PAPER_')) return { landed: true };
  const connection = getConnection();
  const pollMs = opts.pollMs ?? POLL_MS;
  const started = Date.now();
  const deadline = started + HARD_CAP_MS;
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
      // Not seen yet (or only processed): give it another push.
      if (!status && opts.resend && polls > 0 && polls % RESEND_EVERY_POLLS === 0 && (opts.resendForMs === undefined || Date.now() - started <= opts.resendForMs)) opts.resend();
    } catch {
      // RPC hiccup: keep polling.
    }
    polls++;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { landed: false, reason: 'confirmation unknown (RPC unreachable)', certain: false };
}
