// Everything persistent, in one SQLite file (Node's built-in node:sqlite). Money and token amounts are INTEGER
// lamports / base units, read back as bigint. Wallet keys are stored only as ciphertext (crypto.ts).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CopySettings, SellSettings } from './engine/settings.js';
import type { SellReason } from './engine/rules.js';

export type PositionStatus = 'opening' | 'open' | 'closed' | 'failed';

export interface User { id: number; username: string; passHash: string; createdAt: number }
export interface WalletRow { userId: number; pubkey: string; encKey: string; createdAt: number }
export interface CopyRow { id: number; userId: number; settings: CopySettings; createdAt: number; updatedAt: number }

export interface Position {
  id: number;
  userId: number;
  copyId: number;
  mint: string;
  mode: 'paper' | 'live';
  status: PositionStatus;
  tokensBought: bigint;
  tokensHeld: bigint;
  costLamports: bigint;
  proceedsLamports: bigint;
  openedAt: number;
  closedAt: number | null;
  leaderSig: string;
  buySig: string | null;
  firedTimed: number[];
  firedStop: number[];
  deadFired: boolean;
  refValueLamports: bigint | null;
  lastChangeAt: number;
  /** The sell settings as they were when the position opened (editing a copy changes only new positions). */
  sell: SellSettings;
  copyName: string;
  leader: string;
}

export interface Fill {
  id: number;
  positionId: number;
  userId: number;
  side: 'buy' | 'sell';
  reason: SellReason | 'copy';
  tokens: bigint;
  lamports: bigint;
  signature: string | null;
  simulated: boolean;
  error: string | null;
  /** Platform fee carried by this fill (lamports). */
  feeLamports: bigint;
  createdAt: number;
}

