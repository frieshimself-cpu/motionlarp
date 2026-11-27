import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { Jupiter, appendInstruction } from '../src/venues/jupiter.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'FXVj1cT44nNDZiHQfQTBpsmp7TM1fgQxzLm71CGysnow';

describe('Jupiter client', () => {
  it('asks for a quote with the amount, slippage and an account cap', async () => {
    const calls: string[] = [];
    const j = new Jupiter('https://jup.test', '', async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ inAmount: '10', outAmount: '99', otherAmountThreshold: '90', routePlan: [] })); });
    const q = await j.quote(SOL, MINT, 10_000_000n, 2500, 40);
    expect(q.outAmount).toBe('99');
    const u = new URL(calls[0]!);
    expect(u.origin + u.pathname).toBe('https://jup.test/swap/v1/quote');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ inputMint: SOL, outputMint: MINT, amount: '10000000', slippageBps: '2500', maxAccounts: '40' });
  });

  it('sends the API key when one is set, and reports a route error readably', async () => {
    let headers: Headers | null = null;
    const j = new Jupiter('https://jup.test', 'k123', async (_url, init) => { headers = new Headers(init?.headers); return new Response(JSON.stringify({ error: 'No routes found' }), { status: 400 }); }, 1);
    await expect(j.quote(SOL, MINT, 1n, 100)).rejects.toThrow(/No routes found/);
    expect(headers!.get('x-api-key')).toBe('k123');
  });

  it('a brand-new coin Jupiter has not picked up yet: "no route" is retried for a few seconds', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', async () => (++n < 3 ? new Response(JSON.stringify({ error: 'No routes found', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }), { status: 400 }) : new Response(JSON.stringify({ inAmount: '1', outAmount: '5', otherAmountThreshold: '4', routePlan: [] }))), 1);
    expect((await j.quote(SOL, MINT, 1n, 100)).outAmount).toBe('5');
    expect(n).toBe(3);
  });

  it('price checks do not retry (they must not hold up the sell clock)', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', async () => { n++; return new Response(JSON.stringify({ error: 'No routes found' }), { status: 400 }); }, 1);
    await expect(j.quote(SOL, MINT, 1n, 100, 48, false)).rejects.toThrow(/No routes/);
    expect(n).toBe(1);
  });

  it('gives up after the retries with the route error', async () => {
    const j = new Jupiter('https://jup.test', '', async () => new Response(JSON.stringify({ error: 'No routes found' }), { status: 400 }), 1);
    await expect(j.quote(SOL, MINT, 1n, 100)).rejects.toThrow(/No routes found/);
  });

  it('builds the swap with the user, SOL wrapping and the priority fee', async () => {
    let body: Record<string, unknown> = {};
    const user = Keypair.generate();
    const msg = new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: user.publicKey, lamports: 1 })] }).compileToV0Message();
    const b64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
    const j = new Jupiter('https://jup.test', '', async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ swapTransaction: b64, lastValidBlockHeight: 123 })); });
    const r = await j.swap({ outAmount: '1' } as never, user.publicKey, 500_000n);
    expect(body).toMatchObject({ userPublicKey: user.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 500000 });
    expect(r.lastValidBlockHeight).toBe(123);
    expect(r.tx.message.staticAccountKeys[0]!.equals(user.publicKey)).toBe(true);
  });
});

describe('appendInstruction (our fee inside Jupiter\'s transaction)', () => {
  it('adds the transfer after the route, keeps the blockhash and payer', async () => {
    const user = Keypair.generate();
    const feeTo = Keypair.generate().publicKey;
    const route = SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: new PublicKey(MINT), lamports: 5 });
    const msg = new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [route] }).compileToV0Message();
    const fee = SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: feeTo, lamports: 777 });
    const out = await appendInstruction(new VersionedTransaction(msg), fee, async () => []);
    const back = TransactionMessage.decompile(out.message);
    expect(back.instructions).toHaveLength(2);
    expect(back.instructions[1]!.keys[1]!.pubkey.equals(feeTo)).toBe(true);
    expect(back.recentBlockhash).toBe('11111111111111111111111111111111');
    expect(back.payerKey.equals(user.publicKey)).toBe(true);
  });
});

describe('appendInstruction: the whole transaction must fit in one packet', () => {
  // Review, 27 Nov 2026: only the MESSAGE was checked against 1232 bytes; with the signature on top a transaction
  // of up to 1297 bytes passed here, was refused by the network, and the smaller route was never tried.
  it('refuses a transaction that only fits without its signature, so a smaller route is tried', async () => {
    const payer = Keypair.generate().publicKey;
    const transfer = () => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const build = (n: number) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: Array.from({ length: n }, transfer) }).compileToV0Message());
    // The largest transaction that still fits: one more transfer puts it between 1233 and 1297 bytes.
    let n = 1;
    while (build(n + 1).serialize().length <= 1232) n++;
    const full = build(n);
    expect(full.serialize().length).toBeLessThanOrEqual(1232);
    expect(full.message.serialize().length + 44).toBeLessThanOrEqual(1232); // the message alone would still pass
    await expect(appendInstruction(full, transfer(), async () => [])).rejects.toThrow(/too large/);
    // one with room left is fine
    await expect(appendInstruction(build(3), transfer(), async () => [])).resolves.toBeInstanceOf(VersionedTransaction);
  });
});

describe('Jupiter is busy (429 / 5xx)', () => {
  // The sweep of 27 Nov hit Jupiter's rate limit; in production one such answer would have lost a copy outright.
  const ok = () => new Response(JSON.stringify({ inAmount: '1', outAmount: '7', otherAmountThreshold: '6', routePlan: [] }), { status: 200 });
  it('a rate-limit or server error is retried quickly, then the answer is used', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', async () => (++n < 3 ? new Response('{}', { status: n === 1 ? 429 : 503 }) : ok()), 1, 1);
    expect((await j.quote(SOL, MINT, 1n, 100)).outAmount).toBe('7');
    expect(n).toBe(3);
  });

  it('gives up after a few tries and says why', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', async () => { n++; return new Response('{}', { status: 429 }); }, 1, 1);
    await expect(j.quote(SOL, MINT, 1n, 100)).rejects.toThrow(/HTTP 429/);
    expect(n).toBe(4);
  });

  it('a real refusal (400) is not retried as "busy"', async () => {
    let n = 0;
    const j = new Jupiter('https://jup.test', '', async () => { n++; return new Response(JSON.stringify({ error: 'Invalid slippage' }), { status: 400 }); }, 1, 1);
    await expect(j.quote(SOL, MINT, 1n, 100)).rejects.toThrow(/Invalid slippage/);
    expect(n).toBe(1);
  });
});
