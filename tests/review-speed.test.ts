// The copy goes out the moment the copied wallet's trade is heard (27 Nov 2026): a pump.fun curve buy is built from
// pump.fun's own event of their buy, with no read of the network in front of ours; the wallet's SOL is read in the
// background, never in front of a buy; the feed says how long after their trade ours was sent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, type Connection, type VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const sent: { at: number; tx: VersionedTransaction; reads: string[]; balancePending: boolean }[] = [];
const net = { reads: [] as string[], balancePending: false };
vi.mock('../src/tx/send.js', async (orig) => ({
  ...(await orig<typeof import('../src/tx/send.js')>()),
  canSendLive: () => true,
  sendTransaction: vi.fn(async (tx: VersionedTransaction) => { sent.push({ at: Date.now(), tx, reads: [...net.reads], balancePending: net.balancePending }); return { ok: true, signature: 'SIG' }; }),
  resend: vi.fn(),
}));
vi.mock('../src/tx/confirm.js', () => ({ confirmSignature: vi.fn(async () => ({ landed: true, slot: 1 })) }));
vi.mock('../src/chain/rpc.js', async (orig) => ({ ...(await orig<typeof import('../src/chain/rpc.js')>()), getTransaction: vi.fn(() => new Promise(() => undefined)) }));

const { ChainExecutor } = await import('../src/engine/executor.js');
const { Engine } = await import('../src/engine/engine.js');
const { Store } = await import('../src/store.js');
const { validateSettings } = await import('../src/engine/settings.js');
const { setBlockhashesForTests, setConnectionForTests } = await import('../src/chain/connection.js');
const { fastBuysFromLogs } = await import('../src/watch/events.js');
const { pumpSdk } = await import('../src/venues/sdk.js');
type LeaderTrade = import('../src/watch/parse.js').LeaderTrade;
type RawTransaction = import('../src/chain/rpc.js').RawTransaction;

const fx = (name: string) => JSON.parse(readFileSync(`tests/fixtures/tx/${name}.json`, 'utf8')) as RawTransaction;
const account = (name: string) => {
  const a = JSON.parse(readFileSync(`tests/fixtures/accounts/${name}.json`, 'utf8')) as { pubkey: string; owner: string; data: string };
  return { data: Buffer.from(a.data, 'base64'), owner: new PublicKey(a.owner), lamports: 1, executable: false };
};
// pump.fun's fee tables as they stood on mainnet (27 Nov 2026), so the offline build prices like the real one.
const GLOBAL = pumpSdk.PUMP_SDK.decodeGlobal(account('pump-global') as never);
const FEE_CONFIG = pumpSdk.PUMP_SDK.decodeFeeConfig(account('pump-fee-config') as never);
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const SOL = 1_000_000_000n;

/** A connection that answers nothing and writes down every call (any read in front of the buy shows up here). */
function recordingConnection(): Connection {
  return new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => { net.reads.push(String(prop)); void args; return new Promise(() => undefined); } }) as unknown as Connection;
}

function executor() {
  setConnectionForTests(recordingConnection());
  setBlockhashesForTests([{ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000, at: Date.now(), firstSeen: Date.now() }]);
  const ex = new ChainExecutor();
  (ex.pf.curve as unknown as { globals: unknown }).globals = { global: GLOBAL, feeConfig: FEE_CONFIG, at: Date.now() };
  // The coin balance before the buy: answered only after our buy went out.
  let answer: (v: bigint) => void = () => undefined;
  let reads = 0;
  (ex as unknown as { tokenBalance: () => Promise<bigint> }).tokenBalance = () => {
    reads++;
    if (reads === 1) { net.balancePending = true; return new Promise<bigint>((r) => { answer = (v) => { net.balancePending = false; r(v); }; }); }
    return Promise.resolve(5_000_000n);
  };
  return { ex, answerBalance: (v: bigint) => answer(v) };
}

