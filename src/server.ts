// The process: website + API, the leader watcher, the copy engine's clock. One per server.
import { Keypair } from '@solana/web3.js';
import { canSendLive } from './tx/send.js';
import { config } from './config.js';
import { startBlockhashRefresher, stopBlockhashRefresher } from './chain/connection.js';
import { decryptSecret } from './crypto.js';
import { Engine } from './engine/engine.js';
import { ChainExecutor } from './engine/executor.js';
import { createApp } from './http/app.js';
import { log, safeErrorMessage } from './log.js';
import { Store } from './store.js';
import { parseFeeConfig } from './fee.js';
import { Watcher, websocketSubscriber } from './watch/watcher.js';

if (!/^[0-9a-fA-F]{64}$/.test(config.masterKey)) {
  console.error('MASTER_KEY is missing or not 64 hex characters. Generate one with: npm run genkey  (and keep it safe: without it the stored wallet keys cannot be read).');
  process.exit(1);
}

let fee: { bps: number; wallet: string };
try {
  fee = parseFeeConfig({ bps: config.feeBps, wallet: config.feeWallet });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const store = new Store(config.dbPath);
/** The platform fee a user pays: FEE_BPS, unless their username is in FEE_EXEMPT_USERS. */
function feeBpsFor(userId: number): number {
  if (!fee.bps) return 0;
  const name = store.user(userId)?.username.toLowerCase();
  return name && config.feeExemptUsers.includes(name) ? 0 : fee.bps;
}
const executor = new ChainExecutor();
const keyCache = new Map<number, Keypair>();

function walletFor(userId: number): Keypair | null {
  const hit = keyCache.get(userId);
  if (hit) return hit;
  const row = store.wallet(userId);
  if (!row) return null;
  try {
    const kp = Keypair.fromSecretKey(decryptSecret(row.encKey, userId, config.masterKey));
    keyCache.set(userId, kp);
    return kp;
  } catch (err) {
    log.error('wallet key could not be decrypted', { userId, error: safeErrorMessage(err) });
    return null;
  }
}

const engine = new Engine({ store, executor, walletFor, priceMs: config.priceMs, maxSolPerBuy: config.maxSolPerBuy, feeReserveSol: config.feeReserveSol, feeBpsFor });
const watcher = config.rpcUrl
  ? new Watcher({ leaders: () => store.watchedLeaders(), onTrade: (t) => engine.onLeaderTrade(t), pollMs: config.pollMs, subscribe: websocketSubscriber(), valueInSol: (mint, amount) => executor.valueInSol(mint, amount) })
  : null;

const mode = !config.rpcUrl ? 'offline' : canSendLive() ? 'live' : 'test';
const app = createApp({
  store, engine, executor, masterKey: config.masterKey, signupCode: config.signupCode, secureCookies: config.secureCookies,
  forgetWallet: (id) => keyCache.delete(id),
  trustProxy: config.trustProxy,
  feeBpsFor,
  maxCopiesPerUser: config.maxCopiesPerUser,
  serverInfo: () => ({ live: canSendLive(), maxSolPerBuy: config.maxSolPerBuy, watching: watcher?.watching().length ?? 0, mode }),
});

// Every second. Ticks may overlap: the engine runs one price check per position at a time, and timed sells fire
// without waiting for any price check.
const clock = setInterval(() => {
  if (!config.rpcUrl) return;
  engine.tick().catch((err) => log.warn('tick failed', { error: safeErrorMessage(err) }));
}, 1000);

// Safety nets: settle buys interrupted by a restart, and sell coins whose followed wallet already left.
let reconciling = false;
const safety = setInterval(() => {
  if (reconciling || !config.rpcUrl) return;
  reconciling = true;
  Promise.all([engine.restore(), engine.reconcile()]).catch((err) => log.warn('safety check failed', { error: safeErrorMessage(err) })).finally(() => { reconciling = false; });
}, 30_000);

// A fee transfer smaller than the rent minimum into an empty account makes the whole trade fail: the fee wallet
// must already hold SOL. Checked once at startup (when an RPC is configured).
if (fee.bps > 0 && config.rpcUrl) {
  try {
    const bal = await executor.solBalance(fee.wallet);
    if (bal < 1_000_000n) {
      console.error(`FEE_WALLET holds ${Number(bal) / 1e9} SOL. Send it at least 0.001 SOL first: transfers into an empty wallet fail, and every trade with them.`);
      process.exit(1);
    }
  } catch (err) {
    log.warn('could not check the FEE_WALLET balance', { error: safeErrorMessage(err) });
  }
}

app.listen(config.port, config.host, () => {
  log.info('motionlarp up', { url: `http://${config.host}:${config.port}`, mode, maxSolPerBuy: config.maxSolPerBuy, feeBps: fee.bps, feeExempt: config.feeExemptUsers });
  if (!config.rpcUrl) log.warn('no RPC_URL: the site works but nothing is watched or traded');
  if (config.rpcUrl && !config.liveTrading) log.info('test mode: copies are simulated and filled from live quotes; nothing is sent (LIVE_TRADING=true to go live)');
  startBlockhashRefresher();
  watcher?.start();
  if (config.rpcUrl) setTimeout(() => void engine.restore().catch(() => undefined), 3_000);
});

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  clearInterval(clock);
  clearInterval(safety);
  watcher?.stop();
  stopBlockhashRefresher();
  app.close();
  // Live buys can take a while to confirm: give them up to 2 minutes (restore() settles anything cut off).
  await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 120_000))]);
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: safeErrorMessage(err) }));
