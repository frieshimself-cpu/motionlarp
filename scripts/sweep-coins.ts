// The every-coin sweep (reads and simulates only; sends nothing).
//
// Takes coins that were just bought on each venue (pump.fun's curve, PumpSwap, and the launchpads and exchanges
// that go through Jupiter) and, as the wallet that bought each one, builds OUR buy and OUR sells with the site's own
// code: the same routing (native or Jupiter), the same builders, with the platform fee and the tip inside, at the
// Scharo preset's fees. Each transaction is simulated on mainnet. The report says, per kind of coin, what passes,
// what fails and why, and how many compute units the native trades use.
//
//   RPC_URL=<your rpc> npx tsx scripts/sweep-coins.ts [coins per venue = 6] [only venues matching this text]
//
// On the public RPC it is slow (rate limits) but works. A failure here is a coin our code cannot trade as built.
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { Keypair, PublicKey } = await import('@solana/web3.js');
const { config } = await import('../src/config.js');
const { getConnection } = await import('../src/chain/connection.js');
const { getSignaturesForAddress, getTransaction } = await import('../src/chain/rpc.js');
const { ChainExecutor } = await import('../src/engine/executor.js');
const { feeLamports, withFee } = await import('../src/fee.js');
const { pumpSdk, pumpSwapSdk } = await import('../src/venues/sdk.js');
const { accountKeys, parseLeaderTrades, PUMP_AMM_PROGRAM, PUMP_PROGRAM, STABLE_MINTS, WSOL_MINT } = await import('../src/watch/parse.js');

