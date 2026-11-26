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

    // Nothing goes on-chain unless LIVE_TRADING=true AND the copy is set to live. The gate is in src/tx/send.ts.
    liveTrading: bool('LIVE_TRADING', false),
    maxSolPerBuy: num('MAX_SOL_PER_BUY', 0.05),

    /** 32 bytes as 64 hex characters: encrypts the wallet keys at rest. */
    masterKey: str('MASTER_KEY'),
    /** Required to sign up when set. */
    signupCode: str('SIGNUP_CODE'),
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
