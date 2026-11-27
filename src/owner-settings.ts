// What the owner sets on the admin page: the platform fee and its wallet, the most a buy may spend, and the live
// switch. Saved in the database, applied over the environment at start, in force at once.
//
// The Helius RPC link and the Jupiter API key are NOT set on the website: they live in the server's own file
// (.env: RPC_URL and JUPITER_API_KEY), written once on the server and used for every user. The website cannot see
// or change them. Values an owner saved on the admin page before this rule are still read (so nothing breaks) until
// deploy/keys-to-env.sh has moved them into the file; a value in the file always wins.
import { PublicKey } from '@solana/web3.js';
import { decryptText } from './crypto.js';
import { MAX_FEE_BPS } from './fee.js';
import type { Store } from './store.js';

/** Where a connection's value comes from: the server's file, an earlier save on the admin page, or nowhere. */
export type ConnectionSource = 'server' | 'saved' | 'none';

export interface MutableConfig {
  rpcUrl: string;
  rpcWsUrl: string;
  jupiterUrl: string;
  jupiterApiKey: string;
  feeBps: number;
  feeWallet: string;
  maxSolPerBuy: number;
  liveTrading: boolean;
  masterKey: string;
  sources?: { rpc: ConnectionSource; jupiter: ConnectionSource };
}

export interface OwnerSettingsPatch {
  /** Refused: set on the server. */
  rpcUrl?: string;
  /** Refused: set on the server. */
  jupiterApiKey?: string;
  feePercent?: number;
  feeWallet?: string;
  maxSolPerBuy?: number;
  liveTrading?: boolean;
}

export interface SettingsChecks {
  /** Lamports held by an address. */
  balance: (address: string) => Promise<bigint>;
}

export class OwnerSettingsError extends Error {
  override name = 'OwnerSettingsError';
}

/** The most a single buy may spend when the owner has set no limit of their own. */
export const DEFAULT_MAX_SOL_PER_BUY = 30;
const OLD_DEFAULT_MAX_SOL_PER_BUY = 0.05;
const JUPITER_FREE = /lite-api\.jup\.ag/;
const JUPITER_KEYED = 'https://api.jup.ag';

function storedSecret(store: Pick<Store, 'settings'>, name: string, masterKey: string): string | null {
  const raw = store.settings()[name];
  if (!raw) return null;
  try {
    return decryptText(raw, name, masterKey) || null;
  } catch {
    return null; // wrong MASTER_KEY: as if nothing was saved, rather than crash
  }
}

/** The Helius link and Jupiter key saved on the admin page before they moved to the server's file, if any. */
export function storedConnections(store: Pick<Store, 'settings'>, masterKey: string): { RPC_URL?: string; JUPITER_API_KEY?: string } {
  const rpc = storedSecret(store, 'rpc_url', masterKey);
  const jup = storedSecret(store, 'jupiter_api_key', masterKey);
  return { ...(rpc ? { RPC_URL: rpc } : {}), ...(jup ? { JUPITER_API_KEY: jup } : {}) };
}

export function applyStoredSettings(store: Store, config: MutableConfig): void {
  const s = store.settings();
  const saved = storedConnections(store, config.masterKey);
  const sources = { rpc: 'none' as ConnectionSource, jupiter: 'none' as ConnectionSource };
  if (config.rpcUrl) sources.rpc = 'server';
  else if (saved.RPC_URL) {
    config.rpcUrl = saved.RPC_URL;
    sources.rpc = 'saved';
  }
  if (config.jupiterApiKey) sources.jupiter = 'server';
  else if (saved.JUPITER_API_KEY) {
    config.jupiterApiKey = saved.JUPITER_API_KEY;
    sources.jupiter = 'saved';
  }
  // A key belongs to Jupiter's keyed address; the free address is only for running without one.
  if (config.jupiterApiKey && JUPITER_FREE.test(config.jupiterUrl)) config.jupiterUrl = JUPITER_KEYED;
  config.sources = sources;
  if (s.fee_bps !== undefined) config.feeBps = Number(s.fee_bps);
  if (s.fee_wallet !== undefined) config.feeWallet = s.fee_wallet;
  // The most a buy may spend is 30 SOL unless the owner sets another limit. The site's first default was 0.05 SOL,
  // and the admin page saved it along with every other setting: a site still holding that old default moves to 30
  // once (owner's decision, 27 Nov 2026). A limit set after that is kept, whatever it is.
  if (s.max_buy_default !== String(DEFAULT_MAX_SOL_PER_BUY)) {
    if (s.max_sol_per_buy !== undefined && Number(s.max_sol_per_buy) === OLD_DEFAULT_MAX_SOL_PER_BUY) {
      s.max_sol_per_buy = String(DEFAULT_MAX_SOL_PER_BUY);
      store.setSettings({ max_sol_per_buy: s.max_sol_per_buy });
    }
    store.setSettings({ max_buy_default: String(DEFAULT_MAX_SOL_PER_BUY) });
  }
  if (s.max_sol_per_buy !== undefined) config.maxSolPerBuy = Number(s.max_sol_per_buy);
  if (s.live_trading !== undefined) config.liveTrading = s.live_trading === 'true';
}

