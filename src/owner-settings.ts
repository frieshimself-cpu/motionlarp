// What the owner sets on the admin page instead of in a file on the server: the Helius RPC link, the Jupiter key,
// the platform fee and its wallet, the most a buy may spend, and the live switch. Saved in the database (secrets
// encrypted with MASTER_KEY), applied over the environment at start. The RPC link and Jupiter key take effect after
// a restart (the server restarts itself); the rest applies at once.
import { PublicKey } from '@solana/web3.js';
import { decryptText, encryptText } from './crypto.js';
import { MAX_FEE_BPS } from './fee.js';
import type { Store } from './store.js';

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
}

export interface OwnerSettingsPatch {
  rpcUrl?: string;
  jupiterApiKey?: string;
  feePercent?: number;
  feeWallet?: string;
  maxSolPerBuy?: number;
  liveTrading?: boolean;
}

export interface SettingsChecks {
  /** Throws when the RPC link does not answer. */
  testRpc: (url: string) => Promise<void>;
  /** Lamports held by an address. */
  balance: (address: string) => Promise<bigint>;
  /** Throws when Jupiter refuses the key (a real quote is asked with it). */
  testJupiter?: (key: string) => Promise<void>;
}

export class OwnerSettingsError extends Error {
  override name = 'OwnerSettingsError';
}

export function applyStoredSettings(store: Store, config: MutableConfig): void {
  const s = store.settings();
  const secret = (name: string): string | null => {
    if (!s[name]) return null;
    try {
      return decryptText(s[name]!, name, config.masterKey);
    } catch {
      return null; // wrong MASTER_KEY: fall back to the environment rather than crash
    }
  };
  const rpc = secret('rpc_url');
  if (rpc) config.rpcUrl = rpc;
  const jup = secret('jupiter_api_key');
  if (jup) {
    config.jupiterApiKey = jup;
    config.jupiterUrl = 'https://api.jup.ag'; // the keyed endpoint
  }
  if (s.fee_bps !== undefined) config.feeBps = Number(s.fee_bps);
  if (s.fee_wallet !== undefined) config.feeWallet = s.fee_wallet;
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
    jupiterKeySet: !!config.jupiterApiKey,
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
  const toStore: Record<string, string> = {};
  const apply: (() => void)[] = [];
  let restart = false;

  const rpcUrl = patch.rpcUrl?.trim();
  if (rpcUrl) {
    if (!/^https:\/\//.test(rpcUrl)) throw new OwnerSettingsError('the RPC link must start with https://');
    try {
      await checks.testRpc(rpcUrl);
    } catch {
      throw new OwnerSettingsError('could not reach that RPC link: check you copied the whole "RPC URL" from Helius');
    }
    toStore.rpc_url = encryptText(rpcUrl, 'rpc_url', config.masterKey);
    if (rpcUrl !== config.rpcUrl) restart = true;
  }

  const jup = patch.jupiterApiKey?.trim();
  if (jup) {
    if (checks.testJupiter && jup !== config.jupiterApiKey) {
      try {
        await checks.testJupiter(jup);
      } catch {
        throw new OwnerSettingsError('Jupiter did not accept that key: copy the whole key from portal.jup.ag');
      }
    }
    toStore.jupiter_api_key = encryptText(jup, 'jupiter_api_key', config.masterKey);
    if (jup !== config.jupiterApiKey) restart = true;
  }

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
    if (live && !(rpcUrl || config.rpcUrl)) throw new OwnerSettingsError('add your Helius RPC link before going live');
    toStore.live_trading = String(live);
    apply.push(() => { config.liveTrading = live; });
  }

  store.setSettings(toStore);
  for (const f of apply) f();
  return { restart };
}
