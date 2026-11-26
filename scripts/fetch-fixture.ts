// Finds recent real pump.fun curve and PumpSwap trades on mainnet and saves them as test fixtures.
// Usage: RPC_URL=... npm run fixture            (discover)
//        RPC_URL=... npm run fixture -- <sig> <name>
import { writeFileSync } from 'node:fs';
import { getSignaturesForAddress, getTransaction, type RawTransaction } from '../src/chain/rpc.js';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const url = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const dir = 'tests/fixtures/tx';

function save(name: string, tx: RawTransaction) {
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(tx, null, 1));
  console.log('saved', name, tx.transaction.signatures[0]);
}

function kind(tx: RawTransaction): string {
  const logs = tx.meta?.logMessages ?? [];
  if (logs.some((l) => /Instruction: Buy/.test(l))) return 'buy';
  if (logs.some((l) => /Instruction: Sell/.test(l))) return 'sell';
  return 'other';
}

const [sig, name] = process.argv.slice(2);
if (sig && name) {
  const tx = await getTransaction(sig, url);
  if (!tx) throw new Error('not found');
  save(name, tx);
} else {
  const want = new Map<string, boolean>([['curve_buy', false], ['curve_sell', false], ['amm_buy', false], ['amm_sell', false], ['failed', false]]);
  for (const [program, prefix] of [[PUMP, 'curve'], [AMM, 'amm']] as const) {
    const sigs = await getSignaturesForAddress(program, { limit: 60 }, url);
    for (const s of sigs) {
      const failedKey = 'failed';
      if (s.err && !want.get(failedKey)) {
        const tx = await getTransaction(s.signature, url);
        if (tx) { save(failedKey, tx); want.set(failedKey, true); }
        continue;
      }
      if (s.err) continue;
      const tx = await getTransaction(s.signature, url);
      if (!tx) continue;
      const k = kind(tx);
      const key = `${prefix}_${k}`;
      if (want.has(key) && !want.get(key)) { save(key, tx); want.set(key, true); }
      if ([...want.values()].every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  console.log(Object.fromEntries(want));
}
