// Check (reads only): for coins that were NOT launched on pump.fun, compare what a buy gets in the PumpSwap pool the
// site would pick natively with what Jupiter's best route gets, at a small size and at 7 SOL.
// Usage: tsx scripts/check-side-pool.ts [mint ...]
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { Jupiter } = await import('../src/venues/jupiter.js');
const { PfDispatcher } = await import('../src/venues/pf.js');
const { WSOL_MINT } = await import('../src/watch/parse.js');

const jup = new Jupiter('https://lite-api.jup.ag', '');
const pf = new PfDispatcher();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MINTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
];

for (const mint of MINTS) {
  console.log(`\n${mint}`);
  let pool;
  try {
    pool = await pf.resolve(mint);
  } catch (e) {
    console.log(`  site: not native (${e instanceof Error ? e.message : e}) → Jupiter. Nothing to compare.`);
    continue;
  }
  console.log(`  site: native ${pool.kind}, pool ${pool.pool.toBase58()}${pool.migratedFrom ? ' (graduated from pump.fun)' : ''}`);
  for (const solIn of [0.01, 7]) {
    const lamports = BigInt(Math.round(solIn * 1e9));
    try {
      const native = await pf.venueFor(pool).quoteBuy(pool, lamports);
      const q = await jup.quote(WSOL_MINT, mint, lamports, 500, 48, false);
      const best = BigInt(q.outAmount);
      const pct = Number((native * 10_000n) / (best === 0n ? 1n : best)) / 100;
      console.log(`  ${solIn} SOL → native pool ${native} tokens, Jupiter ${best} tokens (${(q.routePlan as { swapInfo?: { label?: string } }[]).map((p) => p.swapInfo?.label).join(' → ')}): the native pool gives ${pct}% of the best route`);
    } catch (e) {
      console.log(`  ${solIn} SOL → could not compare: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(700);
  }
}
