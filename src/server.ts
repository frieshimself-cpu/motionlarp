// The process: website + API, the leader watcher, the copy engine's clock. One per server.
import { Keypair } from '@solana/web3.js';
import { canSendLive, laneStats } from './tx/send.js';
import { config } from './config.js';
import { startBlockhashRefresher, stopBlockhashRefresher } from './chain/connection.js';
import { decryptSecret } from './crypto.js';
import { Engine } from './engine/engine.js';
import { ChainExecutor } from './engine/executor.js';
import { createApp } from './http/app.js';
import { log, safeErrorMessage } from './log.js';
import { Store } from './store.js';
import { parseFeeConfig } from './fee.js';
import { checkConnections } from './connections.js';
import { Jupiter } from './venues/jupiter.js';
import { WSOL_MINT } from './watch/parse.js';
import { applyStoredSettings, saveOwnerSettings, settingsView, type OwnerSettingsPatch } from './owner-settings.js';
import { rpc } from './chain/rpc.js';
import { chooseSender, GLOBAL_SENDER, pingRegion } from './tx/sender-region.js';
import { HeliusStream, streamUrlFor } from './watch/helius-stream.js';
import { warmEventDecoder } from './watch/events.js';
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
/** Where the Helius link and the Jupiter key come from (never the values): the server's file, or an earlier save on the admin page. */
const keysNote = () => { const v = settingsView(config); return `helius: ${v.rpcFrom}, jupiter: ${v.jupiterFrom}`; };

