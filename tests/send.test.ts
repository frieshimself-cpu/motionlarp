// The one place a real transaction leaves the server. Found by review and live runs (27 Nov 2026): the send waited
// for its slowest lane, an unclear answer was taken as "never sent", nothing was ever re-sent, and no lane asked
// Helius to route around sandwiching validators.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../src/config.js';
import { setConnectionForTests } from '../src/chain/connection.js';
import { confirmSignature } from '../src/tx/confirm.js';
import { laneStats, resend, sendTransaction, signatureOf } from '../src/tx/send.js';
import { GLOBAL_SENDER } from '../src/tx/sender-region.js';

const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=9e1b6213-aaaa-bbbb-cccc-1234567890ab';
const TIP = 1_000_000n;

function signedTx(): VersionedTransaction {
  const payer = Keypair.generate();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32).fill(7)), instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

type Lane = (url: string, body: { method: string; params: unknown[] }) => Promise<unknown> | unknown;
let calls: { url: string; body: { method: string; params: [string, Record<string, unknown>] } }[];
const saved = { ...config };
const never = () => new Promise<never>(() => undefined);
const accepted = (sig = 'accepted') => ({ jsonrpc: '2.0', id: 1, result: sig });
const refused = (message: string) => ({ jsonrpc: '2.0', id: 1, error: { code: -32602, message } });

