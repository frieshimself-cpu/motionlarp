// Live-test tooling: a wallet of our own for the site to copy, so every scenario can be fired on demand instead of
// waiting for someone else to trade. It makes small REAL buys and sells (so run it only on purpose), through the
// public RPC and Jupiter's free endpoint, or, with "native", through the same pump.fun / PumpSwap builders the
// site uses. Keys are read from files and never printed.
//
//   tsx scripts/live-leader.ts new <keyfile>                      make a wallet, save its key, print its address
//   tsx scripts/live-leader.ts address <keyfile>
//   tsx scripts/live-leader.ts balances <keyfile>
//   tsx scripts/live-leader.ts transfer <fromKeyfile> <toAddress> <sol>
//   tsx scripts/live-leader.ts sweep <fromKeyfile> <toAddress>    send all its SOL back
//   tsx scripts/live-leader.ts buy <keyfile> <mint> <sol> [native]
//   tsx scripts/live-leader.ts sell <keyfile> <mint> <percent> [native]
//   tsx scripts/live-leader.ts resolve <mint>                     how the site would trade this coin
//   tsx scripts/live-leader.ts pick                               active coins to test on (curve and PumpSwap)
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { readFileSync, writeFileSync } = await import('node:fs');
const { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
const bs58 = (await import('bs58')).default;
const { getConnection } = await import('../src/chain/connection.js');
const { getSignaturesForAddress, getTransaction } = await import('../src/chain/rpc.js');
const { Jupiter } = await import('../src/venues/jupiter.js');
const { PfDispatcher } = await import('../src/venues/pf.js');
const { accountKeys, parseLeaderTrades, PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT } = await import('../src/watch/parse.js');

type Pk = InstanceType<typeof PublicKey>;
type Kp = InstanceType<typeof Keypair>;
const conn = getConnection();
const jup = new Jupiter(process.env.LEADER_JUPITER_URL || 'https://lite-api.jup.ag', '');
const pf = new PfDispatcher();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports: number | bigint) => (Number(lamports) / 1e9).toFixed(6);
const stamp = () => new Date().toISOString().slice(11, 23);
/** Priority fee of the leader's own transactions: enough to land through a public RPC. */
const PRIORITY_LAMPORTS = BigInt(process.env.LEADER_PRIORITY_LAMPORTS || 200_000);

/** The first base58 word in the file that is a 64-byte secret key (works for a bare key and for a note around it). */
function readKey(file: string): Kp {
  for (const word of readFileSync(file, 'utf8').split(/\s+/)) {
    if (word.length < 80) continue;
    try {
      const bytes = bs58.decode(word);
      if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    } catch {
      // not base58: keep looking
    }
  }
  throw new Error(`no private key found in ${file}`);
}

async function tokenBalance(owner: Pk, mint: string): Promise<{ amount: bigint; decimals: number }> {
  const res = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, 'confirmed');
  let amount = 0n;
  let decimals = 6;
  for (const a of res.value) {
    const info = a.account.data.parsed.info.tokenAmount as { amount: string; decimals: number };
    amount += BigInt(info.amount);
    decimals = info.decimals;
  }
  return { amount, decimals };
}

/** Sends a signed transaction, re-sends it every two seconds until it is confirmed or its blockhash has expired. */
async function sendAndWait(tx: InstanceType<typeof VersionedTransaction>, lastValidBlockHeight: number): Promise<{ signature: string; slot: number }> {
  const raw = tx.serialize();
  const signature = bs58.encode(tx.signatures[0]!);
  const t0 = Date.now();
  let lastSend = 0;
  for (;;) {
    if (Date.now() - lastSend > 2000) {
      lastSend = Date.now();
      await conn.sendRawTransaction(raw, { skipPreflight: lastSend !== t0 && Date.now() - t0 > 1000, preflightCommitment: 'processed', maxRetries: 0 }).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (Date.now() - t0 < 1000 && !/already been processed/i.test(msg)) throw e; // a preflight failure on the first send is final
      });
    }
    await sleep(400);
    const st = (await conn.getSignatureStatuses([signature]).catch(() => null))?.value[0];
    if (st) {
      if (st.err) throw new Error(`transaction failed on chain: ${JSON.stringify(st.err)} (${signature})`);
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { signature, slot: st.slot };
    }
    if (Date.now() - t0 > 20_000 && (await conn.getBlockHeight('confirmed').catch(() => 0)) > lastValidBlockHeight) throw new Error(`expired without landing (${signature})`);
  }
}

