// A transaction is "not landed" only once its blockhash has expired (it can no longer land), not after a fixed
// timeout; RPC errors while polling are retried, not taken as failure. While waiting, the same signed transaction is
// re-sent about once a second: one that was dropped on the way to a block leader gets another chance at the next
// leader instead of sitting until it expires (about 30 s).
import { getConnection, LAST_BLOCK_PAST_VALID } from '../chain/connection.js';

export type ConfirmOutcome = { landed: true; slot?: number } | { landed: false; reason: string; certain: boolean };

const POLL_MS = 300;
const HARD_CAP_MS = 150_000;
/** Re-send this often while the transaction has not been seen in a block. */
const RESEND_EVERY_MS = 900;

export interface ConfirmOptions {
  /** Puts the same signed transaction out again (never a newly signed one). */
  resend?: () => void;
  /** Re-send only for this long after the start (a buy); omitted = until it lands or expires (a sell). */
  resendForMs?: number;
  /** How often to re-send (default 0.9 s). */
  resendEveryMs?: number;
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
  // Re-sending runs on its own timer: when the status checks fail (the RPC in trouble), a dropped transaction must
  // still be pushed again, through Sender at least. It stops the moment the outcome is known.
  let seen = false;
  const timer = opts.resend
    ? setInterval(() => {
        if (seen || (opts.resendForMs !== undefined && Date.now() - started > opts.resendForMs)) return;
        try { opts.resend!(); } catch { /* the next tick tries again */ }
      }, opts.resendEveryMs ?? RESEND_EVERY_MS)
    : null;
  try {
    return await poll();
  } finally {
    if (timer) clearInterval(timer);
  }

  async function poll(): Promise<ConfirmOutcome> {
  while (Date.now() < deadline) {
    try {
      const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
      const status = res.value[0];
      // (A status without a confirmation level is an old, rooted one: settled.)
      const settled = !!status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' || !status.confirmationStatus);
      // An error is final only once confirmed: one seen at 'processed' may be in a block that is then dropped, and
      // the same transaction can still land (and fill) in the real chain.
      if (settled && status!.err) return { landed: false, reason: `transaction errored: ${JSON.stringify(status!.err)}`, certain: true };
      if (settled) return { landed: true, slot: status!.slot };
      if (lastValidBlockHeight !== undefined && polls % 10 === 9) {
        // The height and the slot it was read at, from one node.
        const tip = await connection.getEpochInfo('confirmed');
        if (tip.blockHeight !== undefined && tip.blockHeight > lastValidBlockHeight + LAST_BLOCK_PAST_VALID) {
          // Expired: one last look, then it is certain the transaction will never land, provided that look was answered
          // by a node at least as far along as the one that gave the height (the two are separate requests, maybe to
          // two nodes: one some blocks behind has not seen a transaction that landed in its last blocks yet).
          const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
          const last = res.value[0];
          if (last && !last.err && last.confirmationStatus) return { landed: true, slot: last.slot };
          const seenFrom = (res as { context?: { slot?: number } }).context?.slot;
          if (seenFrom === undefined || seenFrom >= tip.absoluteSlot) return { landed: false, reason: 'expired before landing', certain: true };
        }
      }
      // In a block: no more pushing for now. If that block is dropped the status goes away and pushing resumes.
      seen = !!status;
    } catch {
      // RPC hiccup: keep polling.
    }
    polls++;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { landed: false, reason: 'confirmation unknown (RPC unreachable)', certain: false };
  }
}