// The wallet that bought in each real transaction.
const BUYER: Record<string, string> = { curve_buy: '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB' };
const leaderBuy = (name: string) => {
  const tx = fx(name);
  return fastBuysFromLogs(tx.meta!.logMessages!, tx.transaction.signatures[0]!, BUYER[name]!, tx.slot, Date.now())![0]!;
};

afterEach(() => {
  sent.length = 0;
  net.reads.length = 0;
  net.balancePending = false;
  setConnectionForTests(null);
  vi.restoreAllMocks();
});

describe("pump.fun's event of the copied wallet's buy", () => {
  it('carries the curve right after their buy and the coin\'s own token program (real mainnet buys, Token-2022 coins)', () => {
    for (const name of ['curve_buy']) {
      const t = leaderBuy(name);
      const tx = fx(name);
      // the coin's token program, as the transaction's own token balances name it
      const program = (tx.meta!.postTokenBalances!.find((b) => b.mint === t.mint) as { programId?: string } | undefined)?.programId;
      expect(t.curve?.tokenProgram).toBe(program);
      expect(t.curve!.realTokenReserves).toBeGreaterThan(0n);
      expect(t.curve!.virtualQuoteReserves).toBeGreaterThan(t.curve!.realQuoteReserves);
      expect(t.heardAt).toBeGreaterThan(0);
    }
  });

  it('the token program of the coin, not of another transfer in the same transaction (this one also moves USDC and wrapped SOL with the classic program)', () => {
    const t = leaderBuy('curve_buy');
    const others = fx('curve_buy').meta!.postTokenBalances!.filter((b) => b.mint !== t.mint).map((b) => (b as { programId?: string }).programId);
    expect(others).toContain(TOKEN_PROGRAM_ID.toBase58());
    expect(t.curve!.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it('a classic SPL coin: the classic token program (the same buy, its coin moved by the classic program)', () => {
    const tx = fx('curve_buy');
    const logs = tx.meta!.logMessages!.map((l) => l.replaceAll(TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58()));
    const [t] = fastBuysFromLogs(logs, 'sig', BUYER.curve_buy!, 5)!;
    expect(t!.curve!.tokenProgram).toBe(TOKEN_PROGRAM_ID.toBase58());
  });

  it('no token program is taken that pump.fun did not call itself (then the coin is looked up as before)', () => {
    const tx = fx('curve_buy');
    // pump.fun's own transfer of the coin removed: only other programs move tokens in this transaction
    const logs = tx.meta!.logMessages!.filter((l) => !l.includes(TOKEN_2022_PROGRAM_ID.toBase58()) && l !== 'Program log: Instruction: TransferChecked');
    const [t] = fastBuysFromLogs(logs, 'sig', BUYER.curve_buy!, 5)!;
    expect(t!.curve!.tokenProgram).toBeUndefined();
  });
});

describe('the copy buy of a pump.fun curve buy', () => {
  it('is signed and sent with no read of the network in front of it (the curve from their event, the fee tables and the blockhash from memory)', async () => {
    const { ex, answerBalance } = executor();
    const t = leaderBuy('curve_buy');
    const resolve = vi.spyOn(ex.pf, 'resolve');
    const wallet = Keypair.generate();
    const r = ex.buy({ wallet, mint: t.mint, lamports: SOL, slippagePct: 100, priorityFeeSol: 0.001, tipSol: 0, live: true, feeBps: 0, curve: t.curve!, heardAt: t.heardAt! });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.reads).toEqual([]); // nothing read before it went out
    expect(sent[0]!.balancePending).toBe(true); // the coin balance was asked for, not waited for
    expect(resolve).not.toHaveBeenCalled();
    answerBalance(0n);
    expect(await r).toMatchObject({ ok: true, signature: 'SIG', tokens: 5_000_000n });
    // the buy itself: pump.fun's exact-spend buy into the wallet's Token-2022 account of that coin
    const keys = sent[0]!.tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys).toContain(PUMP.toBase58());
    expect(keys).toContain(getAssociatedTokenAddressSync(new PublicKey(t.mint), wallet.publicKey, true, TOKEN_2022_PROGRAM_ID).toBase58());
    expect(keys).toContain(pumpSdk.bondingCurvePda(new PublicKey(t.mint)).toBase58());
  });

  it('its least coins out is priced from the curve in their event (at 25 % slippage: 75 % of the quote)', async () => {
    const { ex } = executor();
    const t = leaderBuy('curve_buy');
    const built = await ex.pf.curve.buildBuy({ pool: { kind: 'pumpfun_curve', pool: pumpSdk.bondingCurvePda(new PublicKey(t.mint)), mint: new PublicKey(t.mint), tokenProgram: TOKEN_2022_PROGRAM_ID }, user: Keypair.generate().publicKey, lamportsIn: SOL, slippagePct: 25, curve: t.curve! });
    expect(net.reads).toEqual([]);
    // what 1 SOL buys on that curve, less pump.fun's fee: about vT × spend / (vQ + spend)
    const c = t.curve!;
    const plain = (c.virtualTokenReserves * SOL) / (c.virtualQuoteReserves + SOL);
    expect(built.expectedOut).toBeLessThan(plain);
    expect(built.expectedOut).toBeGreaterThan((plain * 97n) / 100n);
    expect(built.minOut).toBe(built.expectedOut - (built.expectedOut * 250n) / 1000n);
  });

  it.each([
    ['the token program is not known', { tokenProgram: undefined }],
    ['a cashback coin (bought through Jupiter)', { cashback: true }],
    ['their buy finished the curve', { realTokenReserves: 0n }],
  ])('takes the usual route when %s', async (_why, change) => {
    const { ex } = executor();
    const t = leaderBuy('curve_buy');
    const curve = { ...t.curve!, ...change };
    const resolve = vi.spyOn(ex.pf, 'resolve').mockRejectedValue(new Error('looked up'));
    const r = await ex.buy({ wallet: Keypair.generate(), mint: t.mint, lamports: SOL, slippagePct: 100, priorityFeeSol: 0.001, tipSol: 0, live: true, feeBps: 0, curve });
    expect(resolve).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(r.ok).toBe(false);
  });
});

describe('the engine in front of the copy buy', () => {
  const LEADER = 'wtb3G6oVvAznK5HtFpyHTWL6aNYyxm6avutyMn8ksih';
  function setup(walletSol: bigint, buySol = 1) {
    const store = new Store(':memory:');
    const uid = store.createUser('u', 'x');
    const wallet = Keypair.generate();
    store.setWallet(uid, wallet.publicKey.toBase58(), 'enc');
    store.createCopy(uid, validateSettings({ leader: LEADER, buySol, minLeaderBuySol: 0, slippagePct: 100, priorityFeeSol: 0.001, tipSol: 0.005, sell: { mirror: { enabled: true, mode: 'exit' }, timed: [], stopLoss: [], deadCoin: { enabled: false, idleSec: 120 } } }));
    const requests: Record<string, unknown>[] = [];
    let hold: Promise<void> | null = null;
    const balance = { reads: 0, slow: false, sol: walletSol };
    let warmed = 0;
    const executor = {
      buy: async (r: { lamports: bigint; onSigned?: (s: string) => void } & Record<string, unknown>) => {
        requests.push(r);
        r.onSigned?.('BUYSIG');
        if (hold) await hold;
        return { ok: true as const, signature: 'BUYSIG', tokens: 1_000_000n, lamports: r.lamports, simulated: false };
      },
      sell: async () => ({ ok: false as const, error: 'no' }),
      quoteSell: async () => SOL,
      warm: async () => { warmed++; },
      solBalance: async () => { balance.reads++; if (balance.slow) await new Promise((r) => setTimeout(r, 1_000)); return balance.sol; },
      tokenBalance: async () => 0n,
      isLive: () => true,
    };
    const engine = new Engine({ store, executor, walletFor: () => wallet, priceMs: 2_000, maxSolPerBuy: 30, feeReserveSol: 0.01 });
    const trade = (mint: string, over: Partial<LeaderTrade> = {}): LeaderTrade => ({ signature: `s${Math.random()}`, leader: LEADER, mint, side: 'buy', solLamports: 2n * SOL, tokenAmount: 1n, tokensBefore: 0n, tokensAfter: 1n, venue: 'pumpfun', slot: 1, blockTime: null, ...over });
    const feed = () => store.events(uid, 50).map((e) => e.message);
    return { store, uid, engine, requests, balance, warmed: () => warmed, trade, feed, holdBuys: (p: Promise<void> | null) => { hold = p; } };
  }
  const MINT_A = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';
  const MINT_B = 'yLHhKLmQUP7AfR3P3mWfiPj3hGm9orr4dVZtFyopump';

  it('with the curve in their event, the coin is not looked up, and the buy carries the curve and when their trade was heard', async () => {
    const s = setup(10n * SOL);
    const t = leaderBuy('curve_buy');
    await s.engine.onLeaderTrade({ ...t, leader: LEADER, heardAt: Date.now() - 3 });
    await s.engine.idle();
    expect(s.warmed()).toBe(0);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.curve).toEqual(t.curve);
    expect(s.requests[0]!.heardAt).toBeGreaterThan(0);
    expect(s.feed().find((m) => m.startsWith('Bought'))).toMatch(/· sent \d+ ms after their trade was seen/);
  });

  it('without it (any other venue), the coin is looked up while the balance is checked, as before', async () => {
    const s = setup(10n * SOL);
    await s.engine.onLeaderTrade(s.trade(MINT_A));
    await s.engine.idle();
    expect(s.warmed()).toBe(1);
    expect(s.requests).toHaveLength(1);
  });

  it('two buys at once never count the same SOL: the second is skipped when the wallet holds enough for one', async () => {
    const s = setup(1_200_000_000n); // 1.2 SOL; each buy needs 1 SOL + the fees to get in and out
    let release: () => void = () => undefined;
    s.holdBuys(new Promise((r) => { release = r; }));
    await s.engine.onLeaderTrade(s.trade(MINT_A));
    await s.engine.onLeaderTrade(s.trade(MINT_B));
    await vi.waitFor(() => expect(s.feed().some((m) => m.startsWith('Skipped'))).toBe(true));
    release();
    await s.engine.idle();
    expect(s.requests).toHaveLength(1);
    expect(s.feed().find((m) => m.startsWith('Skipped'))).toMatch(/going into other buys right now/);
  });

  it('a buy right after another one does not wait for the wallet to be read again (that read runs in the background)', async () => {
    const s = setup(10n * SOL);
    await s.engine.onLeaderTrade(s.trade(MINT_A));
    await s.engine.idle();
    s.balance.slow = true; // from now on a read takes a second
    const t0 = Date.now();
    await s.engine.onLeaderTrade(s.trade(MINT_B));
    await vi.waitFor(() => expect(s.requests).toHaveLength(2), { timeout: 900 });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('the balance of every wallet that may buy is renewed in the background (one read per wallet)', async () => {
    const s = setup(10n * SOL);
    const before = s.balance.reads;
    await s.engine.keepBalancesFresh();
    expect(s.balance.reads - before).toBe(1);
    s.balance.sol = 3n * SOL;
    await s.engine.keepBalancesFresh();
    // the buy then uses that renewed balance, with no read of its own
    const reads = s.balance.reads;
    await s.engine.onLeaderTrade(s.trade(MINT_A));
    await s.engine.idle();
    expect(s.balance.reads - reads).toBe(1); // only the re-read after the buy, in the background
    expect(s.requests).toHaveLength(1);
  });
});
