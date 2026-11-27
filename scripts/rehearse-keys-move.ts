// Rehearsal of the one-time move on a server whose owner typed the Helius link and the Jupiter key into the admin
// page in the past: makes a database holding such saved values (made-up ones) next to a .env without them, the
// way that server looks before the update. Usage: tsx scripts/rehearse-keys-move.ts <folder>
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encryptText } from '../src/crypto.js';
import { Store } from '../src/store.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: tsx scripts/rehearse-keys-move.ts <folder>');
mkdirSync(dir, { recursive: true });
const master = randomBytes(32).toString('hex');
const store = new Store(join(dir, 'app.db'));
store.setSettings({
  rpc_url: encryptText('https://api.mainnet-beta.solana.com/?api-key=rehearsal-0000-1111', 'rpc_url', master),
  jupiter_api_key: encryptText('rehearsal-jupiter-key-2222', 'jupiter_api_key', master),
});
store.close();
writeFileSync(join(dir, '.env'), `DOMAIN=rehearsal.example\nADMIN_PASSWORD=rehearsal-admin-pw\nMASTER_KEY=${master}\nPORT=4518\nDB_PATH=${join(dir, 'app.db')}\nLOG_LEVEL=info\n`, { mode: 0o600 });
console.log('made', dir);