/** What the admin page shows. Never a key: the RPC is its host and the key's last four characters. */
export function settingsView(config: MutableConfig) {
  let rpc = '';
  if (config.rpcUrl) {
    try {
      const u = new URL(config.rpcUrl);
      const key = u.searchParams.get('api-key') ?? u.pathname.split('/').filter(Boolean).pop() ?? '';
      rpc = key ? `${u.host} (key …${key.slice(-4)})` : u.host;
    } catch {
      rpc = 'set';
    }
  }
  return {
    rpc,
    rpcSet: !!config.rpcUrl,
    rpcFrom: config.rpcUrl ? (config.sources?.rpc ?? 'server') : ('none' as ConnectionSource),
    jupiterKeySet: !!config.jupiterApiKey,
    jupiterFrom: config.jupiterApiKey ? (config.sources?.jupiter ?? 'server') : ('none' as ConnectionSource),
    feePercent: config.feeBps / 100,
    feeWallet: config.feeWallet,
    maxSolPerBuy: config.maxSolPerBuy,
    liveTrading: config.liveTrading,
  };
}

function isAddress(a: string): boolean {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && new PublicKey(a).toBytes().length === 32;
  } catch {
    return false;
  }
}

/** Validates everything first, then saves and applies; nothing is stored when any part is refused. */
export async function saveOwnerSettings(store: Store, config: MutableConfig, patch: OwnerSettingsPatch, checks: SettingsChecks): Promise<{ restart: boolean }> {
  if (patch.rpcUrl !== undefined || patch.jupiterApiKey !== undefined) {
    throw new OwnerSettingsError('the Helius link and the Jupiter key are set on the server, not on the website');
  }
  const toStore: Record<string, string> = {};
  const apply: (() => void)[] = [];

  if (patch.feePercent !== undefined || patch.feeWallet !== undefined) {
    const bps = Math.round((patch.feePercent ?? config.feeBps / 100) * 100);
    const wallet = (patch.feeWallet ?? config.feeWallet).trim();
    if (!(bps >= 0) || bps > MAX_FEE_BPS) throw new OwnerSettingsError(`the fee must be between 0 and ${MAX_FEE_BPS / 100} % (10 % at most)`);
    if (bps > 0) {
      if (!isAddress(wallet)) throw new OwnerSettingsError('the fee wallet must be a Solana wallet address');
      const lamports = await checks.balance(wallet).catch(() => null);
      if (lamports !== null && lamports < 1_000_000n) throw new OwnerSettingsError('the fee wallet must already hold at least 0.001 SOL (a fee paid into an empty wallet makes the trade fail)');
    } else if (wallet && !isAddress(wallet)) {
      throw new OwnerSettingsError('the fee wallet must be a Solana wallet address');
    }
    toStore.fee_bps = String(bps);
    toStore.fee_wallet = wallet;
    apply.push(() => { config.feeBps = bps; config.feeWallet = wallet; });
  }

  if (patch.maxSolPerBuy !== undefined) {
    const max = Number(patch.maxSolPerBuy);
    if (!(max > 0 && max <= 1000)) throw new OwnerSettingsError('the max per buy must be above 0 SOL');
    toStore.max_sol_per_buy = String(max);
    apply.push(() => { config.maxSolPerBuy = max; });
  }

  if (patch.liveTrading !== undefined) {
    const live = !!patch.liveTrading;
    if (live && !config.rpcUrl) throw new OwnerSettingsError('the Helius link is not set on the server yet: live trading needs it');
    toStore.live_trading = String(live);
    apply.push(() => { config.liveTrading = live; });
  }

  store.setSettings(toStore);
  for (const f of apply) f();
  return { restart: false };
}
