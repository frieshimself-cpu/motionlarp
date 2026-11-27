// Live-test tooling: runs the site's own real-money code (ChainExecutor: build, send through the RPC and Helius
// Sender, confirm, read the fill) for one small round trip with a wallet of ours, and checks every number it
// reports against the transaction on chain. It SENDS REAL TRANSACTIONS: run it only on purpose.
//
//   tsx scripts/live-executor-check.ts <keyfile> <mint> <buySol | 0 to only sell what is held> [tipSol] [priorityFeeSol]
//
// Steps: (buy), sell 40 % of what is held, sell everything left. Exit code 1 when a reported fill differs from chain.
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
process.env.LIVE_TRADING = 'true';
const { readFileSync } = await import('node:fs');
const { Keypair } = await import('@solana/web3.js');
const bs58 = (await import('bs58')).default;
const { config } = await import('../src/config.js');
const { getTransaction } = await import('../src/chain/rpc.js');
const { ChainExecutor } = await import('../src/engine/executor.js');

function readKey(file: string) {
  for (const word of readFileSync(file, 'utf8').split(/\s+/)) {
    if (word.length < 80) continue;
    try {
      const bytes = bs58.decode(word);
      if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    } catch {
      // keep looking
    }
  }
  throw new Error(`no private key found in ${file}`);
}

const [keyfile, mint, buySolArg, tipArg, prioArg] = process.argv.slice(2);
if (!keyfile || !mint) throw new Error('usage: tsx scripts/live-executor-check.ts <keyfile> <mint> <buySol|0> [tipSol] [priorityFeeSol]');
const wallet = readKey(keyfile);
const owner = wallet.publicKey.toBase58();
const tipSol = Number(tipArg ?? 0.001);
const priorityFeeSol = Number(prioArg ?? 0.0002);
const { startBlockhashRefresher } = await import('../src/chain/connection.js');
// As on the server: blockhashes are fetched every 2 s and kept, so a buy can be signed with one that expires soon.
startBlockhashRefresher();
const warmUp = Number(process.env.WARM_UP_SEC ?? 0);
if (warmUp) { console.log(`collecting blockhashes for ${warmUp} s (as a server that has been up for a while)`); await new Promise((r) => setTimeout(r, warmUp * 1000)); }
const ex = new ChainExecutor();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(6);
let problems = 0;
console.log(`live: ${ex.isLive({ live: true })}  sender: ${config.senderUrl}  wallet ${owner.slice(0, 6)}…  tip ${tipSol}  priority fee ${priorityFeeSol}`);

/** The wallet's own SOL balance, read until two reads agree (the RPC's nodes do not all see a new block at once). */
async function settledBalance(): Promise<bigint> {
  let last = -1n;
  for (let i = 0; i < 12; i++) {
    const now = await ex.solBalance(owner).catch(() => -1n);
    if (now >= 0n && now === last) return now;
    last = now;
    await sleep(700);
  }
  return last;
}

async function onChain(signature: string) {
  for (let i = 0; i < 12; i++) {
    const tx = await getTransaction(signature).catch(() => null);
    if (tx) return { slot: tx.slot, fee: BigInt(tx.meta?.fee ?? 0), err: tx.meta?.err ?? null };
    await sleep(800);
  }
  return null;
}

/**
 * One trade through the site's code, then two independent measurements of what it did: the wallet's SOL balance
 * before and after (plain balance reads) and its token balance before and after. With the coin's token account
 * already open, the balance change is exactly what the site should report.
 */
async function step(label: string, side: 'buy' | 'sell', run: () => Promise<Awaited<ReturnType<typeof ex.buy>>>) {
  const solBefore = await settledBalance();
  const tokBefore = await ex.tokenBalance(owner, mint);
  const t0 = Date.now();
  const r = await run();
  if (!r.ok) { problems++; console.log(`${label}: FAILED ${r.error}`); return null; }
  const took = ((r.confirmedAt ?? Date.now()) - t0) / 1000;
  const refined = r.refine ? await r.refine : null;
  const reported = refined ? refined.lamports : r.lamports;
  const chain = await onChain(r.signature);
  const solAfter = await settledBalance();
  const tokAfter = await ex.tokenBalance(owner, mint);
  const solTruth = side === 'buy' ? solBefore - solAfter : solAfter - solBefore;
  const tokTruth = side === 'buy' ? tokAfter - tokBefore : tokBefore - tokAfter;
  console.log(`${label}: confirmed ${took.toFixed(2)}s after the call  sig ${r.signature}`);
  const tokensOk = r.tokens === tokTruth;
  const solOk = reported === solTruth;
  if (!tokensOk || !solOk || !chain || chain.err) problems++;
  console.log(`    slot ${chain?.slot}  network fee ${chain ? sol(chain.fee) : '?'}  err ${JSON.stringify(chain?.err ?? null)}`);
  console.log(`    tokens: reported ${r.tokens}  wallet balance changed by ${tokTruth}  ${tokensOk ? 'MATCH' : 'DIFFERENT'}`);
  console.log(`    SOL:    reported ${sol(reported)}${refined ? ` (first estimate ${sol(r.lamports)})` : ' (estimate only, not refined)'}  wallet balance changed by ${sol(solTruth)}  ${solOk ? 'MATCH' : 'DIFFERENT'}${r.note ? `  note: ${r.note}` : ''}`);
  return r;
}

const base = { wallet, mint, slippagePct: 30, priorityFeeSol, tipSol, live: true, feeBps: 0 };
const buySol = Number(buySolArg ?? 0);
if (buySol > 0) {
  await step(`BUY ${buySol} SOL`, 'buy', () => ex.buy({ ...base, lamports: BigInt(Math.round(buySol * 1e9)) }));
  await sleep(1500);
}
let held = await ex.tokenBalance(owner, mint);
console.log(`holding ${held} tokens`);
if (held > 0n) {
  await step('SELL 40 %', 'sell', () => ex.sell({ ...base, tokens: (held * 40n) / 100n }));
  await sleep(1500);
  held = await ex.tokenBalance(owner, mint);
  await step('SELL everything left', 'sell', () => ex.sell({ ...base, tokens: held }));
  await sleep(1500);
  console.log(`left in the wallet: ${await ex.tokenBalance(owner, mint)} tokens`);
}
console.log(problems ? `\n${problems} PROBLEM(S)` : '\nall fills match the chain');
process.exit(problems ? 1 : 0);
