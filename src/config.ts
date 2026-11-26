// Runtime configuration. Every knob is an environment variable; nothing here comes from a browser.
import 'dotenv/config';

export type ExecutionMode = 'offline' | 'simulate' | 'live';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function load() {
  return {
    port: num('PORT', 3000),
    host: str('HOST', '127.0.0.1'),
    /** Behind a reverse proxy (Caddy): take the visitor's IP from X-Forwarded-For for rate limits. */
    trustProxy: bool('TRUST_PROXY', false),
    maxCopiesPerUser: num('MAX_COPIES_PER_USER', 20),
    /** Simulate live transactions before sending. Off by default: it costs a round trip (~0.2–0.5 s) per trade. */
    simulateLive: bool('SIMULATE_LIVE', false),
    /** Behind HTTPS (production): session cookies get the Secure flag. */
    secureCookies: bool('SECURE_COOKIES', false),

    rpcUrl: str('RPC_URL'),
    /** Websocket endpoint; derived from RPC_URL (https → wss) when empty. */
    rpcWsUrl: str('RPC_WS_URL'),
    jitoUrl: str('JITO_URL', 'https://frankfurt.mainnet.block-engine.jito.wtf'),
    /** Jupiter routes every coin the native pump.fun / PumpSwap path does not cover. The free endpoint is
     *  rate-limited; with a key from portal.jup.ag use https://api.jup.ag and set JUPITER_API_KEY. */
    jupiterUrl: str('JUPITER_URL', 'https://lite-api.jup.ag'),
    jupiterApiKey: str('JUPITER_API_KEY'),

    // Nothing goes on-chain unless LIVE_TRADING=true AND the copy is set to live. The gate is in src/tx/send.ts.
    liveTrading: bool('LIVE_TRADING', false),
    maxSolPerBuy: num('MAX_SOL_PER_BUY', 0.05),

    /** Platform fee on every copy buy and sell, in basis points (100 = 1 %), paid to FEE_WALLET. 0 = off. */
    feeBps: num('FEE_BPS', 0),
    feeWallet: str('FEE_WALLET'),
    /** Usernames that pay no platform fee (comma-separated), e.g. the owner. */
    feeExemptUsers: str('FEE_EXEMPT_USERS').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean),
    /** 32 bytes as 64 hex characters: encrypts the wallet keys at rest. */
    masterKey: str('MASTER_KEY'),
    /** Opens the admin area (/admin): license keys, users, settings. Empty = closed. */
    adminPassword: str('ADMIN_PASSWORD'),
    brand: str('BRAND_NAME', 'WalletMotion'),
    dbPath: str('DB_PATH', './data/motionlarp.db'),
    logLevel: str('LOG_LEVEL', 'info'),

    computeUnitLimit: num('COMPUTE_UNIT_LIMIT', 300_000),
    confirmTimeoutMs: num('CONFIRM_TIMEOUT_MS', 45_000),
    blockhashRefreshMs: num('BLOCKHASH_REFRESH_MS', 2_000),
    /** How often each leader is also polled, in case the websocket missed a transaction. */
    pollMs: num('POLL_MS', 4_000),
    /** How often open positions are re-quoted (stop loss, dead coin). */
    priceMs: num('PRICE_MS', 2_000),
    /** SOL kept back in the wallet for fees: a buy that would leave less is skipped. */
    feeReserveSol: num('FEE_RESERVE_SOL', 0.01),
  };
}

export const config = load();
export type Config = typeof config;

/** For tests: re-read the environment into the shared config object. */
export function reloadConfig(): void {
  Object.assign(config, load());
}

/** 'simulate' is the server-wide test mode; a copy additionally has to be set to live. */
export function executionMode(): ExecutionMode {
  if (!config.rpcUrl) return 'offline';
  return config.liveTrading ? 'live' : 'simulate';
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol < 0) throw new Error(`invalid SOL amount ${sol}`);
  return BigInt(Math.round(sol * 1e9));
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}
