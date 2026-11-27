// A database that cannot be written (a full disk, a failing one): no trade goes out that the server could not write
// down first, a transaction that cannot be committed is undone whole, and the error is said in plain words.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const sent: VersionedTransaction[] = [];
vi.mock('../src/tx/send.js', async (orig) => ({
  ...(await orig<typeof import('../src/tx/send.js')>()),
  canSendLive: () => true,
  sendTransaction: vi.fn(async (tx: VersionedTransaction) => { sent.push(tx); return { ok: true, signature: 'SIG' }; }),
  resend: vi.fn(),
}));
vi.mock('../src/tx/confirm.js', () => ({ confirmSignature: vi.fn(async () => ({ landed: true, slot: 1 })) }));
vi.mock('../src/chain/rpc.js', async (orig) => ({ ...(await orig<typeof import('../src/chain/rpc.js')>()), getTransaction: vi.fn(() => new Promise(() => undefined)) }));

const { ChainExecutor } = await import('../src/engine/executor.js');
const { Store } = await import('../src/store.js');
const { friendlyError } = await import('../src/log.js');
const { setBlockhashesForTests, setConnectionForTests } = await import('../src/chain/connection.js');
const { fastBuysFromLogs } = await import('../src/watch/events.js');
const { pumpSdk } = await import('../src/venues/sdk.js');
type RawTransaction = import('../src/chain/rpc.js').RawTransaction;

const FULL = () => Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
const fx = (name: string) => JSON.parse(readFileSync(`tests/fixtures/tx/${name}.json`, 'utf8')) as RawTransaction;
const account = (name: string) => {
  const a = JSON.parse(readFileSync(`tests/fixtures/accounts/${name}.json`, 'utf8')) as { pubkey: string; owner: string; data: string };
  return { data: Buffer.from(a.data, 'base64'), owner: new PublicKey(a.owner), lamports: 1, executable: false };
};

function executor() {
  // (a connection that never answers: nothing in these tests may need the network)
  setConnectionForTests(new Proxy({}, { get: () => () => new Promise(() => undefined) }) as never);
  setBlockhashesForTests([{ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000, at: Date.now(), firstSeen: Date.now() }]);
  const ex = new ChainExecutor();
  (ex.pf.curve as unknown as { globals: unknown }).globals = { global: pumpSdk.PUMP_SDK.decodeGlobal(account('pump-global') as never), feeConfig: pumpSdk.PUMP_SDK.decodeFeeConfig(account('pump-fee-config') as never), at: Date.now() };
  (ex as unknown as { tokenBalance: () => Promise<bigint> }).tokenBalance = async () => 0n;
  return ex;
}

afterEach(() => {
  sent.length = 0;
  setConnectionForTests(null);
});

describe('a trade the server cannot write down is not sent', () => {
  it('a buy whose signature cannot be written down (it would be lost to a crash, its coins never sold)', async () => {
    const ex = executor();
    const tx = fx('curve_buy');
    const t = fastBuysFromLogs(tx.meta!.logMessages!, tx.transaction.signatures[0]!, '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB', tx.slot, Date.now())![0]!;
    const r = await ex.buy({ wallet: Keypair.generate(), mint: t.mint, lamports: 1_000_000_000n, slippagePct: 25, priorityFeeSol: 0.001, tipSol: 0, live: true, feeBps: 0, curve: t.curve!, onSigned: () => { throw FULL(); } });
    expect(sent).toHaveLength(0);
    expect(r).toEqual({ ok: false, error: 'could not write it down before sending it (database or disk is full): nothing was sent' });
  });

  it('a sell whose row cannot be written down (a sale nobody would book, its rule selling again)', async () => {
    const ex = executor();
    const wallet = Keypair.generate();
    const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 })] }).compileToV0Message();
    const signed = new VersionedTransaction(msg);
    signed.sign([wallet]);
    const sendAndRead = (ex as unknown as { sendAndRead: (...a: unknown[]) => Promise<unknown> }).sendAndRead.bind(ex);
    const req = { wallet, mint: Keypair.generate().publicKey.toBase58(), tokens: 5n, slippagePct: 25, priorityFeeSol: 0.001, tipSol: 0, live: true, feeBps: 0, exit: true, onSigned: () => { throw FULL(); } };
    const r = await sendAndRead(req, signed, 1_000, 'sell', 5n, 1_000n, 5n, 0n, undefined, false);
    expect(sent).toHaveLength(0);
    expect(r).toEqual({ ok: false, error: 'could not write it down before sending it (database or disk is full): nothing was sent, the coins are still in the wallet' });
  });
});

describe('a transaction that cannot be committed', () => {
  it('is undone whole, and the connection takes the next one (it was left inside the failed one)', () => {
    const store = new Store(':memory:');
    const uid = store.createUser('u', 'x');
    const db = store.db as unknown as { exec: (sql: string) => void };
    const exec = db.exec.bind(store.db);
    let failCommit = true;
    db.exec = (sql: string) => { if (sql === 'COMMIT' && failCommit) { failCommit = false; throw FULL(); } return exec(sql); };
    expect(() => store.atomic(() => store.addEvent({ userId: uid, kind: 'info', message: 'half' }))).toThrow(/disk is full/);
    expect(store.events(uid)).toEqual([]); // undone
    store.atomic(() => store.addEvent({ userId: uid, kind: 'info', message: 'next' })); // used to throw: "cannot start a transaction within a transaction"
    expect(store.events(uid).map((e) => e.message)).toEqual(['next']);
    store.addEvent({ userId: uid, kind: 'info', message: 'after' });
    store.close();
  });
});

describe('the database\'s errors in plain words', () => {
  it('a trade not sent says so, and why', () => {
    expect(friendlyError('could not write it down before sending it (database or disk is full): nothing was sent, the coins are still in the wallet'))
      .toBe('could not write it down before sending it (the server cannot save to its database right now, its disk may be full): nothing was sent, the coins are still in the wallet');
  });
  it('any other write that failed', () => {
    for (const raw of ['database or disk is full', 'disk I/O error', 'attempt to write a readonly database']) {
      expect(friendlyError(raw)).toBe('the server cannot save to its database right now, its disk may be full');
    }
  });
});

describe('a status seen only at "processed"', () => {
  it('is not evidence that a sell never landed: asked again, never "not found" (which the drop rule takes once the chain is well past it; tests/settle-status.test.ts)', async () => {
    setConnectionForTests({ getSignatureStatuses: async () => ({ context: { slot: 500 }, value: [{ confirmationStatus: 'processed', err: null, slot: 499, confirmations: 0 }] }) } as never);
    const ex = new ChainExecutor();
    await expect(ex.settleSell('SIG', Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58())).rejects.toThrow(/not confirmed yet/);
  });
  it('a status not there at all is "not found" with the slot of the node that said so', async () => {
    setConnectionForTests({ getSignatureStatuses: async () => ({ context: { slot: 500 }, value: [null] }) } as never);
    const ex = new ChainExecutor();
    expect(await ex.settleSell('SIG', Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58())).toEqual({ state: 'not_found', slot: 500 });
  });
});
