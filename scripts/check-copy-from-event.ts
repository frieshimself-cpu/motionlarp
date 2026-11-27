// Check against the real chain, sending nothing: our copy buy built straight from pump.fun's own event of the copied
// wallet's buy, with no read of the curve (how the site copies a pump.fun curve buy since 27 Nov 2026). On coins that
// were just bought on the pump.fun curve, each one:
//   1. the coin's token program read from the trade's logs is the program that owns the mint;
//   2. the reserves pump.fun writes in its event are the curve right after that trade (the newest trade on the curve,
//      compared with the curve as it stands, read before and after with no trade in between);
//   3. the buy built from the event has exactly the accounts of the one built from the curve read now;
//   4. it simulates on mainnet without an error, wrapped as the executor sends it (priority fee, platform fee, tip),
//      and spends no more than the amount set plus fees.
// Usage: RPC_URL=<your rpc> npx tsx scripts/check-copy-from-event.ts [SOL per buy] [coins]
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
const { getConnection } = await import('../src/chain/connection.js');
const { getSignaturesForAddress, getTransaction } = await import('../src/chain/rpc.js');
const { accountKeys, PUMP_PROGRAM } = await import('../src/watch/parse.js');
const { fastBuysFromLogs } = await import('../src/watch/events.js');
const { PfDispatcher } = await import('../src/venues/pf.js');
const { pumpSdk } = await import('../src/venues/sdk.js');
const { programError } = await import('../src/tx/errors.js');
const { tipAccount } = await import('../src/tx/tip.js');

const SOL = Number(process.argv[2] ?? 1);
const WANT = Number(process.argv[3] ?? 12);
const LAMPORTS = BigInt(Math.round(SOL * 1e9));
const CU = 200_000;
const PRIORITY = 0.001;
const TIP = 5_000_000;
const conn = getConnection();
const pf = new PfDispatcher();
const venue = pf.curve;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const feeWallet = Keypair.generate().publicKey;
const decoder = pumpSdk.getPumpProgram(new Connection('http://127.0.0.1:1')).coder.events as unknown as { decode: (b64: string) => { name: string; data: Record<string, unknown> } | null };
const str = (v: unknown) => (v === undefined || v === null ? '' : String((v as { toString: () => string }).toString()));

async function retry<T>(f: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(800 * (i + 1));
    }
  }
}

/** The trade events pump.fun itself wrote in these logs (any wallet). */
function tradeEvents(logs: string[]) {
  const out: Record<string, unknown>[] = [];
  const running: string[] = [];
  for (const line of logs) {
    const call = /^Program (\w{32,44}) invoke \[/.exec(line);
    if (call) { running.push(call[1]!); continue; }
    if (/^Program \w{32,44} (success|failed)/.test(line)) { running.pop(); continue; }
    if (!line.startsWith('Program data: ') || running[running.length - 1] !== PUMP_PROGRAM) continue;
    try {
      const ev = decoder.decode(line.slice('Program data: '.length));
      if (ev?.name === 'tradeEvent') out.push(ev.data);
    } catch {
      // not an event
    }
  }
  return out;
}

// The buyback fee wallet: pump.fun's SDK picks one of its listed wallets at random for every buy it builds.
const { readFileSync } = await import('node:fs');
const sdkText = readFileSync(new URL('../node_modules/@pump-fun/pump-sdk/dist/index.js', import.meta.url), 'utf8');
const BUYBACK = new Set([...(/CURRENT_FEE_RECIPIENTS_FOR_BUYBACK = \[([^\]]+)\]/.exec(sdkText)?.[1] ?? '').matchAll(/"(\w{32,44})"/g)].map((m) => m[1]!));
if (BUYBACK.size < 2) throw new Error('the SDK\'s buyback fee wallets were not found');