function net(lanes: { rpc: Lane; sender: Lane }) {
  vi.stubGlobal('fetch', async (url: string, init: { body: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const lane = String(url).includes('sender') ? lanes.sender : lanes.rpc;
    const out = await Promise.race([Promise.resolve(lane(String(url), body)), new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout'))))]);
    if (out instanceof Error) throw out;
    if (typeof out === 'number') return { ok: false, status: out, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => out } as unknown as Response;
  });
}

beforeEach(() => {
  calls = [];
  Object.assign(config, { rpcUrl: HELIUS, liveTrading: true, simulateLive: false, senderUrl: 'http://fra-sender.helius-rpc.com/fast', mevProtect: true, sendLaneTimeoutMs: 60 });
  laneStats.reset();
});
afterEach(() => {
  Object.assign(config, saved);
  vi.unstubAllGlobals();
  setConnectionForTests(null);
});

describe('sending a live transaction', () => {
  it('the first lane that takes it is enough: a slow lane never holds the trade up', async () => {
    net({ rpc: never, sender: () => accepted() });
    const tx = signedTx();
    const t0 = Date.now();
    const r = await sendTransaction(tx, true, TIP);
    expect(r).toMatchObject({ ok: true, simulated: false, signature: signatureOf(tx) });
    expect(Date.now() - t0).toBeLessThan(40); // did not wait for the RPC lane's timeout
  });

  it('the signature is the transaction\'s own, whatever a lane answers', async () => {
    net({ rpc: () => accepted('something-else'), sender: never });
    const tx = signedTx();
    expect(await sendTransaction(tx, true, TIP)).toMatchObject({ ok: true, signature: bs58.encode(tx.signatures[0]!) });
  });

  it('every lane refused the transaction itself: it was not sent', async () => {
    net({ rpc: () => refused('invalid transaction: Transaction failed to sanitize accounts offsets correctly'), sender: () => refused('transaction too large: 1300 bytes') });
    const r = await sendTransaction(signedTx(), true, TIP);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringMatching(/too large/) });
  });

  it('no lane answered (timeouts, 503, 429): it may still have gone out, so the chain decides, not a guess', async () => {
    net({ rpc: () => 503, sender: never });
    const tx = signedTx();
    expect(await sendTransaction(tx, true, TIP)).toMatchObject({ ok: true, uncertain: true, signature: signatureOf(tx) });
    net({ rpc: () => refused('Too many requests: rate limit exceeded'), sender: () => new Error('fetch failed') });
    expect(await sendTransaction(signedTx(), true, TIP)).toMatchObject({ ok: true, uncertain: true });
  });

  it('both Helius lanes ask to be routed around sandwiching validators; the key never goes to a non-Helius host', async () => {
    net({ rpc: () => accepted(), sender: () => accepted() });
    await sendTransaction(signedTx(), true, TIP);
    const rpc = calls.find((c) => c.url.includes('mainnet.helius-rpc.com'))!;
    const sender = calls.find((c) => c.url.includes('fra-sender'))!;
    expect(new URL(rpc.url).searchParams.get('mev-protect')).toBe('true');
    expect(new URL(sender.url).searchParams.get('mev-protect')).toBe('true');
    expect(rpc.body).toMatchObject({ method: 'sendTransaction', params: [expect.any(String), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] });
    // switched off: no parameter
    calls = [];
    config.mevProtect = false;
    await sendTransaction(signedTx(), true, TIP);
    expect(calls.every((c) => !c.url.includes('mev-protect'))).toBe(true);
    // another RPC provider: its URL is used as it is
    calls = [];
    Object.assign(config, { mevProtect: true, rpcUrl: 'https://rpc.example.com/abc' });
    await sendTransaction(signedTx(), true, TIP);
    expect(calls.find((c) => c.url.startsWith('https://rpc.example.com'))!.url).toBe('https://rpc.example.com/abc');
  });

  it('a small tip takes the lighter Sender lane; no tip, no Sender', async () => {
    net({ rpc: () => accepted(), sender: () => accepted() });
    await sendTransaction(signedTx(), true, 10_000n);
    expect(new URL(calls.find((c) => c.url.includes('sender'))!.url).searchParams.get('swqos_only')).toBe('true');
    calls = [];
    await sendTransaction(signedTx(), true, 0n);
    expect(calls.some((c) => c.url.includes('sender'))).toBe(false);
  });

  it('re-sending puts the same bytes on every lane again and never throws', async () => {
    net({ rpc: () => new Error('fetch failed'), sender: () => accepted() });
    const tx = signedTx();
    resend(tx, TIP);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.body.params[0])).size).toBe(1);
    expect(calls[0]!.body.params[0]).toBe(Buffer.from(tx.serialize()).toString('base64'));
  });

  it('a Sender region that fails three times in a row is dropped for the global address', async () => {
    net({ rpc: () => accepted(), sender: (url) => (url.includes('fra-sender') ? new Error('fetch failed') : accepted()) });
    for (let i = 0; i < 3; i++) { await sendTransaction(signedTx(), true, TIP); await new Promise((r) => setTimeout(r, 5)); }
    expect(config.senderUrl).toBe(GLOBAL_SENDER);
    calls = [];
    await sendTransaction(signedTx(), true, TIP);
    expect(calls.some((c) => c.url.startsWith(GLOBAL_SENDER))).toBe(true);
    expect(laneStats.text()).toMatch(/sender/);
  });

  it('live trading switched off: nothing is sent, and the result says simulated', async () => {
    config.liveTrading = false;
    net({ rpc: () => accepted(), sender: () => accepted() });
    setConnectionForTests({ simulateTransaction: async () => ({ value: { err: null, logs: [], unitsConsumed: 1 } }) } as unknown as Connection);
    expect(await sendTransaction(signedTx(), true, TIP)).toMatchObject({ ok: true, simulated: true });
    expect(calls).toHaveLength(0);
  });
});

