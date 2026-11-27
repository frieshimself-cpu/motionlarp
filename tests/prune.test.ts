// From the review of running unattended (27 Nov 2026): nothing was ever pruned, and a full disk stops every booking.
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

describe('keeping the database small', () => {
  it('trades seen more than a day ago are forgotten (a restart never replays trades that old); newer ones are kept', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    expect(store.markSeen('old')).toBe(true);
    (store as unknown as { run: (sql: string, ...a: unknown[]) => unknown }).run("UPDATE seen SET created_at = ? WHERE key = 'old'", now - 25 * 3_600_000);
    expect(store.markSeen('new')).toBe(true);
    store.prune(now);
    expect(store.markSeen('old')).toBe(true); // forgotten: seen again as new
    expect(store.markSeen('new')).toBe(false); // still known
  });

  it('each user keeps the newest feed lines (5,000), older ones are deleted', () => {
    const store = new Store(':memory:');
    const uid = store.createUser('u', 'x');
    for (let i = 0; i < 5_010; i++) store.addEvent({ userId: uid, copyId: null, kind: 'info', message: `line ${i}` });
    store.prune(Date.now());
    const lines = (store as unknown as { all: (sql: string, ...a: unknown[]) => { message: string }[] }).all('SELECT message FROM events WHERE user_id = ? ORDER BY id', uid);
    expect(lines).toHaveLength(5_000);
    expect(lines[0]!.message).toBe('line 10');
    expect(lines.at(-1)!.message).toBe('line 5009');
  });

  it('the admin page\'s per-user figures have indexes (they were full scans on every 5 s reload)', () => {
    const store = new Store(':memory:');
    const names = (store as unknown as { all: (sql: string) => { name: string }[] }).all("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['positions_user_closed', 'fills_user']));
  });
});
