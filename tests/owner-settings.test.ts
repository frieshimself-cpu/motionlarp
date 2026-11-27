import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { encryptText } from '../src/crypto.js';
import { Store } from '../src/store.js';
import { applyStoredSettings, saveOwnerSettings, settingsView, storedConnections, OwnerSettingsError, type MutableConfig } from '../src/owner-settings.js';

const MASTER = '11'.repeat(32);
const WALLET = Keypair.generate().publicKey.toBase58();
const RPC = 'https://mainnet.helius-rpc.com/?api-key=9e1b6213-aaaa-bbbb-cccc-1234567890ab';
const OTHER_RPC = 'https://mainnet.helius-rpc.com/?api-key=77777777-aaaa-bbbb-cccc-00000000ffff';
const checks = { balance: async (a: string) => (a === WALLET ? 5_000_000n : 0n) };

function cfg(): MutableConfig {
  return { rpcUrl: '', rpcWsUrl: '', jupiterUrl: 'https://lite-api.jup.ag', jupiterApiKey: '', feeBps: 0, feeWallet: '', maxSolPerBuy: 0.05, liveTrading: false, masterKey: MASTER };
}
let store: Store;
beforeEach(() => { store = new Store(':memory:'); });
/** What an owner saved on the admin page before the keys moved to the server's file. */
function savedEarlier(rpc = RPC, jup = 'jup-secret-key-9999') {
  store.setSettings({ rpc_url: encryptText(rpc, 'rpc_url', MASTER), jupiter_api_key: encryptText(jup, 'jupiter_api_key', MASTER) });
}

describe('the Helius link and the Jupiter key live in the server\'s file, not on the website', () => {
  it.each([[{ rpcUrl: RPC }], [{ jupiterApiKey: 'some-key' }], [{ rpcUrl: RPC, feePercent: 0 }]])('the website cannot set them: %j is refused and nothing is stored', async (patch) => {
    const c = cfg();
    await expect(saveOwnerSettings(store, c, patch, checks)).rejects.toThrow(OwnerSettingsError);
    await expect(saveOwnerSettings(store, c, patch, checks)).rejects.toThrow(/set on the server/);
    expect(store.settings()).toEqual({});
    expect(c.rpcUrl).toBe('');
  });

  it('the server file wins: a value saved earlier on the admin page never replaces it', () => {
    savedEarlier(OTHER_RPC, 'old-web-key');
    const c = cfg();
    c.rpcUrl = RPC;
    c.jupiterApiKey = 'server-file-key';
    applyStoredSettings(store, c);
    expect(c.rpcUrl).toBe(RPC);
    expect(c.jupiterApiKey).toBe('server-file-key');
    expect(settingsView(c)).toMatchObject({ rpcFrom: 'server', jupiterFrom: 'server' });
  });

  it('values saved earlier on the admin page keep working until they are moved into the file', () => {
    savedEarlier();
    const c = cfg();
    applyStoredSettings(store, c);
    expect(c.rpcUrl).toBe(RPC);
    expect(c.jupiterApiKey).toBe('jup-secret-key-9999');
    expect(settingsView(c)).toMatchObject({ rpcFrom: 'saved', jupiterFrom: 'saved', rpcSet: true, jupiterKeySet: true });
  });

  it('nothing anywhere: both read as not set', () => {
    const c = cfg();
    applyStoredSettings(store, c);
    expect(settingsView(c)).toMatchObject({ rpcFrom: 'none', jupiterFrom: 'none', rpcSet: false, jupiterKeySet: false });
  });

  it('a Jupiter key, wherever it comes from, switches to Jupiter\'s keyed address', () => {
    const fromFile = cfg();
    fromFile.jupiterApiKey = 'server-file-key';
    applyStoredSettings(store, fromFile);
    expect(fromFile.jupiterUrl).toBe('https://api.jup.ag');
    savedEarlier();
    const fromWeb = cfg();
    applyStoredSettings(store, fromWeb);
    expect(fromWeb.jupiterUrl).toBe('https://api.jup.ag');
    const none = cfg();
    applyStoredSettings(new Store(':memory:'), none);
    expect(none.jupiterUrl).toBe('https://lite-api.jup.ag');
  });

  it('the view never shows a key, only the host and its last 4 characters', () => {
    savedEarlier();
    const c = cfg();
    applyStoredSettings(store, c);
    const v = settingsView(c);
    expect(JSON.stringify(v)).not.toContain('9e1b6213');
    expect(JSON.stringify(v)).not.toContain('jup-secret');
    expect(v.rpc).toBe('mainnet.helius-rpc.com (key …90ab)');
  });

  it('what was saved earlier can be read out once, to be written into the server file', () => {
    expect(storedConnections(store, MASTER)).toEqual({});
    savedEarlier();
    expect(storedConnections(store, MASTER)).toEqual({ RPC_URL: RPC, JUPITER_API_KEY: 'jup-secret-key-9999' });
    // a wrong master key reads nothing rather than garbage
    expect(storedConnections(store, '22'.repeat(32))).toEqual({});
  });
});

describe('owner settings', () => {
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

  it('its errors carry their name (the API turns them into a readable 400)', async () => {
    const err = await saveOwnerSettings(store, cfg(), { maxSolPerBuy: 0 }, checks).catch((e) => e);
    expect(err.name).toBe('OwnerSettingsError');
  });

  it('going live needs the Helius link on the server', async () => {
    await expect(saveOwnerSettings(store, cfg(), { liveTrading: true }, checks)).rejects.toThrow(/Helius/i);
  });
});
