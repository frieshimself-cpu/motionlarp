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
import { applyStoredSettings, saveOwnerSettings, settingsView, type OwnerSettingsPatch } from './owner-settings.js';
import { rpc } from './chain/rpc.js';
import { chooseSender, GLOBAL_SENDER, pingRegion } from './tx/sender-region.js';
import { HeliusStream, streamUrlFor } from './watch/helius-stream.js';
import { Watcher, websocketSubscriber } from './watch/watcher.js';

if (!/^[0-9a-fA-F]{64}$/.test(config.masterKey)) {
  console.error('MASTER_KEY is missing or not 64 hex characters. Generate one with: npm run genkey  (and keep it safe: without it the stored wallet keys cannot be read).');
  process.exit(1);
}

const store = new Store(config.dbPath);
// What the owner saved on the admin page overrides the environment (the RPC link, fee, live switch, …).
applyStoredSettings(store, config);
try {
  parseFeeConfig({ bps: config.feeBps, wallet: config.feeWallet });
} catch (err) {
  // A broken fee setting must not keep the site down: run without a fee and say so.
  log.error('platform fee disabled', { reason: err instanceof Error ? err.message : String(err) });
  config.feeBps = 0;
}

/** The platform fee a user pays: their license's own fee if it has one, else the site's; exempt usernames pay none. */
function feeBpsFor(userId: number): number {
  if (!config.feeWallet) return 0;
  const name = store.user(userId)?.username.toLowerCase();
  if (name && config.feeExemptUsers.includes(name)) return 0;
  return store.userLicense(userId)?.feeBps ?? config.feeBps;
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

const engine = new Engine({ store, executor, walletFor, priceMs: config.priceMs, maxSolPerBuy: () => config.maxSolPerBuy, feeReserveSol: config.feeReserveSol, feeBpsFor });
// With a Helius link, copied wallets' transactions also arrive in full on Helius's stream (no fetch needed); the
// standard subscription and the poll stay on as its backup. HELIUS_STREAM=off switches the stream off.
const streamUrl = process.env.HELIUS_STREAM === 'off' ? null : streamUrlFor(config.rpcUrl);
let stream: HeliusStream | null = null;
const watcher: Watcher | null = config.rpcUrl
  ? new Watcher({
      leaders: () => store.watchedLeaders(), onTrade: (t) => engine.onLeaderTrade(t), pollMs: config.pollMs, subscribe: websocketSubscriber(),
      valueInSol: (mint, amount) => executor.valueInSol(mint, amount), streamHealthy: () => stream?.healthy() ?? false,
    })
  : null;
if (watcher && streamUrl) {
  stream = new HeliusStream({ url: streamUrl, leaders: () => store.watchedLeaders(), onTransaction: (tx) => watcher.handleStreamTx(tx) });
}
const feedNote = () => (stream ? `Helius stream ${stream.status()}` : 'standard');

const mode = () => (!config.rpcUrl ? 'offline' : canSendLive() ? 'live' : 'test');
const app = createApp({
  store, engine, executor, masterKey: config.masterKey, secureCookies: config.secureCookies,
  adminPassword: config.adminPassword,
  brand: config.brand,
  owner: {
    view: () => settingsView(config),
    save: (patch) => saveOwnerSettings(store, config, patch as OwnerSettingsPatch, {
      testRpc: async (url) => { await rpc<number>('getSlot', [], url); },
      balance: (address) => executor.solBalance(address),
    }),
    // Docker restarts the container (restart: unless-stopped); in-flight trades finish first.
    restart: () => void shutdown('settings changed'),
  },
  forgetWallet: (id) => keyCache.delete(id),
  trustProxy: config.trustProxy,
  feeBpsFor,
  maxCopiesPerUser: config.maxCopiesPerUser,
  serverInfo: () => ({ live: canSendLive(), maxSolPerBuy: config.maxSolPerBuy, watching: watcher?.watching().length ?? 0, mode: mode(), sender: senderNote, feed: feedNote() }),
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

// A fee transfer into an empty wallet fails (below the rent minimum) and takes the trade with it: without a funded
// fee wallet the fee is switched off, loudly, rather than breaking every trade.
if (config.feeBps > 0 && config.rpcUrl) {
  try {
    const bal = await executor.solBalance(config.feeWallet);
    if (bal < 1_000_000n) {
      log.error('platform fee disabled: FEE_WALLET holds under 0.001 SOL. Fund it, then save the fee again on the admin page.', { feeWallet: config.feeWallet });
      config.feeBps = 0;
    }
  } catch (err) {
    log.warn('could not check the FEE_WALLET balance', { error: safeErrorMessage(err) });
  }
}

// Tipped trades go through the Helius Sender region nearest this server; its connection is kept warm.
let senderNote = config.senderUrl === 'off' ? 'off' : 'global';
if (config.rpcUrl && config.senderUrl === GLOBAL_SENDER) {
  const nearest = await chooseSender().catch(() => null);
  if (nearest) {
    config.senderUrl = nearest.url;
    senderNote = `${nearest.region} (${nearest.ms} ms)`;
    const warm = setInterval(() => void pingRegion(nearest.region).catch(() => undefined), 20_000);
    warm.unref();
  }
  log.info('helius sender', { endpoint: senderNote });
}

app.listen(config.port, config.host, () => {
  log.info('motionlarp up', { url: `http://${config.host}:${config.port}`, mode: mode(), maxSolPerBuy: config.maxSolPerBuy, feeBps: config.feeBps, admin: config.adminPassword ? 'on' : 'off (no ADMIN_PASSWORD)' });
  if (!config.rpcUrl) log.warn('no RPC link yet: the site works but nothing is watched or traded (add it at /admin)');
  if (config.rpcUrl && !config.liveTrading) log.info('test mode: copies are simulated and filled from live quotes; nothing is sent (the owner turns live trading on at /admin)');
  startBlockhashRefresher();
  watcher?.start();
  if (stream) {
    const s = stream;
    s.start();
    // A copy added or removed changes the wallet list: the subscription follows within two seconds.
    setInterval(() => s.sync(), 2_000).unref();
  }
  if (config.rpcUrl) setTimeout(() => void engine.restore().catch(() => undefined), 3_000);
});

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  clearInterval(clock);
  clearInterval(safety);
  watcher?.stop();
  stream?.stop();
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
