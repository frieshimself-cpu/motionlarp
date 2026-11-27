// ported from velo/src/log.ts
// Redacting logger. Rule 4: secret keys never reach a log, a fixture, an error message, or a crash dump.
// The client sends base58 64-byte secret keys in: wallets[] (buy/sell), private_keys[] (setup/cleanup/close_wsol),
// walletPrivateKey (sniper), payer_key (vault), instantmode.wallets[].privateKey (heartbeat).
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

export const REDACTED = '<REDACTED_SECRET_KEY>';

const SECRET_FIELDS = new Set(['private_keys', 'payer_key', 'walletPrivateKey', 'privateKey', 'secretKey', 'secret_key']);

/**
 * A base58 64-byte secret key encodes to 86–88 characters; a public key to 32–44. A transaction signature is ALSO
 * 64 bytes, and must stay readable (it is how a trade is looked up). The two are told apart exactly: a secret key's
 * second half is the public key of its first half; a signature's is not. Anything key-length that is not exactly a
 * 64-byte non-key (a mangled key, another secret) is treated as a key.
 */
export function looksLikeSecretKey(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 80 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  return !isSignature(value);
}

function isSignature(value: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(value);
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false;
  try {
    const derived = Keypair.fromSeed(bytes.slice(0, 32)).publicKey.toBytes();
    for (let i = 0; i < 32; i++) if (derived[i] !== bytes[32 + i]) return true; // not a key pair: a signature
    return false; // first half derives the second half: a secret key
  } catch {
    return false;
  }
}

export function redact<T>(value: T, key?: string): T {
  if (Array.isArray(value)) {
    if (key === 'private_keys') return value.map(() => REDACTED) as unknown as T;
    // `wallets` carries public keys in wallet_heartbeat but secret keys in buy/sell: decide per element.
    return value.map((v) => (looksLikeSecretKey(v) ? REDACTED : redact(v, key))) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELDS.has(k) && typeof v === 'string') out[k] = REDACTED;
      else if (typeof v === 'string' && looksLikeSecretKey(v)) out[k] = REDACTED;
      else out[k] = redact(v, k);
    }
    return out as T;
  }
  if (looksLikeSecretKey(value)) return REDACTED as unknown as T;
  return value;
}

/** Strip anything key-shaped out of free text (error messages, stack traces). */
export function scrubText(text: string): string {
  return text.replace(/[1-9A-HJ-NP-Za-km-z]{80,90}/g, (m) => (isSignature(m) ? m : REDACTED));
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(config.logLevel as Level) in ORDER ? (config.logLevel as Level) : 'info'];

function emit(level: Level, msg: string, data?: unknown): void {
  if (ORDER[level] < threshold) return;
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, msg: scrubText(msg) };
  if (data !== undefined) line.data = redact(data);
  const text = JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

export const log = {
  debug: (msg: string, data?: unknown) => emit('debug', msg, data),
  info: (msg: string, data?: unknown) => emit('info', msg, data),
  warn: (msg: string, data?: unknown) => emit('warn', msg, data),
  error: (msg: string, data?: unknown) => emit('error', msg, data),
};

/** Error text safe to send back to the client and to log. */
export function safeErrorMessage(err: unknown, max = 200): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubText(raw).slice(0, max);
}

/** Short, plain-words version of an error for the user's feed. */
export function friendlyError(text: string): string {
  if (/429|too many requests|rate limit/i.test(text)) return 'the Solana RPC is busy / rate limiting (a paid RPC fixes this)';
  if (/token-quoted|non-SOL quoted/i.test(text)) return 'this coin trades against another token (e.g. USDC), not SOL — not supported';
  if (/insufficient lamports|insufficient funds/i.test(text)) return 'not enough SOL in the wallet';
  if (/blockhash not found|block height exceeded/i.test(text)) return 'the transaction expired before landing';
  if (/slippage|TooMuchSolRequired|TooLittleSolReceived|ExceededSlippage/i.test(text)) return 'price moved more than your slippage allows';
  if (/BondingCurveComplete|bonding curve is complete/i.test(text)) return 'the coin just moved to PumpSwap (it graduated): retried there';
  if (/not tradable|not_tradable/i.test(text)) return 'Jupiter will not trade this coin (almost no liquidity, flagged, or not listed yet)';
  if (/no routes found|could_not_find_any_route/i.test(text)) return 'no market for this coin yet (Jupiter found no route)';
  if (/NotEnoughTokensToBuy/i.test(text)) return 'not enough coins left on the curve for this buy';
  if (/ComputationalBudgetExceeded|exceeded CUs/i.test(text)) return 'the trade needed more compute than it asked for: retried with more';
  if (/fetch failed|ECONNRESET|ETIMEDOUT|aborted|timeout/i.test(text)) return 'could not reach the Solana RPC';
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