export type EventKind = 'buy' | 'sell' | 'skip' | 'error' | 'info';
export interface EventRow { id: number; userId: number; copyId: number | null; kind: EventKind; message: string; mint: string | null; signature: string | null; createdAt: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pubkey TEXT NOT NULL,
  enc_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS copies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leader TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  settings TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS copies_leader ON copies(leader, enabled, deleted);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  copy_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  tokens_bought INTEGER NOT NULL DEFAULT 0,
  tokens_held INTEGER NOT NULL DEFAULT 0,
  cost_lamports INTEGER NOT NULL DEFAULT 0,
  proceeds_lamports INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  leader_sig TEXT NOT NULL,
  buy_sig TEXT,
  fired_timed TEXT NOT NULL DEFAULT '[]',
  fired_stop TEXT NOT NULL DEFAULT '[]',
  dead_fired INTEGER NOT NULL DEFAULT 0,
  ref_value INTEGER,
  last_change_at INTEGER NOT NULL,
  sell TEXT NOT NULL,
  copy_name TEXT NOT NULL,
  leader TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS positions_copy_mint ON positions(copy_id, mint);
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  side TEXT NOT NULL,
  reason TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  lamports INTEGER NOT NULL,
  signature TEXT,
  simulated INTEGER NOT NULL,
  error TEXT,
  fee_lamports INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fills_position ON fills(position_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  copy_id INTEGER,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  mint TEXT,
  signature TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, id);
CREATE TABLE IF NOT EXISTS seen (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt((v as number | string | null) ?? 0));
const num = (v: unknown): number => Number(v ?? 0);

function toPosition(r: Row): Position {
  return {
    id: num(r.id),
    userId: num(r.user_id),
    copyId: num(r.copy_id),
    mint: String(r.mint),
    mode: r.mode === 'live' ? 'live' : 'paper',
    status: r.status as PositionStatus,
    tokensBought: big(r.tokens_bought),
    tokensHeld: big(r.tokens_held),
    costLamports: big(r.cost_lamports),
    proceedsLamports: big(r.proceeds_lamports),
    openedAt: num(r.opened_at),
    closedAt: r.closed_at === null ? null : num(r.closed_at),
    leaderSig: String(r.leader_sig),
    buySig: r.buy_sig === null ? null : String(r.buy_sig),
    firedTimed: JSON.parse(String(r.fired_timed)) as number[],
    firedStop: JSON.parse(String(r.fired_stop)) as number[],
    deadFired: num(r.dead_fired) === 1,
    refValueLamports: r.ref_value === null ? null : big(r.ref_value),
    lastChangeAt: num(r.last_change_at),
    sell: JSON.parse(String(r.sell)) as SellSettings,
    copyName: String(r.copy_name),
    leader: String(r.leader),
  };
}

function toFill(r: Row): Fill {
  return {
    id: num(r.id), positionId: num(r.position_id), userId: num(r.user_id), side: r.side as Fill['side'], reason: r.reason as Fill['reason'],
    tokens: big(r.tokens), lamports: big(r.lamports), signature: (r.signature as string | null) ?? null, simulated: num(r.simulated) === 1,
    error: (r.error as string | null) ?? null, feeLamports: big(r.fee_lamports), createdAt: num(r.created_at),
  };
}

export type PositionPatch = Partial<Pick<Position, 'mode' | 'status' | 'tokensBought' | 'tokensHeld' | 'costLamports' | 'proceedsLamports' | 'openedAt' | 'closedAt' | 'buySig' | 'firedTimed' | 'firedStop' | 'deadFired' | 'refValueLamports' | 'lastChangeAt'>>;

const COLUMN: Record<keyof PositionPatch, string> = {
  mode: 'mode', status: 'status', tokensBought: 'tokens_bought', tokensHeld: 'tokens_held', costLamports: 'cost_lamports', proceedsLamports: 'proceeds_lamports',
  openedAt: 'opened_at', closedAt: 'closed_at', buySig: 'buy_sig', firedTimed: 'fired_timed', firedStop: 'fired_stop', deadFired: 'dead_fired',
  refValueLamports: 'ref_value', lastChangeAt: 'last_change_at',
};

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // Migrations for databases created by earlier versions.
    const fillCols = this.all('PRAGMA table_info(fills)').map((r) => String(r.name));
    if (!fillCols.includes('fee_lamports')) this.db.exec('ALTER TABLE fills ADD COLUMN fee_lamports INTEGER NOT NULL DEFAULT 0');
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    const st = this.db.prepare(sql);
    st.setReadBigInts(true);
    return st.all(...(params as never[])) as Row[];
  }
  private get(sql: string, ...params: unknown[]): Row | undefined {
    const st = this.db.prepare(sql);
    st.setReadBigInts(true);
    return st.get(...(params as never[])) as Row | undefined;
  }
  private run(sql: string, ...params: unknown[]): { lastInsertRowid: number; changes: number } {
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  close(): void {
    this.db.close();
  }

  // ── users and sessions ────────────────────────────────────────────────
  createUser(username: string, passHash: string): number {
    return this.run('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)', username, passHash, Date.now()).lastInsertRowid;
  }
  userByName(username: string): User | undefined {
    const r = this.get('SELECT * FROM users WHERE username = ?', username);
    return r && { id: num(r.id), username: String(r.username), passHash: String(r.pass_hash), createdAt: num(r.created_at) };
  }
  user(id: number): User | undefined {
    const r = this.get('SELECT * FROM users WHERE id = ?', id);
    return r && { id: num(r.id), username: String(r.username), passHash: String(r.pass_hash), createdAt: num(r.created_at) };
  }
  createSession(tokenHash: string, userId: number, expiresAt: number): void {
    this.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    this.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', tokenHash, userId, expiresAt);
  }
  sessionUser(tokenHash: string): number | null {
    const r = this.get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', tokenHash);
    if (!r || num(r.expires_at) < Date.now()) return null;
    return num(r.user_id);
  }
  deleteSession(tokenHash: string): void {
    this.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  // ── wallets ───────────────────────────────────────────────────────────
  setWallet(userId: number, pubkey: string, encKey: string): void {
    this.run('INSERT INTO wallets (user_id, pubkey, enc_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET pubkey = excluded.pubkey, enc_key = excluded.enc_key, created_at = excluded.created_at', userId, pubkey, encKey, Date.now());
  }
  wallet(userId: number): WalletRow | undefined {
    const r = this.get('SELECT * FROM wallets WHERE user_id = ?', userId);
    return r && { userId: num(r.user_id), pubkey: String(r.pubkey), encKey: String(r.enc_key), createdAt: num(r.created_at) };
  }
  deleteWallet(userId: number): void {
    this.run('DELETE FROM wallets WHERE user_id = ?', userId);
  }

  // ── copies ────────────────────────────────────────────────────────────
  createCopy(userId: number, s: CopySettings): number {
    const now = Date.now();
    return this.run('INSERT INTO copies (user_id, leader, enabled, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', userId, s.leader, s.enabled ? 1 : 0, JSON.stringify(s), now, now).lastInsertRowid;
  }
  updateCopy(userId: number, id: number, s: CopySettings): boolean {
    return this.run('UPDATE copies SET leader = ?, enabled = ?, settings = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted = 0', s.leader, s.enabled ? 1 : 0, JSON.stringify(s), Date.now(), id, userId).changes === 1;
  }
  /** Soft delete: positions keep their copy's name for the history. */
  deleteCopy(userId: number, id: number): boolean {
    return this.run('UPDATE copies SET deleted = 1, enabled = 0 WHERE id = ? AND user_id = ? AND deleted = 0', id, userId).changes === 1;
  }
  private toCopy(r: Row): CopyRow {
    return { id: num(r.id), userId: num(r.user_id), settings: JSON.parse(String(r.settings)) as CopySettings, createdAt: num(r.created_at), updatedAt: num(r.updated_at) };
  }
  copy(id: number): CopyRow | undefined {
    const r = this.get('SELECT * FROM copies WHERE id = ? AND deleted = 0', id);
    return r && this.toCopy(r);
  }
  copies(userId: number): CopyRow[] {
    return this.all('SELECT * FROM copies WHERE user_id = ? AND deleted = 0 ORDER BY id', userId).map((r) => this.toCopy(r));
  }
  enabledCopiesForLeader(leader: string): CopyRow[] {
    return this.all('SELECT * FROM copies WHERE leader = ? AND enabled = 1 AND deleted = 0', leader).map((r) => this.toCopy(r));
  }
  /** Every wallet to watch: followed by an enabled copy, or behind an open position ("sell when they sell"
   *  keeps working after a copy is paused or deleted). */
  watchedLeaders(): string[] {
    return this.all("SELECT leader FROM copies WHERE enabled = 1 AND deleted = 0 UNION SELECT leader FROM positions WHERE status IN ('opening','open')").map((r) => String(r.leader));
  }

  // ── positions and fills ───────────────────────────────────────────────
  insertPosition(p: { userId: number; copyId: number; mint: string; mode: 'paper' | 'live'; leaderSig: string; sell: SellSettings; copyName: string; leader: string; now: number }): number {
    return this.run(
      'INSERT INTO positions (user_id, copy_id, mint, mode, status, opened_at, leader_sig, last_change_at, sell, copy_name, leader) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      p.userId, p.copyId, p.mint, p.mode, 'opening', p.now, p.leaderSig, p.now, JSON.stringify(p.sell), p.copyName, p.leader,
    ).lastInsertRowid;
  }
  updatePosition(id: number, patch: PositionPatch): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof PositionPatch, unknown][]) {
      if (v === undefined) continue;
      sets.push(`${COLUMN[k]} = ?`);
      values.push(Array.isArray(v) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length) this.run(`UPDATE positions SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
  }
  position(id: number): Position | undefined {
    const r = this.get('SELECT * FROM positions WHERE id = ?', id);
    return r && toPosition(r);
  }
  /** Positions that hold (or are buying) something; all users when userId is omitted. */
  activePositions(userId?: number): Position[] {
    const rows = userId === undefined
      ? this.all("SELECT * FROM positions WHERE status IN ('opening','open') ORDER BY id")
      : this.all("SELECT * FROM positions WHERE status IN ('opening','open') AND user_id = ? ORDER BY id", userId);
    return rows.map(toPosition);
  }
  activePosition(copyId: number, mint: string): Position | undefined {
    const r = this.get("SELECT * FROM positions WHERE copy_id = ? AND mint = ? AND status IN ('opening','open') ORDER BY id DESC LIMIT 1", copyId, mint);
    return r && toPosition(r);
  }
  openingPositions(): Position[] {
    return this.all("SELECT * FROM positions WHERE status = 'opening' ORDER BY id").map(toPosition);
  }
  countCopies(userId: number): number {
    return Number(this.get('SELECT COUNT(*) AS n FROM copies WHERE user_id = ? AND deleted = 0', userId)?.n ?? 0);
  }
  hasTraded(copyId: number, mint: string): boolean {
    return !!this.get("SELECT 1 FROM positions WHERE copy_id = ? AND mint = ? AND status != 'failed' LIMIT 1", copyId, mint);
  }
  closedPositions(userId: number, limit = 100): Position[] {
    return this.all("SELECT * FROM positions WHERE user_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT ?", userId, limit).map(toPosition);
  }
  insertFill(f: Omit<Fill, 'id' | 'createdAt' | 'feeLamports'> & { feeLamports?: bigint }): number {
    return this.run(
      'INSERT INTO fills (position_id, user_id, side, reason, tokens, lamports, signature, simulated, error, fee_lamports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.positionId, f.userId, f.side, f.reason, f.tokens, f.lamports, f.signature, f.simulated ? 1 : 0, f.error, f.feeLamports ?? 0n, Date.now(),
    ).lastInsertRowid;
  }
  fills(positionId: number): Fill[] {
    return this.all('SELECT * FROM fills WHERE position_id = ? ORDER BY id', positionId).map(toFill);
  }

  // ── feed ──────────────────────────────────────────────────────────────
  addEvent(e: { userId: number; copyId?: number | null; kind: EventKind; message: string; mint?: string | null; signature?: string | null }): void {
    this.run('INSERT INTO events (user_id, copy_id, kind, message, mint, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', e.userId, e.copyId ?? null, e.kind, e.message, e.mint ?? null, e.signature ?? null, Date.now());
  }
  events(userId: number, limit = 60): EventRow[] {
    return this.all('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit).map((r) => ({
      id: num(r.id), userId: num(r.user_id), copyId: r.copy_id === null ? null : num(r.copy_id), kind: r.kind as EventKind, message: String(r.message),
      mint: (r.mint as string | null) ?? null, signature: (r.signature as string | null) ?? null, createdAt: num(r.created_at),
    }));
  }

  /** True the first time a key is seen (a leader transaction is acted on once, across restarts). */
  markSeen(key: string): boolean {
    return this.run('INSERT OR IGNORE INTO seen (key, created_at) VALUES (?, ?)', key, Date.now()).changes === 1;
  }
}