const mode = () => (!config.rpcUrl ? 'offline' : canSendLive() ? 'live' : 'test');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** One real quote (0.01 SOL into USDC): throws when Jupiter refuses the key or does not answer. */
async function jupiterProbe(base: string, key: string): Promise<void> {
  await new Jupiter(base, key).quote(WSOL_MINT, USDC, 10_000_000n, 50, 48, false);
}
async function pingGlobalSender(): Promise<number> {
  const t0 = performance.now();
  const res = await fetch('https://sender.helius-rpc.com/ping', { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.text();
  return performance.now() - t0;
}
let senderRegion: string | null = null;
/** A real request to each service the site trades through (the Status page; also run every few minutes). */
let health = 'not checked yet';
async function runChecks() {
  const report = await checkConnections({
    rpcSet: !!config.rpcUrl,
    jupiterKeySet: !!config.jupiterApiKey,
    rpc: () => rpc<number>('getSlot', [{ commitment: 'processed' }]),
    stream: () => (stream ? { ok: /^(live|connected)/.test(stream.status()), note: stream.status() } : null),
    sender: async () => (config.senderUrl === 'off' ? null : { region: senderRegion ?? 'global', ms: senderRegion ? await pingRegion(senderRegion) : await pingGlobalSender() }),
    jupiter: () => jupiterProbe(config.jupiterUrl, config.jupiterApiKey),
  });
  // Names only, never a detail: this line is public (it shows on the site's status).
  health = report.ok ? 'all working' : `needs attention: ${report.checks.filter((c) => !c.ok && !c.optional).map((c) => c.name).join(', ')}`;
  return report;
}
const app = createApp({
  store, engine, executor, masterKey: config.masterKey, secureCookies: config.secureCookies,
  adminPassword: config.adminPassword,
  brand: config.brand,
  owner: {
    view: () => settingsView(config),
    save: (patch) => saveOwnerSettings(store, config, patch as OwnerSettingsPatch, {
      balance: (address) => executor.solBalance(address),
    }),
    connections: runChecks,
    // Docker restarts the container (restart: unless-stopped); in-flight trades finish first.
    restart: () => void shutdown('settings changed'),
  },
  forgetWallet: (id) => keyCache.delete(id),
  trustProxy: config.trustProxy,
  feeBpsFor,
  maxCopiesPerUser: config.maxCopiesPerUser,
  serverInfo: () => ({ version: process.env.COMMIT || 'dev', live: canSendLive(), maxSolPerBuy: config.maxSolPerBuy, watching: watcher?.watching().length ?? 0, mode: mode(), sender: config.senderUrl === GLOBAL_SENDER && autoSender && senderRegion ? 'global (region dropped after failed sends)' : senderNote, feed: feedNote(), keys: keysNote(), health, sends: laneStats.text() }),
});

// Every hour: forget old seen trades and trim each user's feed (the database must never fill the disk).
setInterval(() => { try { store.prune(Date.now()); } catch (err) { log.warn('prune failed', { error: safeErrorMessage(err) }); } }, 3_600_000).unref();

// The database's WAL is copied into it here, every few seconds at a quiet moment, never inside a write a trade waits
// for (the store does not checkpoint by itself: SQLite's own stalled about one write in a thousand by ~10 ms). While a
// buy or a sell is under way it waits, at most a minute.
let checkpointedAt = Date.now();
setInterval(() => {
  if (engine.quietness() === 'trading' && Date.now() - checkpointedAt < 60_000) return;
  try {
    store.checkpoint();
    checkpointedAt = Date.now();
  } catch (err) {
    log.warn('checkpoint failed', { error: safeErrorMessage(err) });
  }
}, 5_000).unref();

// Five times a second, so a timed sell goes out within 0.2 s of its time. Ticks may overlap: the engine runs one
// price check per position at a time, and timed sells fire
// without waiting for any price check.
const clock = setInterval(() => {
  if (!config.rpcUrl) return;
  engine.tick().catch((err) => log.warn('tick failed', { error: safeErrorMessage(err) }));
}, 200);

// The copy path never waits for a read: pump.fun's fee tables are read now (then renewed in the background), and the
// SOL balance of every wallet that may buy is renewed every 3 s.
if (config.rpcUrl) {
  // ...and the copy path itself runs once on a made-up coin (nothing is sent), so the first copy after a start does
  // not wait for its code to load.
  warmEventDecoder();
  void executor.pf.curve.warmGlobals().then(() => executor.warmCopyPath()).catch((err) => log.warn('copy path warm-up failed', { error: safeErrorMessage(err) }));
  let renewing = false;
  setInterval(() => {
    if (renewing) return;
    renewing = true;
    void engine.keepBalancesFresh().catch(() => undefined).finally(() => { renewing = false; });
  }, 3_000).unref();
}

// Safety nets: settle buys interrupted by a restart, and sell coins whose followed wallet already left.
let reconciling = false;
const safety = setInterval(() => {
  if (reconciling || !config.rpcUrl) return;
  reconciling = true;
  Promise.all([engine.restore(), engine.reconcile()]).catch((err) => log.warn('safety check failed', { error: safeErrorMessage(err) })).finally(() => { reconciling = false; });
}, 30_000);
// A sell left by the process before (a crash, or a restart while its outcome was unknown) holds its position's rules
// and Sell now until it is settled: read again every 5 s, so it is booked, or dropped once its blockhash has run out
// (about a minute after it was signed), within seconds rather than on the next 30 s pass.
const leftovers = setInterval(() => {
  if (!config.rpcUrl || !engine.awaitingLeftovers()) return;
  void engine.settleLeftovers().catch((err) => log.warn('settling a sell from before the restart failed', { error: safeErrorMessage(err) }));
}, 5_000);

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
/** The owner did not pin a Sender address: the nearest region is measured and used. */
const autoSender = config.senderUrl === GLOBAL_SENDER;
async function pickSender(): Promise<void> {
  if (!config.rpcUrl || !autoSender) return;
  const nearest = await chooseSender().catch(() => null);
  if (nearest) {
    config.senderUrl = nearest.url;
    senderRegion = nearest.region;
    senderNote = `${nearest.region} (${nearest.ms} ms)`;
  } else {
    config.senderUrl = GLOBAL_SENDER;
    senderRegion = null;
    senderNote = 'global';
  }
}
// Measured in the background: watching and trading start at once (a trade meanwhile goes through the global address,
// which Helius routes to a region itself), so a restart for an update is a gap of seconds.
void pickSender().catch(() => undefined).then(() => { if (autoSender && config.rpcUrl) log.info('helius sender', { endpoint: senderNote }); });
if (autoSender && config.rpcUrl) {
  // Kept warm: an idle connection would cost a handshake on the next trade.
  setInterval(() => { if (senderRegion) void pingRegion(senderRegion).catch(() => undefined); }, 5_000).unref();
  // Measured again every five minutes: a region that went slow, or was dropped after failed sends, is replaced.
  setInterval(() => void pickSender().catch(() => undefined), 300_000).unref();
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
  // Every connection is tested shortly after start and every five minutes after.
  setTimeout(() => void runChecks().catch(() => undefined), 6_000);
  setInterval(() => void runChecks().catch(() => undefined), 300_000).unref();
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  clearInterval(safety);
  clearInterval(leftovers);
  // No new copies from here on.
  watcher?.stop();
  stream?.stop();
  // A short timed exit that is in progress (or a buy in flight, whose exit starts right after) finishes first:
  // the clock keeps ticking so its steps still go out on time. An update never restarts the server under it.
  const until = Date.now() + 40_000;
  while (Date.now() < until && engine.exitsDueWithin(15_000)) await new Promise((r) => setTimeout(r, 200));
  clearInterval(clock);
  engine.stop();
  app.close();
  // Sells and buys still in flight get up to 100 s to confirm (restore() settles anything cut off). Docker allows
  // 150 s in all (stop_grace_period).
  await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 100_000))]);
  // The exact SOL of the last trades is read from their transactions (a few seconds); one cut off is read by the
  // safety pass after the restart (the fill says it is still an estimate).
  await Promise.race([engine.refined(), new Promise((r) => setTimeout(r, 5_000))]);
  stopBlockhashRefresher();
  try { store.checkpoint(); } catch { /* SQLite checkpoints at the close too */ }
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: safeErrorMessage(err) }));
