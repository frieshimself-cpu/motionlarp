// Where a coin is traded natively. Found on mainnet (27 Nov 2026): for coins NOT launched on pump.fun (BONK, WIF,
// JUP) someone had created a tiny PumpSwap pool, the site picked it, and a 7 SOL buy there would have received
// 0.04–0.17 % of what the real market gives. Only pump.fun's own curve and the pool a pump.fun coin graduated into
// are traded natively; everything else goes through Jupiter's best route.
import { afterEach, describe, expect, it } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { setConnectionForTests } from '../src/chain/connection.js';
import { PfDispatcher } from '../src/venues/pf.js';
import { pumpSdk } from '../src/venues/sdk.js';
import { VenueError } from '../src/venues/types.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const account = (owner: PublicKey) => ({ owner, data: Buffer.alloc(0), lamports: 1_000_000, executable: false });

function chain(opts: { canonicalPool?: boolean; missingReads?: number }) {
  const calls = { programAccounts: 0, reads: 0, commitments: [] as unknown[] };
  const fake = {
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment?: unknown) => {
      calls.reads++;
      calls.commitments.push(commitment);
      // A coin in the slot it was created in: nothing is there yet for the first reads.
      if (calls.reads <= (opts.missingReads ?? 0)) return keys.map(() => null);
      return [account(TOKEN_PROGRAM_ID), null, opts.canonicalPool ? account(pumpSdk.PUMP_AMM_PROGRAM_ID) : null].slice(0, keys.length);
    },
    // Side pools exist for this coin (anyone can create one): they must not be looked for, let alone used.
    getProgramAccounts: async () => { calls.programAccounts++; return [{ pubkey: PublicKey.unique(), account: account(pumpSdk.PUMP_AMM_PROGRAM_ID) }]; },
  };
  setConnectionForTests(fake as unknown as Connection);
  return calls;
}
afterEach(() => setConnectionForTests(null));

describe('which coins the site trades natively', () => {
  it('a coin that was not launched on pump.fun is never traded in a side PumpSwap pool: it goes to Jupiter', async () => {
    const calls = chain({});
    const err = await new PfDispatcher().resolve(BONK).catch((e) => e);
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).code).toBe('unresolved'); // the executor sends 'unresolved' coins through Jupiter
    expect(calls.programAccounts).toBe(0);
  });

  it('the pool a pump.fun coin graduated into is still traded natively', async () => {
    const calls = chain({ canonicalPool: true });
    const pool = await new PfDispatcher().resolve(BONK);
    expect(pool.kind).toBe('pumpswap');
    expect(pool.pool.equals(pumpSdk.canonicalPumpPoolPda(new PublicKey(BONK)))).toBe(true);
    expect(calls.programAccounts).toBe(0);
  });
});

describe('a coin bought in the slot it was created in (the Scharo wallet does this most of the time)', () => {
  // Review, 27 Nov 2026: the leader's buy is heard at 'processed', the coin was looked up at 'confirmed', where it
  // did not exist yet (6 of 21 on mainnet). It was then taken for "not a pump.fun coin" and sent to Jupiter, which
  // has no route for a coin that young, for a whole hour.
  it('is looked up at the commitment the trade was heard at', async () => {
    const calls = chain({ canonicalPool: true });
    await new PfDispatcher().resolve(BONK);
    expect(calls.commitments).toEqual(['processed']);
  });

  it('not visible on the first reads: it is read again within a fraction of a second and stays on the native route', async () => {
    const calls = chain({ canonicalPool: true, missingReads: 3 });
    const t0 = Date.now();
    const pool = await new PfDispatcher().resolve(BONK);
    expect(pool.kind).toBe('pumpswap');
    expect(calls.reads).toBe(4);
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('a mint that never shows up is "not found", which is not the same as "not a pump.fun coin"', async () => {
    chain({ missingReads: 1000 });
    const err = await new PfDispatcher().resolve(BONK).catch((e) => e);
    expect(err).toBeInstanceOf(VenueError);
    expect((err as VenueError).code).toBe('not_found');
  });
});
