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
