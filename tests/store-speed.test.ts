// The database on the copy's path before its send: a statement is prepared once, not on every call (tens of
// microseconds each), and the WAL's checkpoint never runs inside a write a trade waits for (about one write in a
// thousand stalled ~10 ms, up to 46 ms): the server checkpoints on a timer at quiet moments instead.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

describe('the store', () => {
  it('prepares each statement once and reuses it', () => {
    const store = new Store(':memory:');
    const uid = store.createUser('u', 'x');
    const prepare = store.db.prepare.bind(store.db);
    const seen: string[] = [];
    (store.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
    for (let i = 0; i < 5; i++) store.addEvent({ userId: uid, kind: 'info', message: `line ${i}` });
    for (let i = 0; i < 5; i++) store.events(uid);
    expect(seen.filter((s) => s.startsWith('INSERT INTO events'))).toHaveLength(1);
    expect(seen.filter((s) => s.startsWith('SELECT * FROM events'))).toHaveLength(1);
    expect(store.events(uid, 10).map((e) => e.message)).toEqual(['line 4', 'line 3', 'line 2', 'line 1', 'line 0']);
    store.close();
  });

  it('never checkpoints by itself inside a write; checkpoint() does it, and empties the WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-wal-'));
    const store = new Store(join(dir, 'w.db'));
    expect(Number((store.db.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint)).toBe(0);
    const uid = store.createUser('u', 'x');
    for (let i = 0; i < 200; i++) store.addEvent({ userId: uid, kind: 'info', message: `line ${i}` });
    const r = store.checkpoint();
    expect(r.busy).toBe(false);
    expect(r.walPages).toBeGreaterThan(0);
    expect(r.checkpointed).toBe(r.walPages);
    store.close();
  });

  it('the server checkpoints on a timer, skipped while a trade is under way (but at least once a minute), and at shutdown', () => {
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/store\.checkpoint\(\)/);
    expect(src).toMatch(/quietness\(\)\s*===\s*'trading'/);
    const shutdown = src.slice(src.indexOf('async function shutdown'));
    expect(shutdown).toMatch(/store\.checkpoint\(\)/);
  });
});
