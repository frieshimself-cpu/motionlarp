// Run once on the server by deploy/keys-to-env.sh (never by the website): prints the Helius link and the Jupiter key
// an owner saved on the admin page in the past, as RPC_URL=… / JUPITER_API_KEY=… lines, so that script can write
// them into the server's .env file, where they now live. Reads the database read-only; prints nothing else.
// Only someone who already holds the server (root, the database and MASTER_KEY) can run it.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { storedConnections } from './owner-settings.js';

/** Values that are safe to put on a KEY=value line as they are (a link or a key; no spaces, quotes, $ or #). */
const SAFE = /^[A-Za-z0-9:/?&=._~%+@,-]+$/;

const dbPath = process.env.DB_PATH || './data/motionlarp.db';
const masterKey = process.env.MASTER_KEY ?? '';
if (existsSync(dbPath) && /^[0-9a-fA-F]{64}$/.test(masterKey)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const saved = storedConnections({ settings: () => Object.fromEntries(rows.map((r) => [String(r.key), String(r.value)])) }, masterKey);
    for (const [name, value] of Object.entries(saved)) {
      if (value && SAFE.test(value)) process.stdout.write(`${name}=${value}\n`);
    }
  } catch {
    // no settings table yet, or a database in use: nothing to move
  } finally {
    db.close();
  }
}
