// How far behind a leader would our copy be? Watches real pump.fun buys on mainnet (websocket, 'processed'),
// and for each one measures: slots between the buy and our hearing of it, and the time to resolve the coin and
// build our buy transaction (what happens before the send). Sends nothing.
// Usage: RPC_URL=<rpc> [RPC_WS_URL=<ws>] npm run measure -- [count]
process.env.RPC_URL ||= 'https://api.mainnet-beta.solana.com';
const { Connection, PublicKey, Keypair } = await import('@solana/web3.js');
const { config } = await import('../src/config.js');
const { getConnection, refreshBlockhash } = await import('../src/chain/connection.js');
const { fastBuysFromLogs } = await import('../src/watch/events.js');
const { PUMP_PROGRAM } = await import('../src/watch/parse.js');
const { wsUrlFor } = await import('../src/watch/watcher.js');
const { PfDispatcher } = await import('../src/venues/pf.js');
const { buildSignedTx } = await import('../src/tx/build.js');

const want = Number(process.argv[2] ?? 8);
const conn = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: config.rpcWsUrl || wsUrlFor(config.rpcUrl) });
const rpc = getConnection();
const pf = new PfDispatcher();
await refreshBlockhash();
const results: { hearSlots: number; buildMs: number }[] = [];
let busy = false;
const id = conn.onLogs(new PublicKey(PUMP_PROGRAM), async (l, ctx) => {
  if (busy || l.err || results.length >= want) return;
  const heardAt = Date.now();
  // any buyer works as a stand-in leader: decode the first buy in these logs
  const user = l.logs.length ? null : null;
  const anyBuy = (() => {
    for (const line of l.logs) if (line.startsWith('Program data: ')) return line;
    return null;
  })();
  if (!anyBuy) return;
  busy = true;
  try {
    const { pumpSdk } = await import('../src/venues/sdk.js');
    const ev = pumpSdk.getPumpProgram(new Connection('http://127.0.0.1:1')).coder.events.decode(anyBuy.slice(14)) as { name: string; data: { user: { toBase58(): string }; isBuy: boolean } } | null;
    if (!ev || ev.name !== 'tradeEvent' || !ev.data.isBuy) return;
    const leader = ev.data.user.toBase58();
    const [t] = fastBuysFromLogs(l.logs, l.signature, leader, ctx.slot) ?? [];
    if (!t) return;
    const slotNow = await rpc.getSlot('processed');
    const t0 = Date.now();
    const pool = await pf.resolve(t.mint);
    const built = await pf.venueFor(pool).buildBuy({ pool, user: new PublicKey(leader), lamportsIn: 10_000_000n, slippagePct: 25 });
    await buildSignedTx({ signer: Keypair.generate(), instructions: built.instructions, validatorTipSol: 0.001, txFeeSol: 0 });
    const buildMs = Date.now() - t0;
    results.push({ hearSlots: slotNow - ctx.slot, buildMs });
    console.log(`buy in slot ${ctx.slot}: heard ${slotNow - ctx.slot} slot(s) later (slot read took ${t0 - heardAt} ms), resolve+build ${buildMs} ms`);
  } catch (err) {
    console.log('skip:', err instanceof Error ? err.message.slice(0, 80) : err);
  } finally {
    busy = false;
  }
  if (results.length >= want) {
    await conn.removeOnLogsListener(id);
    const avg = (k: 'hearSlots' | 'buildMs') => results.reduce((a, r) => a + r[k], 0) / results.length;
    console.log(`\naverage: heard ${avg('hearSlots').toFixed(1)} slots after the buy; resolve+build ${avg('buildMs').toFixed(0)} ms (1 slot ≈ 400 ms)`);
    process.exit(0);
  }
}, 'processed');
setTimeout(() => { console.log('timed out'); process.exit(1); }, 120_000);
