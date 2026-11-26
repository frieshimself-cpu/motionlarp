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
import { Watcher, websocketSubscriber } from './watch/watcher.js';

if (!/^[0-9a-fA-F]{64}$/.test(config.masterKey)) {
  console.error('MASTER_KEY is missing or not 64 hex characters. Generate one with: npm run genkey  (and keep it safe: without it the stored wallet keys cannot be read).');
  process.exit(1);
}

const store = new Store(config.dbPath);
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

const engine = new Engine({ store, executor, walletFor, priceMs: config.priceMs, maxSolPerBuy: config.maxSolPerBuy, feeReserveSol: config.feeReserveSol });
const watcher = config.rpcUrl
  ? new Watcher({ leaders: () => store.watchedLeaders(), onTrade: (t) => engine.onLeaderTrade(t), pollMs: config.pollMs, subscribe: websocketSubscriber() })
  : null;

const mode = !config.rpcUrl ? 'offline' : canSendLive() ? 'live' : 'test';
const app = createApp({
  store, engine, executor, masterKey: config.masterKey, signupCode: config.signupCode, secureCookies: config.secureCookies,
  forgetWallet: (id) => keyCache.delete(id),
  serverInfo: () => ({ live: canSendLive(), maxSolPerBuy: config.maxSolPerBuy, watching: watcher?.watching().length ?? 0, mode }),
});

let ticking = false;
const clock = setInterval(() => {
  if (ticking || !config.rpcUrl) return;
  ticking = true;
  engine.tick().catch((err) => log.warn('tick failed', { error: safeErrorMessage(err) })).finally(() => { ticking = false; });
}, 1000);

app.listen(config.port, config.host, () => {
  log.info('motionlarp up', { url: `http://${config.host}:${config.port}`, mode, maxSolPerBuy: config.maxSolPerBuy });
  if (!config.rpcUrl) log.warn('no RPC_URL: the site works but nothing is watched or traded');
  if (config.rpcUrl && !config.liveTrading) log.info('test mode: copies are simulated and filled from live quotes; nothing is sent (LIVE_TRADING=true to go live)');
  startBlockhashRefresher();
  watcher?.start();
});

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  clearInterval(clock);
  watcher?.stop();
  stopBlockhashRefresher();
  app.close();
  await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 20_000))]);
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: safeErrorMessage(err) }));