type Pk = InstanceType<typeof PublicKey>;
const PER_VENUE = Number(process.argv[2] ?? 6);
const ONLY = (process.argv[3] ?? '').toLowerCase();
/** A wallet that already holds SOL: a fee paid into an empty account fails below the rent minimum. */
const FEE_TO = '463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq';
const FEE_BPS = 100;
const VENUES: [string, string, 'pumpfun' | 'pumpswap' | 'other'][] = [
  ['pump.fun curve', PUMP_PROGRAM, 'pumpfun'],
  ['PumpSwap', PUMP_AMM_PROGRAM, 'pumpswap'],
  ['Raydium LaunchLab (Bonk)', 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'other'],
  ['Meteora DBC', 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 'other'],
  ['Meteora DAMM v2', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', 'other'],
  ['Meteora DLMM', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'other'],
  ['Raydium CPMM', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'other'],
  ['Raydium AMM v4', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'other'],
  ['Raydium CLMM', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'other'],
  ['Orca Whirlpool', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'other'],
  ['Moonshot', 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG', 'other'],
];

config.feeWallet = FEE_TO;
const conn = getConnection();
// The site's own executor; its private builders are used as they are (that is the point of the sweep).
const ex = new ChainExecutor() as unknown as {
  pf: { venueFor(pool: unknown): { buildBuy(a: unknown): Promise<{ instructions: never[]; expectedOut: bigint }>; buildSell(a: unknown): Promise<{ instructions: never[]; expectedOut: bigint }> } };
  route<T>(mint: string, native: (pool: { kind: string; pool: Pk; tokenProgram: Pk }) => Promise<T>, jupiter: () => Promise<T>): Promise<T>;
  nativeTx(req: unknown, ixs: unknown[]): Promise<{ tx: import('@solana/web3.js').VersionedTransaction }>;
  jupiterTx(req: unknown, input: string, output: string, amount: bigint, feeOn: (out: bigint) => bigint): Promise<{ tx: import('@solana/web3.js').VersionedTransaction; quote: { routePlan: { swapInfo?: { label?: string } }[] } }>;
  tokenBalance(owner: string, mint: string): Promise<bigint>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => `${s.slice(0, 6)}…`;

/** Signs nothing real: the simulation runs with signature checks off, as the wallet that owns the coins. */
function standIn(owner: Pk) {
  return new Keypair({ publicKey: owner.toBytes(), secretKey: Keypair.generate().secretKey });
}

async function simulate(tx: import('@solana/web3.js').VersionedTransaction) {
  for (let i = 0; ; i++) {
    try {
      const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
      const why = r.value.err ? `${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).filter((l) => /error|failed|insufficient|exceed|slippage/i.test(l)).slice(-3).join(' | ')}`.slice(0, 330) : '';
      return { ok: !r.value.err, why, units: r.value.unitsConsumed ?? 0, size: tx.serialize().length };
    } catch (e) {
      if (i >= 2) return { ok: false, why: `simulate call failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`, units: 0, size: 0 };
      await sleep(1500);
    }
  }
}

/** What kind of pump coin this is, from its curve or pool account (the SDK distinguishes these). */
async function flags(pool: { kind: string; pool: Pk; tokenProgram: Pk }): Promise<string> {
  const out: string[] = [pool.tokenProgram.toBase58().startsWith('Tokenz') ? 'token-2022' : 'classic-token'];
  try {
    const info = await conn.getAccountInfo(pool.pool, 'confirmed');
    if (info) {
      const d = (pool.kind === 'pumpswap' ? pumpSwapSdk.PUMP_AMM_SDK.decodePool(info as never) : pumpSdk.PUMP_SDK.decodeBondingCurve(info as never)) as unknown as { isMayhemMode?: boolean; isCashbackCoin?: boolean; quoteMint?: Pk; creatorFeeBps?: { toString(): string } };
      if (d.isMayhemMode) out.push('mayhem');
      if (d.isCashbackCoin) out.push('cashback');
      const quote = d.quoteMint?.toBase58();
      if (quote && quote !== WSOL_MINT && quote !== '11111111111111111111111111111111') out.push(`quote:${short(quote)}`);
      if (d.creatorFeeBps && d.creatorFeeBps.toString() !== '0') out.push(`creator-fee:${d.creatorFeeBps.toString()}bps`);
    }
  } catch {
    out.push('undecoded');
  }
  return out.join(',');
}

interface Row { venue: string; mint: string; via: string; kind: string; op: string; ok: boolean; why: string; units: number; size: number }
const rows: Row[] = [];

async function oneCoin(venue: string, mint: string, owner: Pk) {
  const wallet = standIn(owner);
  const balance = BigInt(await conn.getBalance(owner, 'confirmed'));
  const lamports = balance / 4n < 10_000_000n ? balance / 4n : 10_000_000n;
  if (lamports < 2_000_000n) return false;
  const req = (slippagePct: number) => ({ wallet, mint, slippagePct, priorityFeeSol: 0.001, tipSol: 0.005, live: true, feeBps: FEE_BPS });
  let kind = '';
  const record = (op: string, via: string, r: { ok: boolean; why: string; units: number; size: number }) => {
    rows.push({ venue, mint, via, kind, op, ...r });
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${op.padEnd(18)} via ${via.padEnd(28)} ${r.ok ? `${r.units} CU, ${r.size} bytes` : r.why}`);
  };
  const attempt = async (op: string, build: () => Promise<{ via: string; tx: import('@solana/web3.js').VersionedTransaction }>) => {
    try {
      const b = await build();
      record(op, b.via, await simulate(b.tx));
    } catch (e) {
      record(op, '(build)', { ok: false, why: `could not build: ${e instanceof Error ? e.message.slice(0, 220) : e}`, units: 0, size: 0 });
    }
    await sleep(500);
  };
  const buy = (slip: number) => () => ex.route(mint,
    async (pool) => {
      kind ||= await flags(pool);
      const built = await ex.pf.venueFor(pool).buildBuy({ pool, user: owner, lamportsIn: lamports, slippagePct: slip });
      const ixs = withFee(built.instructions, owner, lamports, FEE_BPS, FEE_TO);
      return { via: pool.kind, tx: (await ex.nativeTx(req(slip), ixs.instructions)).tx };
    },
    async () => {
      const b = await ex.jupiterTx(req(slip), WSOL_MINT, mint, lamports, () => feeLamports(lamports, FEE_BPS));
      return { via: `Jupiter: ${b.quote.routePlan.map((p) => p.swapInfo?.label).join('>')}`.slice(0, 28), tx: b.tx };
    });
  const sell = (tokens: bigint) => () => ex.route(mint,
    async (pool) => {
      const built = await ex.pf.venueFor(pool).buildSell({ pool, user: owner, tokensIn: tokens, slippagePct: 100 });
      const ixs = withFee(built.instructions, owner, built.expectedOut, FEE_BPS, FEE_TO);
      return { via: pool.kind, tx: (await ex.nativeTx(req(100), ixs.instructions)).tx };
    },
    async () => {
      const b = await ex.jupiterTx(req(100), mint, WSOL_MINT, tokens, (out) => feeLamports(out, FEE_BPS));
      return { via: `Jupiter: ${b.quote.routePlan.map((p) => p.swapInfo?.label).join('>')}`.slice(0, 28), tx: b.tx };
    });

  console.log(`\n${venue}  ${mint}  (wallet ${short(owner.toBase58())}, ${(Number(balance) / 1e9).toFixed(2)} SOL)`);
  await attempt('buy, 100% slippage', buy(100));
  if (kind) console.log(`  kind: ${kind}`);
  await attempt('buy, 10% slippage', buy(10));
  const held = await ex.tokenBalance(owner.toBase58(), mint).catch(() => 0n);
  if (held > 1n) {
    await attempt('sell 40% of bag', sell((held * 40n) / 100n));
    await attempt('sell everything', sell(held));
  } else {
    console.log('  (the wallet no longer holds the coin: sells not simulated)');
  }
  return true;
}

for (const [venue, program, parseAs] of VENUES) {
  if (ONLY && !venue.toLowerCase().includes(ONLY)) continue;
  console.log(`\n===== ${venue} =====`);
  let sigs: Awaited<ReturnType<typeof getSignaturesForAddress>> = [];
  try { sigs = (await getSignaturesForAddress(program, { limit: 200 })).filter((s) => !s.err); } catch (e) { console.log(`could not list transactions: ${e instanceof Error ? e.message : e}`); }
  if (!sigs.length) { console.log('no recent transactions found for this program'); continue; }
  const seen = new Set<string>();
  let done = 0;
  let looked = 0;
  for (const s of sigs) {
    if (done >= PER_VENUE || looked >= PER_VENUE * 12) break;
    looked++;
    let tx = null;
    try { tx = await getTransaction(s.signature); } catch { await sleep(1500); }
    await sleep(350);
    if (!tx) continue;
    const payer = accountKeys(tx)[0]!;
    const t = parseLeaderTrades(tx, payer).find((x) => x.side === 'buy' && x.venue === parseAs && x.solLamports > 1_000_000n && !STABLE_MINTS.has(x.mint) && x.mint !== WSOL_MINT);
    if (!t || seen.has(t.mint)) continue;
    seen.add(t.mint);
    try {
      if (await oneCoin(venue, t.mint, new PublicKey(payer))) done++;
    } catch (e) {
      console.log(`  (skipped ${short(t.mint)}: ${e instanceof Error ? e.message.slice(0, 160) : e})`);
    }
  }
  if (!done) console.log('no usable sample found (wallets too small or RPC busy): run again');
}

// ── the report ──────────────────────────────────────────────────────────────
console.log('\n\n================ SUMMARY ================');
const group = new Map<string, { pass: number; fail: number; maxUnits: number; maxSize: number; why: Set<string> }>();
for (const r of rows) {
  const key = `${r.venue} | ${r.via.startsWith('Jupiter') ? 'Jupiter' : r.via}${r.kind ? ` | ${r.kind}` : ''} | ${r.op}`;
  const g = group.get(key) ?? { pass: 0, fail: 0, maxUnits: 0, maxSize: 0, why: new Set<string>() };
  if (r.ok) g.pass++; else { g.fail++; g.why.add(r.why.slice(0, 200)); }
  g.maxUnits = Math.max(g.maxUnits, r.units);
  g.maxSize = Math.max(g.maxSize, r.size);
  group.set(key, g);
}
for (const [key, g] of [...group].sort()) {
  console.log(`${g.fail ? 'FAIL' : 'ok  '} ${String(g.pass).padStart(2)}/${g.pass + g.fail}  ${key}  (max ${g.maxUnits} CU, ${g.maxSize} bytes)`);
  for (const w of g.why) console.log(`        ${w}`);
}
const fails = rows.filter((r) => !r.ok).length;
const coins = new Set(rows.map((r) => r.mint)).size;
console.log(`\n${coins} coins, ${rows.length} simulated trades, ${fails} failed`);
process.exit(fails ? 1 : 0);
