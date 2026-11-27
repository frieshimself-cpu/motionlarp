// The Helius stream delivers transactions in the "jsonParsed" encoding; the poll path fetches them as "json".
// This checks, on real recent mainnet trades, that the trade reader gives the same answer for both shapes.
// Usage: RPC_URL=<rpc> npx tsx scripts/check-jsonparsed.ts
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { getSignaturesForAddress, getTransaction, rpc } = await import('../src/chain/rpc.js');
const { accountKeys, parseLeaderTrades, PUMP_PROGRAM, PUMP_AMM_PROGRAM } = await import('../src/watch/parse.js');
type Raw = import('../src/chain/rpc.js').RawTransaction;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (t: ReturnType<typeof parseLeaderTrades>) => JSON.stringify(t.map((x) => ({ ...x, blockTime: null })), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
let checked = 0;
let mismatches = 0;
for (const program of [PUMP_PROGRAM, PUMP_AMM_PROGRAM, 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj']) {
  const sigs = await getSignaturesForAddress(program, { limit: 25 });
  for (const s of sigs) {
    if (s.err || checked >= 12) continue;
    const json = await getTransaction(s.signature);
    await sleep(600);
    if (!json) continue;
    const payer = accountKeys(json)[0]!;
    const a = parseLeaderTrades(json, payer);
    if (!a.length) continue;
    const parsed = await rpc<Raw | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    await sleep(600);
    if (!parsed) continue;
    const b = parseLeaderTrades(parsed, payer);
    checked++;
    const same = show(a) === show(b);
    if (!same) mismatches++;
    console.log(`${same ? 'same' : 'DIFFERENT'}  ${a[0]!.side} ${a[0]!.venue} ${s.signature.slice(0, 12)}…`);
    if (!same) console.log('  json      ', show(a), '\n  jsonParsed', show(b));
  }
}
console.log(`\n${checked} trades checked, ${mismatches} mismatches`);
process.exit(mismatches || checked === 0 ? 1 : 0);
