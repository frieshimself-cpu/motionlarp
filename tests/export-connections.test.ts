// src/export-connections.ts is the one-off tool the server's updater runs to read out a Helius link and Jupiter key
// saved on the admin page in the past. Run here as a real process against a real database file.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encryptText } from '../src/crypto.js';
import { Store } from '../src/store.js';

const MASTER = '5c'.repeat(32);
const RPC = 'https://mainnet.helius-rpc.com/?api-key=9e1b6213-aaaa-bbbb-cccc-1234567890ab';
const TOOL = resolve(__dirname, '../src/export-connections.ts');

function run(dbPath: string, masterKey: string): string {
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', TOOL], { env: { ...process.env, DB_PATH: dbPath, MASTER_KEY: masterKey }, encoding: 'utf8', cwd: resolve(__dirname, '..') });
}

describe('reading saved keys out for the server file', () => {
  it('prints exactly the saved link and key as NAME=value lines, while the app has the database open', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'ml-export-')), 'app.db');
    const store = new Store(db);
    store.setSettings({ rpc_url: encryptText(RPC, 'rpc_url', MASTER), jupiter_api_key: encryptText('jup-key-1234', 'jupiter_api_key', MASTER), fee_bps: '100' });
    expect(run(db, MASTER)).toBe(`RPC_URL=${RPC}\nJUPITER_API_KEY=jup-key-1234\n`);
    store.close();
  });

  it('prints nothing with the wrong master key, with nothing saved, or with no database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-export-'));
    const db = join(dir, 'app.db');
    const store = new Store(db);
    expect(run(db, MASTER)).toBe('');
    store.setSettings({ rpc_url: encryptText(RPC, 'rpc_url', MASTER) });
    store.close();
    expect(run(db, '00'.repeat(32))).toBe('');
    expect(run(join(dir, 'missing.db'), MASTER)).toBe('');
  });

  it('a value that would not survive a KEY=value line as it is (a space, a quote, a $) is left where it is', () => {
    const db = join(mkdtempSync(join(tmpdir(), 'ml-export-')), 'app.db');
    const store = new Store(db);
    store.setSettings({ rpc_url: encryptText(RPC, 'rpc_url', MASTER), jupiter_api_key: encryptText('odd key $HOME', 'jupiter_api_key', MASTER) });
    store.close();
    expect(run(db, MASTER)).toBe(`RPC_URL=${RPC}\n`);
  });
});
