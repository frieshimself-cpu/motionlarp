// From the review of running the site unattended (27 Nov 2026): a landed buy held 'opening' by a slow read (its timed
// exit waited), and every open position priced every 2 s although no rule needed a price.
import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';

vi.mock('../src/tx/send.js', async (orig) => ({ ...(await orig<typeof import('../src/tx/send.js')>()), sendTransaction: vi.fn(async () => ({ ok: true, signature: 'SIG' })), resend: vi.fn(), signatureOf: () => 'SIG' }));
vi.mock('../src/tx/confirm.js', () => ({ confirmSignature: vi.fn(async () => ({ landed: true, slot: 1 })) }));
vi.mock('../src/chain/rpc.js', async (orig) => ({ ...(await orig<typeof import('../src/chain/rpc.js')>()), getTransaction: vi.fn(() => new Promise(() => undefined)) }));

const { ChainExecutor } = await import('../src/engine/executor.js');
const { Engine } = await import('../src/engine/engine.js');
const { Store } = await import('../src/store.js');
const { validateSettings } = await import('../src/engine/settings.js');

describe('a real buy that has landed', () => {
  it('is handed back within about a second even when the wallet read and the transaction read hang (its exit clock is running)', async () => {
    const ex = new ChainExecutor();
    (ex as unknown as { tokenBalance: () => Promise<bigint> }).tokenBalance = () => new Promise(() => undefined);
    const sendAndRead = (ex as unknown as { sendAndRead: (...a: unknown[]) => Promise<{ ok: boolean; tokens?: bigint; lamports?: bigint; refine?: unknown }> }).sendAndRead.bind(ex);
    const req = { wallet: Keypair.generate(), mint: Keypair.generate().publicKey.toBase58(), slippagePct: 25, priorityFeeSol: 0.001, tipSol: 0, live: true, feeBps: 0 };
    const t0 = Date.now();
    const r = await sendAndRead(req, {}, 100, 'buy', 5_000n, 7_000_000_000n, 0n, 0n);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r).toMatchObject({ ok: true, tokens: 5_000n, lamports: 7_000_000_000n }); // the quote, until the exact read
    expect(r.refine).toBeDefined();
  });
});

describe('price checks', () => {
  const SOL = 1_000_000_000n;
  function setup(sell: Record<string, unknown>) {
    const store = new Store(':memory:');
    const uid = store.createUser('u', 'x');
    const wallet = Keypair.generate();
    store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
    store.createCopy(uid, validateSettings({ leader: 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih', buySol: 1, minLeaderBuySol: 0, sell }));
    let clock = 1_000_000;
    let quotes = 0;
    const executor = {
      buy: async (r: { lamports: bigint }) => ({ ok: true as const, signature: 'B', tokens: 1_000_000n, lamports: r.lamports, simulated: true }),
      sell: async () => ({ ok: false as const, error: 'no' }),
      quoteSell: async () => { quotes++; return SOL; },
      solBalance: async () => 100n * SOL, tokenBalance: async () => 0n, isLive: () => false,
    };
    const engine = new Engine({ store, executor, walletFor: () => wallet, now: () => clock, priceMs: 2_000, maxSolPerBuy: 10, feeReserveSol: 0.01 });
    return { engine, advance: async (ms: number) => { clock += ms; await engine.tick(); await engine.idle(); }, quotes: () => quotes, buy: () => engine.onLeaderTrade({ signature: `s${Math.random()}`, leader: 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih', mint: 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump', side: 'buy', solLamports: 2n * SOL, tokenAmount: 1n, tokensBefore: 0n, tokensAfter: 1n, venue: 'pumpfun', slot: 1, blockTime: null }) };
  }

  it('a position with no stop loss and no dead-coin rule is priced every 30 s (only the value shown needs it), not every 2 s', async () => {
    const s = setup({ mirror: { enabled: true, mode: 'exit' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } });
    await s.buy(); await s.engine.idle();
    for (let i = 0; i < 15; i++) await s.advance(2_000); // 30 s
    expect(s.quotes()).toBeLessThanOrEqual(2);
  });

  it('a stop loss or dead-coin rule is still checked every 2 s', async () => {
    const s = setup({ mirror: { enabled: false, mode: 'same' }, timed: [], stopLoss: [{ lossPct: 50, percent: 100 }], deadCoin: { enabled: false, idleSec: 120 } });
    await s.buy(); await s.engine.idle();
    for (let i = 0; i < 15; i++) await s.advance(2_000);
    expect(s.quotes()).toBeGreaterThanOrEqual(14);
  });
});
