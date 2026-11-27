// Check against the real chain, sending nothing: OUR buy at the size a big trader uses (default 7 SOL), built by the
// same code that trades, wrapped the way the executor wraps it (compute budget and priority fee, the 1 % platform
// fee transfer, the tip), and simulated on mainnet for coins that were just bought, on the pump.fun curve and on
// PumpSwap. The signer is a wallet that holds that much SOL (signatures are not checked in a simulation).
// Usage: RPC_URL=<your rpc> npx tsx scripts/check-big-buy.ts [SOL per buy] [coins per venue]
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
const { getConnection } = await import('../src/chain/connection.js');
const { getSignaturesForAddress, getTransaction } = await import('../src/chain/rpc.js');
const { accountKeys, parseLeaderTrades, PUMP_AMM_PROGRAM, PUMP_PROGRAM } = await import('../src/watch/parse.js');
const { PfDispatcher } = await import('../src/venues/pf.js');
const { programError } = await import('../src/tx/errors.js');
const { tipAccount } = await import('../src/tx/tip.js');

const SOL = Number(process.argv[2] ?? 7);
const WANT = Number(process.argv[3] ?? 3);
const LAMPORTS = BigInt(Math.round(SOL * 1e9));
const CU = 200_000; // the executor's compute-unit limit
const PRIORITY = 0.001; // Scharo's buy priority fee, SOL
const TIP = 5_000_000; // Scharo's buy tip, lamports
const conn = getConnection();
const pf = new PfDispatcher();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const feeWallet = Keypair.generate().publicKey;
let failures = 0;
let total = 0;
let signer: InstanceType<typeof PublicKey> | null = null;

async function sim(user: InstanceType<typeof PublicKey>, ixs: import('@solana/web3.js').TransactionInstruction[]) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor((PRIORITY * 1e9 * 1e6) / CU) }),
    ...ixs,
    SystemProgram.transfer({ fromPubkey: user, toPubkey: feeWallet, lamports: (LAMPORTS * 100n) / 10_000n }),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: tipAccount('sender'), lamports: TIP }),
  ];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message());
  const size = tx.serialize().length;
  const before = await conn.getBalance(user, 'confirmed');
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [user.toBase58()] } });
  const after = r.value.accounts?.[0]?.lamports ?? null;
  return { err: r.value.err, why: programError(r.value.logs ?? undefined), spent: after === null ? null : before - after, units: r.value.unitsConsumed ?? 0, size };
}

for (const [program, venue, kind] of [[PUMP_PROGRAM, 'pumpfun', 'pumpfun_curve'], [PUMP_AMM_PROGRAM, 'pumpswap', 'pumpswap']] as const) {
  console.log(`\n=== ${kind}: our ${SOL} SOL buy at 100 % slippage, with the platform fee and the tip ===`);
  const sigs = await getSignaturesForAddress(program, { limit: 200 });
  const seen = new Set<string>();
  let done = 0;
  for (const s of sigs) {
    if (done >= WANT) break;
    if (s.err) continue;
    let tx = null;
    try { tx = await getTransaction(s.signature); } catch { await sleep(1500); continue; }
    if (!tx) continue;
    const payer = accountKeys(tx)[0]!;
    // The first wallet seen with enough SOL signs every simulation.
    if (!signer && (await conn.getBalance(new PublicKey(payer), 'confirmed')) > Number(LAMPORTS) + 1_000_000_000) signer = new PublicKey(payer);
    const t = parseLeaderTrades(tx, payer).find((x) => x.side === 'buy' && x.venue === venue);
    if (!t || seen.has(t.mint) || !signer) continue;
    seen.add(t.mint);
    try {
      const pool = await pf.resolve(t.mint);
      if (pool.kind !== kind) continue;
      const built = await pf.venueFor(pool).buildBuy({ pool, user: signer, lamportsIn: LAMPORTS, slippagePct: 100 });
      const a = await sim(signer, built.instructions);
      const cap = Number(LAMPORTS) * 1.01 + TIP + PRIORITY * 1e9 + 3_500_000; // buy + fee + tip + priority + account rents
      const ok = !a.err && a.spent !== null && a.spent <= cap && a.size <= 1232;
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${t.mint.slice(0, 8)}…  ${a.err ? `error ${a.why ?? JSON.stringify(a.err)}` : `spent ${((a.spent ?? 0) / 1e9).toFixed(4)} SOL`} · ${a.units} compute units of ${CU} · ${a.size} bytes${built.lamportsIn ? ` · budget lowered to ${Number(built.lamportsIn) / 1e9} (mayhem curve near its end)` : ''}`);
      done++;
      total++;
    } catch (e) {
      console.log(`(skipping ${t.mint.slice(0, 6)}…: ${e instanceof Error ? e.message : e})`);
    }
    await sleep(300);
  }
}
console.log(`\n${total} coins checked at ${SOL} SOL, ${failures} failed${signer ? '' : ' (no wallet with enough SOL found)'}`);
process.exit(total === 0 || failures ? 1 : 0);
