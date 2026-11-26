// End-to-end check against the real chain, sending nothing:
//   1. find recent real pump.fun-curve and PumpSwap buys by a wallet,
//   2. parse them with the same code that watches leaders,
//   3. build OUR buy and sell for that wallet (it holds SOL and the coin) with the same code that trades,
//   4. simulate both on mainnet (signature check off, since we do not hold that wallet's key).
// Usage: RPC_URL=<your rpc> npm run check:mainnet     (defaults to the public RPC, which is slow but works)
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
const { getConnection } = await import('../src/chain/connection.js');
const { getSignaturesForAddress, getTransaction } = await import('../src/chain/rpc.js');
const { accountKeys, parseLeaderTrades, PUMP_AMM_PROGRAM, PUMP_PROGRAM } = await import('../src/watch/parse.js');
const { PfDispatcher } = await import('../src/venues/pf.js');
const { withFee } = await import('../src/fee.js');
// A 1 % platform fee rides in every simulated trade, as it would live. It goes to a wallet that already holds SOL
// (pump.fun's fee recipient): a small transfer into an EMPTY account fails (below the rent minimum), which is why
// the server checks at startup that FEE_WALLET holds at least 0.001 SOL.
const FEE_TO = '463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq';

const pf = new PfDispatcher();
const conn = getConnection();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

async function simulateAs(user: InstanceType<typeof PublicKey>, ixs: import('@solana/web3.js').TransactionInstruction[]) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs] }).compileToV0Message();
  const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  return sim.value;
}

async function findBuy(program: string, wantVenue: 'pumpfun' | 'pumpswap') {
  const sigs = await getSignaturesForAddress(program, { limit: 100 });
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await getTransaction(s.signature);
    await sleep(700);
    if (!tx) continue;
    const payer = accountKeys(tx)[0]!;
    const t = parseLeaderTrades(tx, payer).find((x) => x.side === 'buy' && x.venue === wantVenue && x.solLamports > 1_000_000n);
    if (!t) continue;
    try {
      await pf.resolve(t.mint);
      return t;
    } catch (err) {
      console.log(`(skipping ${t.mint.slice(0, 6)}…: ${err instanceof Error ? err.message : err})`);
    }
  }
  return null;
}

for (const [program, venue] of [[PUMP_PROGRAM, 'pumpfun'], [PUMP_AMM_PROGRAM, 'pumpswap']] as const) {
  console.log(`\n=== ${venue} ===`);
  const t = await findBuy(program, venue);
  if (!t) { failures++; console.log('no recent wallet buy found (RPC busy?) — run again'); continue; }
  console.log(`leader trade parsed: ${t.leader.slice(0, 6)}… bought ${t.mint} for ${Number(t.solLamports) / 1e9} SOL (${t.signature.slice(0, 12)}…)`);
  const user = new PublicKey(t.leader);
  try {
    const pool = await pf.resolve(t.mint);
    const v = pf.venueFor(pool);
    console.log(`resolved: ${pool.kind}, pool ${pool.pool.toBase58().slice(0, 8)}…`);
    // 0.01 SOL, or less when the borrowed wallet holds less (it pays for the simulated buy).
    const balance = BigInt(await conn.getBalance(user, 'confirmed'));
    const lamports = balance / 4n < 10_000_000n ? balance / 4n : 10_000_000n;
    const quote = await v.quoteBuy(pool, lamports);
    const buy = await v.buildBuy({ pool, user, lamportsIn: lamports, slippagePct: 25 });
    const buyFee = withFee(buy.instructions, user, lamports, 100, FEE_TO);
    const simBuy = await simulateAs(user, buyFee.instructions);
    console.log(`our ${Number(lamports) / 1e9} SOL buy + ${Number(buyFee.fee) / 1e9} SOL fee: quote ${quote} tokens; simulation ${simBuy.err ? 'FAILED ' + JSON.stringify(simBuy.err) : `ok (${simBuy.unitsConsumed} CU)`}`);
    if (simBuy.err) { failures++; console.log((simBuy.logs ?? []).slice(-8).join('\n')); }

    // The sell draws from the wallet's standard (associated) token account, where our own copies always hold.
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    const ata = getAssociatedTokenAddressSync(pool.mint, user, true, pool.tokenProgram);
    const held = await conn.getTokenAccountBalance(ata, 'confirmed').then((b) => BigInt(b.value.amount)).catch(() => 0n);
    if (held > 0n) {
      const tokens = held / 2n;
      const sell = await v.buildSell({ pool, user, tokensIn: tokens, slippagePct: 25 });
      const sellFee = withFee(sell.instructions, user, sell.expectedOut, 100, FEE_TO);
      const simSell = await simulateAs(user, sellFee.instructions);
      console.log(`our sell of 50% of their ${held} tokens + ${Number(sellFee.fee) / 1e9} SOL fee: quote ${sell.expectedOut} lamports; simulation ${simSell.err ? 'FAILED ' + JSON.stringify(simSell.err) : `ok (${simSell.unitsConsumed} CU)`}`);
      if (simSell.err) { failures++; console.log((simSell.logs ?? []).slice(-8).join('\n')); }
    } else {
      console.log('wallet holds none in its standard token account (sold out, or keeps coins elsewhere): sell not simulated');
    }
  } catch (err) {
    failures++;
    console.log('ERROR', err instanceof Error ? err.message : err);
  }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