async function nativeTx(user: Kp, instructions: import('@solana/web3.js').TransactionInstruction[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const units = 250_000;
  const price = (PRIORITY_LAMPORTS * 1_000_000n) / BigInt(units);
  const msg = new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ...instructions] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([user]);
  return { tx, lastValidBlockHeight };
}

async function swap(user: Kp, mint: string, side: 'buy' | 'sell', amount: bigint, native: boolean) {
  const before = { sol: await conn.getBalance(user.publicKey, 'confirmed'), tok: (await tokenBalance(user.publicKey, mint)).amount };
  let built: { tx: InstanceType<typeof VersionedTransaction>; lastValidBlockHeight: number };
  let via: string;
  if (native) {
    const pool = await pf.resolve(mint);
    const venue = pf.venueFor(pool);
    const r = side === 'buy' ? await venue.buildBuy({ pool, user: user.publicKey, lamportsIn: amount, slippagePct: 30 }) : await venue.buildSell({ pool, user: user.publicKey, tokensIn: amount, slippagePct: 30 });
    built = await nativeTx(user, r.instructions);
    via = pool.kind;
  } else {
    const quote = side === 'buy' ? await jup.quote(WSOL_MINT, mint, amount, 3000) : await jup.quote(mint, WSOL_MINT, amount, 3000);
    const r = await jup.swap(quote, user.publicKey, PRIORITY_LAMPORTS);
    r.tx.sign([user]);
    built = r;
    via = `Jupiter (${(quote.routePlan as { swapInfo?: { label?: string } }[]).map((p) => p.swapInfo?.label).join(' → ')})`;
  }
  const sentAt = Date.now();
  console.log(`${stamp()} leader ${side} sent via ${via}`);
  const { signature, slot } = await sendAndWait(built.tx, built.lastValidBlockHeight);
  await sleep(600);
  const after = { sol: await conn.getBalance(user.publicKey, 'confirmed'), tok: (await tokenBalance(user.publicKey, mint)).amount };
  console.log(`${stamp()} leader ${side} CONFIRMED in ${((Date.now() - sentAt) / 1000).toFixed(1)}s  slot ${slot}  sig ${signature}`);
  console.log(`        SOL ${sol(before.sol)} → ${sol(after.sol)} (${sol(after.sol - before.sol)})   tokens ${before.tok} → ${after.tok}`);
  return { signature, slot };
}

