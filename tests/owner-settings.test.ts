import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Store } from '../src/store.js';
import { applyStoredSettings, saveOwnerSettings, settingsView, OwnerSettingsError, type MutableConfig } from '../src/owner-settings.js';

const MASTER = '11'.repeat(32);
const WALLET = Keypair.generate().publicKey.toBase58();
const RPC = 'https://mainnet.helius-rpc.com/?api-key=9e1b6213-aaaa-bbbb-cccc-1234567890ab';
const checks = { testRpc: async (url: string) => { if (url.includes('bad')) throw new Error('unreachable'); }, balance: async (a: string) => (a === WALLET ? 5_000_000n : 0n) };

function cfg(): MutableConfig {
  return { rpcUrl: '', rpcWsUrl: '', jupiterUrl: 'https://lite-api.jup.ag', jupiterApiKey: '', feeBps: 0, feeWallet: '', maxSolPerBuy: 0.05, liveTrading: false, masterKey: MASTER };
}
let store: Store;
beforeEach(() => { store = new Store(':memory:'); });

describe('owner settings', () => {
  it('saving the RPC link tests it, stores it encrypted, and asks for a restart', async () => {
    const c = cfg();
    const r = await saveOwnerSettings(store, c, { rpcUrl: RPC }, checks);
    expect(r.restart).toBe(true);
    expect(JSON.stringify(store.settings())).not.toContain('9e1b6213');
    const fresh = cfg();
    applyStoredSettings(store, fresh);
    expect(fresh.rpcUrl).toBe(RPC);
  });

  it('the view never shows the key, only the host and its last 4 characters', async () => {
    const c = cfg();
    await saveOwnerSettings(store, c, { rpcUrl: RPC, jupiterApiKey: 'jup-secret-key-9999' }, checks);
    applyStoredSettings(store, c);
    const v = settingsView(c);
    expect(JSON.stringify(v)).not.toContain('9e1b6213');
    expect(JSON.stringify(v)).not.toContain('jup-secret');
    expect(v.rpc).toBe('mainnet.helius-rpc.com (key …90ab)');
    expect(v.jupiterKeySet).toBe(true);
  });

  it('fee, max buy and the live switch apply at once, without a restart', async () => {
    const c = cfg();
    c.rpcUrl = RPC;
    const r = await saveOwnerSettings(store, c, { feePercent: 1.5, feeWallet: WALLET, maxSolPerBuy: 0.5, liveTrading: true }, checks);
    expect(r.restart).toBe(false);
    expect(c).toMatchObject({ feeBps: 150, feeWallet: WALLET, maxSolPerBuy: 0.5, liveTrading: true });
    const fresh = cfg();
    applyStoredSettings(store, fresh);
    expect(fresh).toMatchObject({ feeBps: 150, feeWallet: WALLET, maxSolPerBuy: 0.5, liveTrading: true });
  });

  it.each([
    [{ rpcUrl: 'ftp://x' }, /https/],
    [{ rpcUrl: 'https://bad.example' }, /could not reach/i],
    [{ feePercent: 11, feeWallet: WALLET }, /10 %/],
    [{ feePercent: 1, feeWallet: 'nope' }, /wallet address/i],
    [{ feePercent: 1, feeWallet: Keypair.generate().publicKey.toBase58() }, /0\.001 SOL/],
    [{ maxSolPerBuy: 0 }, /max/i],
  ])('refuses %j', async (patch, why) => {
    const c = cfg();
    c.rpcUrl = RPC;
    await expect(saveOwnerSettings(store, c, patch, checks)).rejects.toThrow(OwnerSettingsError);
    await expect(saveOwnerSettings(store, c, patch, checks)).rejects.toThrow(why);
    expect(store.settings()).toEqual({});
  });

  it('going live needs an RPC', async () => {
    await expect(saveOwnerSettings(store, cfg(), { liveTrading: true }, checks)).rejects.toThrow(/Helius/i);
  });
});
