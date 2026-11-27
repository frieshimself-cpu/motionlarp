// What a trade's own status says about it (27 Nov 2026, the third round of reviewers): a status seen only at
// "processed" is in a block that is not confirmed yet. It is neither "not found" (the engine then drops a sell left by
// a crash, once the chain is well past it, and its rule sells a second time) nor, with an error, "failed" (the block may
// be dropped and the same transaction land in another). The caller asks again; only a confirmed status is final.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/chain/rpc.js', async (orig) => ({ ...(await orig<typeof import('../src/chain/rpc.js')>()), getTransaction: vi.fn(async () => null) }));

const { setConnectionForTests } = await import('../src/chain/connection.js');
const { ChainExecutor } = await import('../src/engine/executor.js');

const OWNER = '11111111111111111111111111111111';
const MINT = 'So11111111111111111111111111111111111111112';

function answers(status: Record<string, unknown> | null, contextSlot = 2_000) {
  setConnectionForTests({ getSignatureStatuses: async () => ({ context: { slot: contextSlot }, value: [status] }) } as never);
}

afterEach(() => setConnectionForTests(null));

describe("a trade's own status", () => {
  it('seen only at "processed" is not "not found": asked again (a sell left by a crash was dropped and sold twice)', async () => {
    answers({ slot: 1_999, confirmations: 0, err: null, status: { Ok: null }, confirmationStatus: 'processed' });
    await expect(new ChainExecutor().settleSell('SIG', OWNER, MINT)).rejects.toThrow(/not confirmed yet/);
    await expect(new ChainExecutor().settleBuy('SIG', OWNER, MINT)).rejects.toThrow(/not confirmed yet/);
  });

  it('an error seen only at "processed" is not final either (its block may be dropped and the trade land elsewhere)', async () => {
    answers({ slot: 1_999, confirmations: 0, err: { InstructionError: [2, { Custom: 6003 }] }, status: { Err: {} }, confirmationStatus: 'processed' });
    await expect(new ChainExecutor().settleSell('SIG', OWNER, MINT)).rejects.toThrow(/not confirmed yet/);
  });

  it('an error once confirmed is final', async () => {
    answers({ slot: 1_999, confirmations: 3, err: { InstructionError: [2, { Custom: 6003 }] }, status: { Err: {} }, confirmationStatus: 'confirmed' });
    expect(await new ChainExecutor().settleSell('SIG', OWNER, MINT)).toEqual({ state: 'failed' });
  });

  it('no status at all is "not found", with how far along the node that answered was', async () => {
    answers(null, 2_345);
    expect(await new ChainExecutor().settleSell('SIG', OWNER, MINT)).toEqual({ state: 'not_found', slot: 2_345 });
  });

  it('confirmed, but its transaction cannot be read yet: asked again, never "not found"', async () => {
    answers({ slot: 1_999, confirmations: 3, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' });
    await expect(new ChainExecutor().settleSell('SIG', OWNER, MINT)).rejects.toThrow(/cannot be read yet/);
  });
});
