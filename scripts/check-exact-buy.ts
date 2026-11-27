// Check against the real chain, sending nothing: a pump.fun curve buy at 100 % slippage spends what was asked and
// no more. For several coins that were just bought on the curve, OUR buy (the same code that trades) is built for
// the wallet that bought it and simulated on mainnet, next to pump.fun's older "this many tokens, pay up to
// amount + slippage" buy. Usage: RPC_URL=<your rpc> npx tsx scripts/check-exact-buy.ts
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
const { getConnection } = await import('../src/chain/connection.js');
const { getSignaturesForAddress, getTransaction } = await import('../src/chain/rpc.js');
const { accountKeys, parseLeaderTrades, PUMP_PROGRAM } = await import('../src/watch/parse.js');
const { PfDispatcher } = await import('../src/venues/pf.js');

const conn = getConnection();
const pf = new PfDispatcher();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WANT = Number(process.argv[2] ?? 4);
const LAMPORTS = 10_000_000n;
/** A new token account's rent, paid on a wallet's first buy of a coin (Token-2022 accounts cost a little more). */
const RENT_ALLOWANCE = 3_000_000;
let failures = 0;

async function sim(user: InstanceType<typeof PublicKey>, ixs: import('@solana/web3.js').TransactionInstruction[]) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs] }).compileToV0Message();
  const before = await conn.getBalance(user, 'confirmed');
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [user.toBase58()] } });
  const after = r.value.accounts?.[0]?.lamports ?? null;
  const ix = r.value.logs?.find((l) => /Instruction: Buy/.test(l))?.replace('Program log: Instruction: ', '') ?? '?';
  return { err: r.value.err, spent: after === null ? null : before - after, ix };
}

const sigs = await getSignaturesForAddress(PUMP_PROGRAM, { limit: 200 });
const seen = new Set<string>();
let done = 0;
for (const s of sigs) {
  if (done >= WANT) break;
  if (s.err) continue;
  let tx = null;
  try { tx = await getTransaction(s.signature); } catch { await sleep(2000); continue; }
  await sleep(600);
  if (!tx) continue;
  const payer = accountKeys(tx)[0]!;
  const t = parseLeaderTrades(tx, payer).find((x) => x.side === 'buy' && x.venue === 'pumpfun' && x.solLamports > 1_000_000n);
  if (!t || seen.has(t.mint)) continue;
  seen.add(t.mint);
  try {
    const user = new PublicKey(payer);
    const pool = await pf.resolve(t.mint);
    if (pool.kind !== 'pumpfun_curve') continue;
    if ((await conn.getBalance(user, 'confirmed')) < 40_000_000) continue;
    const exact = await pf.venueFor(pool).buildBuy({ pool, user, lamportsIn: LAMPORTS, slippagePct: 100 });
    const a = await sim(user, exact.instructions);
    process.env.PUMP_EXACT_BUY = 'off';
    const old = await pf.venueFor(pool).buildBuy({ pool, user, lamportsIn: LAMPORTS, slippagePct: 100 });
    delete process.env.PUMP_EXACT_BUY;
    const b = await sim(user, old.instructions);
    const ok = !a.err && a.spent !== null && a.spent <= Number(LAMPORTS) + RENT_ALLOWANCE;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${t.mint.slice(0, 8)}…  our buy (${a.ix}, min ${exact.minOut} tokens): ${a.err ? `error ${JSON.stringify(a.err)}` : `spent ${((a.spent ?? 0) / 1e9).toFixed(6)} SOL of 0.01 asked`}   |   older buy (${b.ix}): ${b.err ? `error ${JSON.stringify(b.err)}` : `spent ${((b.spent ?? 0) / 1e9).toFixed(6)}, allowed to take up to 0.02`}`);
    done++;
  } catch (e) {
    console.log(`(skipping ${t.mint.slice(0, 6)}…: ${e instanceof Error ? e.message : e})`);
  }
  await sleep(800);
}
console.log(`\n${done} coins checked, ${failures} failed`);
if (done === 0 || failures) process.exit(1);