const [cmd, a1, a2, a3, a4] = process.argv.slice(2);
if (cmd === 'new') {
  const kp = Keypair.generate();
  writeFileSync(a1!, `${bs58.encode(kp.secretKey)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(kp.publicKey.toBase58());
} else if (cmd === 'address') {
  console.log(readKey(a1!).publicKey.toBase58());
} else if (cmd === 'balances') {
  const kp = readKey(a1!);
  console.log(`${kp.publicKey.toBase58()}  ${sol(await conn.getBalance(kp.publicKey, 'confirmed'))} SOL`);
  for (const program of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const res = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: new PublicKey(program) }, 'confirmed');
    for (const a of res.value) {
      const i = a.account.data.parsed.info as { mint: string; tokenAmount: { amount: string; uiAmountString: string } };
      console.log(`  ${i.mint}  ${i.tokenAmount.uiAmountString}  (account ${a.pubkey.toBase58().slice(0, 8)}…, rent ${sol(a.account.lamports)})`);
    }
  }
} else if (cmd === 'transfer' || cmd === 'sweep') {
  const from = readKey(a1!);
  const to = new PublicKey(a2!);
  const balance = await conn.getBalance(from.publicKey, 'confirmed');
  const lamports = cmd === 'sweep' ? BigInt(balance) - 5_000n - PRIORITY_LAMPORTS : BigInt(Math.round(Number(a3) * 1e9));
  if (lamports <= 0n) throw new Error('nothing to send');
  // A plain transfer uses ~450 compute units: the priority fee is set for that, so it costs what was asked.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const units = 1_000;
  const msg = new TransactionMessage({ payerKey: from.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: (PRIORITY_LAMPORTS * 1_000_000n) / BigInt(units) }), SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([from]);
  const { signature, slot } = await sendAndWait(tx, lastValidBlockHeight);
  console.log(`${stamp()} sent ${sol(lamports)} SOL ${from.publicKey.toBase58().slice(0, 6)}… → ${to.toBase58().slice(0, 6)}…  slot ${slot}  sig ${signature}`);
} else if (cmd === 'buy') {
  await swap(readKey(a1!), a2!, 'buy', BigInt(Math.round(Number(a3) * 1e9)), a4 === 'native');
} else if (cmd === 'sell') {
  const kp = readKey(a1!);
  const { amount } = await tokenBalance(kp.publicKey, a2!);
  if (amount <= 0n) throw new Error('the leader holds none of this coin');
  const pct = Number(a3);
  await swap(kp, a2!, 'sell', pct >= 100 ? amount : (amount * BigInt(Math.round(pct * 100))) / 10_000n, a4 === 'native');
} else if (cmd === 'resolve') {
  try {
    const pool = await pf.resolve(a1!);
    const quote = await pf.venueFor(pool).quoteBuy(pool, 10_000_000n);
    console.log(`site trades it natively: ${pool.kind}, pool ${pool.pool.toBase58()}${pool.migratedFrom ? ' (graduated)' : ''}; 0.01 SOL buys ${quote} tokens`);
  } catch (e) {
    console.log(`not native (${e instanceof Error ? e.message : e}) → Jupiter`);
    const q = await jup.quote(WSOL_MINT, a1!, 10_000_000n, 500, 48, false);
    console.log(`Jupiter route: ${(q.routePlan as { swapInfo?: { label?: string } }[]).map((p) => p.swapInfo?.label).join(' → ')}; 0.01 SOL buys ${q.outAmount}`);
  }
} else if (cmd === 'pick') {
  // Coins bought in the last transactions of each program, with how busy they are in that sample.
  for (const [program, venue] of [[PUMP_PROGRAM, 'pumpfun'], [PUMP_AMM_PROGRAM, 'pumpswap']] as const) {
    const sigs = (await getSignaturesForAddress(program, { limit: 60 })).filter((s) => !s.err);
    const seen = new Map<string, { buys: number; sol: number }>();
    for (const s of sigs.slice(0, 30)) {
      let tx = null;
      try { tx = await getTransaction(s.signature); } catch { await sleep(1500); }
      await sleep(350);
      if (!tx) continue;
      for (const t of parseLeaderTrades(tx, accountKeys(tx)[0]!)) {
        if (t.venue !== venue || !t.mint.endsWith('pump')) continue;
        const e = seen.get(t.mint) ?? { buys: 0, sol: 0 };
        e.buys++;
        e.sol += Number(t.solLamports) / 1e9;
        seen.set(t.mint, e);
      }
    }
    console.log(`\n${venue}: coins in the last ${Math.min(30, sigs.length)} transactions`);
    for (const [mint, e] of [...seen].sort((x, y) => y[1].buys - x[1].buys).slice(0, 8)) {
      let how = '';
      try {
        const pool = await pf.resolve(mint);
        const accountSol = await conn.getBalance(pool.pool, 'confirmed');
        how = `${pool.kind}${pool.kind === 'pumpfun_curve' ? `, curve holds ${sol(accountSol)} SOL` : ''}`;
      } catch (err) {
        how = `not native: ${err instanceof Error ? err.message : err}`;
      }
      console.log(`  ${mint}  ${e.buys} trades, ${e.sol.toFixed(2)} SOL  [${how}]`);
      await sleep(300);
    }
  }
} else {
  console.log('commands: new, address, balances, transfer, sweep, buy, sell, resolve, pick');
}