describe('waiting for a transaction to land', () => {
  /** `statusSlot`: the slot of the node that answers the n-th status read (by default as far along as the height's). */
  function chain(statuses: (null | { confirmationStatus?: string; err?: unknown; slot?: number })[], height = 0, statusSlot?: (n: number) => number) {
    let i = 0;
    setConnectionForTests({
      getSignatureStatuses: async () => { const n = i++; return { context: { slot: statusSlot ? statusSlot(n) : 1_000 + height }, value: [statuses[Math.min(n, statuses.length - 1)]] }; },
      getEpochInfo: async () => ({ blockHeight: height, absoluteSlot: 1_000 + height }),
      getBlockHeight: async () => height,
    } as unknown as Connection);
  }

  it('re-sends the same transaction about once a second until it lands (a dropped one is not stuck until it expires)', async () => {
    chain([null, null, null, null, null, null, null, { confirmationStatus: 'confirmed', slot: 9 }]);
    let resent = 0;
    const r = await confirmSignature('sig', 1_000, { resend: () => { resent++; }, pollMs: 6, resendEveryMs: 10 });
    expect(r).toEqual({ landed: true, slot: 9 });
    expect(resent).toBeGreaterThanOrEqual(2); // on its own timer, while nothing is seen
  });

  it('a buy is re-sent only for its first moments: one that missed its chance is left to expire, not pushed for 30 s', async () => {
    chain([null, null, null, null, null, null, null, null, null, null, null, null, { confirmationStatus: 'confirmed', slot: 9 }]);
    const at: number[] = [];
    const t0 = Date.now();
    await confirmSignature('sig', 1_000, { resend: () => { at.push(Date.now() - t0); }, pollMs: 10, resendForMs: 45, resendEveryMs: 20 });
    // About twice (at 20 and 40 ms), never after the 45 ms budget although it took over 100 ms to land. (Timers run
    // late on a busy machine, so the count is not pinned.)
    expect(Date.now() - t0).toBeGreaterThan(100);
    expect(at.length).toBeGreaterThanOrEqual(1);
    expect(at.length).toBeLessThanOrEqual(2);
    expect(Math.max(...at)).toBeLessThan(45 + 25);
  });

  it('stops re-sending once it has landed or failed on chain', async () => {
    chain([null, { err: { InstructionError: [2, 'Custom'] } }]);
    let resent = 0;
    const r = await confirmSignature('sig', 1_000, { resend: () => { resent++; }, pollMs: 2 });
    expect(r).toMatchObject({ landed: false, certain: true });
    expect(resent).toBe(0);
  });

  it('expired without landing is certain: only then may a new transaction be signed', async () => {
    chain([null], 2_000);
    const r = await confirmSignature('sig', 1_000, { pollMs: 1 });
    expect(r).toEqual({ landed: false, reason: 'expired before landing', certain: true });
  });

  it('not expired on the word of a node behind the one that gave the height: one that landed in its last blocks is found on the next look', async () => {
    // the height says it has run out (a few blocks past it, not yet well past); the last look's status comes from a node
    // seven slots behind, which has not seen it yet
    chain([...Array.from({ length: 11 }, () => null), { confirmationStatus: 'confirmed', slot: 9 }], 1_006, (n) => (n <= 10 ? 1_000 + 1_006 - 7 : 1_000 + 1_006));
    expect(await confirmSignature('sig', 1_000, { pollMs: 1 })).toEqual({ landed: true, slot: 9 });
  });

  it('a status seen only at "processed" when it has run out is not taken for landed (a block the chain then dropped): expired once it is gone', async () => {
    chain([...Array.from({ length: 10 }, () => null), { confirmationStatus: 'processed', slot: 5 }, null], 2_000);
    expect(await confirmSignature('sig', 1_000, { pollMs: 1 })).toEqual({ landed: false, reason: 'expired before landing', certain: true });
  });

  it('a status node that is always some slots behind is believed once the chain is well past it (it waited for the 150 s cap)', async () => {
    chain([null], 1_000 + 1 + 31, () => 1_000 + 1_000 + 1 + 31 - 5);
    expect(await confirmSignature('sig', 1_000, { pollMs: 1 })).toEqual({ landed: false, reason: 'expired before landing', certain: true });
  });

  it('not expired at the last block it can still land in: the chain takes a blockhash one block past the height it is said to be valid up to', async () => {
    chain([...Array.from({ length: 11 }, () => null), { confirmationStatus: 'confirmed', slot: 9 }], 1_001);
    expect(await confirmSignature('sig', 1_000, { pollMs: 1 })).toEqual({ landed: true, slot: 9 });
  });
});