type Ix = import('@solana/web3.js').TransactionInstruction;
function sameAccounts(a: Ix[], b: Ix[]): string | null {
  if (a.length !== b.length) return `${a.length} instructions vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (!a[i]!.programId.equals(b[i]!.programId)) return `instruction ${i}: program ${a[i]!.programId.toBase58()} vs ${b[i]!.programId.toBase58()}`;
    if (a[i]!.keys.length !== b[i]!.keys.length) return `instruction ${i}: ${a[i]!.keys.length} accounts vs ${b[i]!.keys.length}`;
    for (let k = 0; k < a[i]!.keys.length; k++) {
      const x = a[i]!.keys[k]!;
      const y = b[i]!.keys[k]!;
      const randomBuyback = BUYBACK.has(x.pubkey.toBase58()) && BUYBACK.has(y.pubkey.toBase58());
      if ((!x.pubkey.equals(y.pubkey) && !randomBuyback) || x.isSigner !== y.isSigner || x.isWritable !== y.isWritable) return `instruction ${i} account ${k}: ${x.pubkey.toBase58()} vs ${y.pubkey.toBase58()}`;
    }
  }
  return null;
}

async function sim(user: InstanceType<typeof PublicKey>, ixs: Ix[]) {
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor((PRIORITY * 1e9 * 1e6) / CU) }),
    ...ixs,
    SystemProgram.transfer({ fromPubkey: user, toPubkey: feeWallet, lamports: (LAMPORTS * 100n) / 10_000n }),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: tipAccount('sender'), lamports: TIP }),
  ];
  const { blockhash } = await retry(() => conn.getLatestBlockhash('confirmed'));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message());
  const before = await retry(() => conn.getBalance(user, 'confirmed'));
  const r = await retry(() => conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [user.toBase58()] } }));
  const after = r.value.accounts?.[0]?.lamports ?? null;
  return { err: r.value.err, why: programError(r.value.logs ?? undefined), spent: after === null ? null : before - after, units: r.value.unitsConsumed ?? 0, size: tx.serialize().length };
}

const tally = { programs: 0, programMismatch: 0, postTrade: 0, postTradeMismatch: 0, accounts: 0, accountMismatch: 0, sims: 0, simFailed: 0, mayhem: 0, classic: 0, t22: 0 };
const problems: string[] = [];
const seen = new Set<string>();
let signer: InstanceType<typeof PublicKey> | null = null;
let before: string | undefined;

await venue.warmGlobals();
console.log(`=== our ${SOL} SOL copy buy, built from pump.fun's event of the copied wallet's buy (no curve read) ===`);
for (let page = 0; page < 10 && seen.size < WANT; page++) {
  const sigs = await retry(() => getSignaturesForAddress(PUMP_PROGRAM, { limit: 100, ...(before ? { before } : {}) }));
  before = sigs[sigs.length - 1]?.signature;
  for (const s of sigs) {
    if (seen.size >= WANT) break;
    if (s.err) continue;
    let tx;
    try { tx = await retry(() => getTransaction(s.signature)); } catch { continue; }
    if (!tx?.meta?.logMessages) continue;
    const payer = accountKeys(tx)[0]!;
    const hint = fastBuysFromLogs(tx.meta.logMessages, s.signature, payer, tx.slot)?.[0];
    if (!hint?.curve || seen.has(hint.mint)) continue;
    if (!signer && (await retry(() => conn.getBalance(new PublicKey(payer), 'confirmed'))) > Number(LAMPORTS) * 2 + 1e9) signer = new PublicKey(payer);
    if (!signer) continue;
    seen.add(hint.mint);
    const c = hint.curve;
    const mint = new PublicKey(hint.mint);
    const tag = `${hint.mint.slice(0, 8)}…${c.mayhem ? ' (mayhem)' : ''}`;
    if (c.mayhem) tally.mayhem++;
    // 1. the token program
    const mintInfo = await retry(() => conn.getAccountInfo(mint, 'confirmed'));
    const owner = mintInfo?.owner.toBase58();
    tally.programs++;
    if (owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') tally.classic++; else tally.t22++;
    if (!c.tokenProgram || c.tokenProgram !== owner) { tally.programMismatch++; problems.push(`${tag}: token program from the logs ${c.tokenProgram ?? 'none'}, the mint's owner ${owner}`); }
    // 2. the event's reserves are the curve after the trade: the newest trade on the curve against the curve now
    const curvePda = pumpSdk.bondingCurvePda(mint);
    const newest1 = (await retry(() => getSignaturesForAddress(curvePda.toBase58(), { limit: 1 })))[0];
    // read at the same commitment as the signatures ('confirmed'): a newer view could hold a trade they do not list yet
    const curveNow = pumpSdk.PUMP_SDK.decodeBondingCurve((await retry(async () => { const a = await conn.getAccountInfo(curvePda, 'confirmed'); if (!a) throw new Error('no curve'); return a; })) as never);
    const newest2 = (await retry(() => getSignaturesForAddress(curvePda.toBase58(), { limit: 1 })))[0];
    if (newest1 && newest2 && newest1.signature === newest2.signature && !newest1.err) {
      const last = await retry(() => getTransaction(newest1.signature));
      const ev = last?.meta?.logMessages ? tradeEvents(last.meta.logMessages).filter((e) => str(e.mint) === hint.mint).pop() : undefined;
      if (ev) {
        tally.postTrade++;
        const vq = str(ev.virtualQuoteReserves) && str(ev.virtualQuoteReserves) !== '0' ? str(ev.virtualQuoteReserves) : str(ev.virtualSolReserves);
        const same = str(ev.virtualTokenReserves) === curveNow.virtualTokenReserves.toString() && vq === curveNow.virtualQuoteReserves.toString() && str(ev.realTokenReserves) === curveNow.realTokenReserves.toString();
        if (!same) { tally.postTradeMismatch++; problems.push(`${tag}: event reserves ${str(ev.virtualTokenReserves)}/${vq}, curve now ${curveNow.virtualTokenReserves}/${curveNow.virtualQuoteReserves}`); }
      }
    }
    if (curveNow.tokenTotalSupply.toString() !== '1000000000000000') problems.push(`${tag}: the curve's total supply is ${curveNow.tokenTotalSupply.toString()}, not the 1,000,000,000,000,000 a buy built from the event assumes`);
    if (c.mayhem) console.log(`   ${tag}: the curve's total supply ${curveNow.tokenTotalSupply.toString()} (the event-built state assumes 1,000,000,000,000,000)`);
    // 3. same accounts as the buy built from the curve read now; 4. simulated
    const pool = { kind: 'pumpfun_curve' as const, pool: curvePda, mint, tokenProgram: new PublicKey(c.tokenProgram ?? owner!) };
    try {
      const fromEvent = await venue.buildBuy({ pool, user: signer, lamportsIn: LAMPORTS, slippagePct: 100, curve: c });
      const fromRead = await retry(() => venue.buildBuy({ pool, user: signer!, lamportsIn: LAMPORTS, slippagePct: 100 }));
      tally.accounts++;
      const diff = sameAccounts(fromEvent.instructions, fromRead.instructions);
      if (diff) { tally.accountMismatch++; problems.push(`${tag}: ${diff}`); }
      const a = await sim(signer, fromEvent.instructions);
      tally.sims++;
      const cap = Number(LAMPORTS) * 1.01 + TIP + PRIORITY * 1e9 + 3_500_000;
      const ok = !a.err && a.spent !== null && a.spent <= cap && a.size <= 1232;
      if (!ok) { tally.simFailed++; problems.push(`${tag}: simulation ${a.err ? `error ${a.why ?? JSON.stringify(a.err)}` : `spent ${a.spent}`}`); }
      console.log(`${ok && !diff ? 'PASS' : 'FAIL'} ${tag} ${owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? 'classic SPL' : 'Token-2022'} · ${diff ? `accounts differ: ${diff}` : 'same accounts as from a read'} · ${a.err ? `error ${a.why ?? JSON.stringify(a.err)}` : `spent ${((a.spent ?? 0) / 1e9).toFixed(4)} SOL`} · ${a.units} CU · ${a.size} bytes · quote ${fromEvent.expectedOut} vs ${fromRead.expectedOut} from a read`);
    } catch (e) {
      console.log(`(skipping ${tag}: ${e instanceof Error ? e.message : e})`);
    }
    await sleep(250);
  }
}
console.log(`\n${seen.size} coins: token program ${tally.programs - tally.programMismatch}/${tally.programs} right (${tally.t22} Token-2022, ${tally.classic} classic, ${tally.mayhem} mayhem) · event = curve after the trade ${tally.postTrade - tally.postTradeMismatch}/${tally.postTrade} · same accounts ${tally.accounts - tally.accountMismatch}/${tally.accounts} · simulated ${tally.sims - tally.simFailed}/${tally.sims}`);
for (const p of problems) console.log(`  problem: ${p}`);
process.exit(problems.length || !seen.size ? 1 : 0);
