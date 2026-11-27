// When a trade that was not found can never land: one rule for the engine (a sell left by a crash, a sell or a buy of
// unknown outcome) and for the wait for a trade's confirmation (src/tx/confirm.ts), so that both say the same.
import { LAST_BLOCK_PAST_VALID, WELL_PAST_BLOCKS } from './connection.js';

/** "Not found" is believed only this many blocks past the last block a sell could land in (about 4 s), and only from a
 *  node at least as far along as the one that gave the chain's height: the two are separate requests, perhaps answered
 *  by two nodes (a load-balanced link, or the backup link taking over one request). Waiting a few seconds more costs
 *  little; a sale that landed taken for one that did not is never booked, and its rule sells again. */
export const NOT_FOUND_MARGIN_BLOCKS = 10;

/**
 * A trade not found that never can land. The chain's tip (its height and that block's slot) was read before the status:
 * the last block the trade could land in (one past its blockhash's last valid height) then had a slot no later than the
 * tip's slot less the blocks since (a slot per block at least). A status that tells how far along its node was is
 * believed once that node has reached that slot, and the chain is a margin past the block (a node on a short fork of its
 * own): a node behind it may not have seen a trade that landed in its last blocks (dropped, never booked, its rule sold
 * again; a buy that landed marked failed, its coins never sold), however far past the chain is. Without the slots to
 * tell, it is believed well past it (WELL_PAST_BLOCKS), whatever node said it.
 */
export function neverLands(lastValid: number, tip: { height: number; slot?: number }, statusSlot: number | undefined): boolean {
  const last = lastValid + LAST_BLOCK_PAST_VALID;
  if (tip.slot !== undefined && statusSlot !== undefined) return tip.height > last + NOT_FOUND_MARGIN_BLOCKS && statusSlot >= tip.slot - (tip.height - last);
  return tip.height > last + WELL_PAST_BLOCKS;
}
