// Everything persistent, in one SQLite file (Node's built-in node:sqlite). Money and token amounts are INTEGER
// lamports / base units, read back as bigint. Wallet keys are stored only as ciphertext (crypto.ts).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CopySettings, SellSettings } from './engine/settings.js';
import type { SellReason } from './engine/rules.js';

export type PositionStatus = 'opening' | 'open' | 'closed' | 'failed';

export interface User { id: number; username: string; passHash: string; createdAt: number; disabled: boolean }
export interface License { id: number; hint: string; label: string; feeBps: number | null; createdAt: number; usedBy: number | null; usedAt: number | null; revoked: boolean; username: string | null }
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
  /** A full exit (their exit, a 100 % stop, dead coin, Sell now's rest) that is owed and not done yet: kept in the
   *  database so a restart cannot forget it (its retry was held in memory only). */
  exitOwed: { reason: SellReason; tag?: string } | null;
  firedTimed: number[];
  firedStop: number[];
  deadFired: boolean;
  refValueLamports: bigint | null;
  lastChangeAt: number;
  /** The sell settings as they were when the position opened (editing a copy changes only new positions). */
  sell: SellSettings;
  copyName: string;
  leader: string;
  /** The coin's decimals (for showing token amounts); 6 on pump.fun. */
  decimals: number;
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
  leader TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 6,
  exit_owed TEXT
);
CREATE INDEX IF NOT EXISTS positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS positions_copy_mint ON positions(copy_id, mint);
CREATE INDEX IF NOT EXISTS positions_user_closed ON positions(user_id, status, closed_at);
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
CREATE INDEX IF NOT EXISTS fills_user ON fills(user_id);
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
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  label TEXT NOT NULL,
  fee_bps INTEGER,
  created_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
    exitOwed: r.exit_owed === null || r.exit_owed === undefined ? null : (JSON.parse(String(r.exit_owed)) as { reason: SellReason; tag?: string }),
    firedTimed: JSON.parse(String(r.fired_timed)) as number[],
    firedStop: JSON.parse(String(r.fired_stop)) as number[],
    deadFired: num(r.dead_fired) === 1,
    refValueLamports: r.ref_value === null ? null : big(r.ref_value),
    lastChangeAt: num(r.last_change_at),
    sell: JSON.parse(String(r.sell)) as SellSettings,
    copyName: String(r.copy_name),
    leader: String(r.leader),
    decimals: r.decimals === undefined || r.decimals === null ? 6 : num(r.decimals),
  };
}

function toFill(r: Row): Fill {
  return {
    id: num(r.id), positionId: num(r.position_id), userId: num(r.user_id), side: r.side as Fill['side'], reason: r.reason as Fill['reason'],
    tokens: big(r.tokens), lamports: big(r.lamports), signature: (r.signature as string | null) ?? null, simulated: num(r.simulated) === 1,
    error: (r.error as string | null) ?? null, feeLamports: big(r.fee_lamports), createdAt: num(r.created_at),
  };
}

export type PositionPatch = Partial<Pick<Position, 'mode' | 'status' | 'tokensBought' | 'tokensHeld' | 'costLamports' | 'proceedsLamports' | 'openedAt' | 'closedAt' | 'buySig' | 'firedTimed' | 'firedStop' | 'deadFired' | 'refValueLamports' | 'lastChangeAt' | 'exitOwed'>>;

const COLUMN: Record<keyof PositionPatch, string> = {
  mode: 'mode', status: 'status', tokensBought: 'tokens_bought', tokensHeld: 'tokens_held', costLamports: 'cost_lamports', proceedsLamports: 'proceeds_lamports',
  openedAt: 'opened_at', closedAt: 'closed_at', buySig: 'buy_sig', firedTimed: 'fired_timed', firedStop: 'fired_stop', deadFired: 'dead_fired',
  refValueLamports: 'ref_value', lastChangeAt: 'last_change_at', exitOwed: 'exit_owed',
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
    const userCols = this.all('PRAGMA table_info(users)').map((r) => String(r.name));
    if (!userCols.includes('disabled')) this.db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
    const posCols = this.all('PRAGMA table_info(positions)').map((r) => String(r.name));
    if (!posCols.includes('decimals')) this.db.exec('ALTER TABLE positions ADD COLUMN decimals INTEGER NOT NULL DEFAULT 6');
    if (!posCols.includes('exit_owed')) this.db.exec('ALTER TABLE positions ADD COLUMN exit_owed TEXT');
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
  private toUser(r: Row): User {
    return { id: num(r.id), username: String(r.username), passHash: String(r.pass_hash), createdAt: num(r.created_at), disabled: num(r.disabled) === 1 };
  }
  userByName(username: string): User | undefined {
    const r = this.get('SELECT * FROM users WHERE username = ?', username);
    return r && this.toUser(r);
  }
  user(id: number): User | undefined {
    const r = this.get('SELECT * FROM users WHERE id = ?', id);
    return r && this.toUser(r);
  }
  users(): User[] {
    return this.all('SELECT * FROM users ORDER BY id').map((r) => this.toUser(r));
  }
  /** A disabled user cannot log in and gets no new copies; open positions keep their sell rules. */
  setUserDisabled(id: number, disabled: boolean): void {
    this.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
    if (disabled) this.run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  deleteUser(id: number): void {
    this.run('DELETE FROM users WHERE id = ?', id);
  }

  // ── license keys ──────────────────────────────────────────────────────
  createLicense(l: { keyHash: string; hint: string; label: string; feeBps: number | null }): number {
    return this.run('INSERT INTO licenses (key_hash, hint, label, fee_bps, created_at) VALUES (?, ?, ?, ?, ?)', l.keyHash, l.hint, l.label, l.feeBps, Date.now()).lastInsertRowid;
  }
  private toLicense(r: Row): License {
    return {
      id: num(r.id), hint: String(r.hint), label: String(r.label), feeBps: r.fee_bps === null ? null : num(r.fee_bps), createdAt: num(r.created_at),
      usedBy: r.used_by === null ? null : num(r.used_by), usedAt: r.used_at === null ? null : num(r.used_at), revoked: num(r.revoked) === 1,
      username: (r.username as string | null | undefined) ?? null,
    };
  }
  licenses(): License[] {
    return this.all('SELECT l.*, u.username AS username FROM licenses l LEFT JOIN users u ON u.id = l.used_by ORDER BY l.id DESC').map((r) => this.toLicense(r));
  }
  licenseByHash(keyHash: string): License | undefined {
    const r = this.get('SELECT l.*, u.username AS username FROM licenses l LEFT JOIN users u ON u.id = l.used_by WHERE l.key_hash = ?', keyHash);
    return r && this.toLicense(r);
  }
  userLicense(userId: number): License | undefined {
    const r = this.get('SELECT l.*, u.username AS username FROM licenses l LEFT JOIN users u ON u.id = l.used_by WHERE l.used_by = ?', userId);
    return r && this.toLicense(r);
  }
  /** True when this account got the key: a key is redeemed once, and never when revoked. */
  redeemLicense(id: number, userId: number): boolean {
    return this.run('UPDATE licenses SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL AND revoked = 0', userId, Date.now(), id).changes === 1;
  }
  /** A lost key is replaced: same license and account, new key; the old key stops working. */
  /** A new key ends every session opened with the old one: a leaked key must lose its access at once. */
  rekeyLicense(id: number, keyHash: string, hint: string): boolean {
    const ok = this.run('UPDATE licenses SET key_hash = ?, hint = ? WHERE id = ?', keyHash, hint, id).changes === 1;
    if (ok) this.run('DELETE FROM sessions WHERE user_id = (SELECT used_by FROM licenses WHERE id = ?)', id);
    return ok;
  }
  updateLicense(id: number, patch: { label?: string; feeBps?: number | null }): void {
    if (patch.label !== undefined) this.run('UPDATE licenses SET label = ? WHERE id = ?', patch.label, id);
    if (patch.feeBps !== undefined) this.run('UPDATE licenses SET fee_bps = ? WHERE id = ?', patch.feeBps, id);
  }
  /** Revoking a key that is in use disables its user; restoring it re-enables them. */
  setLicenseRevoked(id: number, revoked: boolean): void {
    this.run('UPDATE licenses SET revoked = ? WHERE id = ?', revoked ? 1 : 0, id);
    const r = this.get('SELECT used_by FROM licenses WHERE id = ?', id);
    if (r && r.used_by !== null) this.setUserDisabled(num(r.used_by), revoked);
  }
  deleteLicense(id: number): boolean {
    return this.run('DELETE FROM licenses WHERE id = ? AND used_by IS NULL', id).changes === 1;
  }

  // ── owner settings (set on the admin page; they override the environment) ─
  settings(): Record<string, string> {
    return Object.fromEntries(this.all('SELECT key, value FROM settings').map((r) => [String(r.key), String(r.value)]));
  }
  setSettings(values: Record<string, string>): void {
    for (const [k, v] of Object.entries(values)) this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
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
  sessionExpiry(tokenHash: string): number | null {
    const r = this.get('SELECT expires_at FROM sessions WHERE token_hash = ?', tokenHash);
    return r ? num(r.expires_at) : null;
  }
  extendSession(tokenHash: string, expiresAt: number): void {
    this.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', expiresAt, tokenHash);
  }
  // The owner's admin logins, kept in the database so a restart (an update) does not log the owner out.
  createAdminSession(tokenHash: string, expiresAt: number): void {
    this.run('DELETE FROM admin_sessions WHERE expires_at < ?', Date.now());
    this.run('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)', tokenHash, expiresAt);
  }
  adminSessionValid(tokenHash: string): boolean {
    const r = this.get('SELECT expires_at FROM admin_sessions WHERE token_hash = ?', tokenHash);
    return !!r && num(r.expires_at) > Date.now();
  }
  deleteAdminSession(tokenHash: string): void {
    this.run('DELETE FROM admin_sessions WHERE token_hash = ?', tokenHash);
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
  /** A copy even when it was deleted (its open positions still sell with its own fees and slippage). */
  copyIncludingDeleted(id: number): CopyRow | undefined {
    const r = this.get('SELECT * FROM copies WHERE id = ?', id);
    return r && this.toCopy(r);
  }
  copy(id: number): CopyRow | undefined {
    const r = this.get('SELECT * FROM copies WHERE id = ? AND deleted = 0', id);
    return r && this.toCopy(r);
  }
  copies(userId: number): CopyRow[] {
    return this.all('SELECT * FROM copies WHERE user_id = ? AND deleted = 0 ORDER BY id', userId).map((r) => this.toCopy(r));
  }
  enabledCopiesForLeader(leader: string): CopyRow[] {
    return this.all('SELECT c.* FROM copies c JOIN users u ON u.id = c.user_id WHERE c.leader = ? AND c.enabled = 1 AND c.deleted = 0 AND u.disabled = 0', leader).map((r) => this.toCopy(r));
  }
  /** Every wallet to watch: followed by an enabled copy, or behind an open position ("sell when they sell"
   *  keeps working after a copy is paused or deleted). */
  watchedLeaders(): string[] {
    return this.all("SELECT c.leader FROM copies c JOIN users u ON u.id = c.user_id WHERE c.enabled = 1 AND c.deleted = 0 AND u.disabled = 0 UNION SELECT leader FROM positions WHERE status IN ('opening','open')").map((r) => String(r.leader));
  }

  // ── positions and fills ───────────────────────────────────────────────
  insertPosition(p: { userId: number; copyId: number; mint: string; mode: 'paper' | 'live'; leaderSig: string; sell: SellSettings; copyName: string; leader: string; now: number; decimals?: number }): number {
    return this.run(
      'INSERT INTO positions (user_id, copy_id, mint, mode, status, opened_at, leader_sig, last_change_at, sell, copy_name, leader, decimals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      p.userId, p.copyId, p.mint, p.mode, 'opening', p.now, p.leaderSig, p.now, JSON.stringify(p.sell), p.copyName, p.leader, p.decimals ?? 6,
    ).lastInsertRowid;
  }
  updatePosition(id: number, patch: PositionPatch): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof PositionPatch, unknown][]) {
      if (v === undefined) continue;
      sets.push(`${COLUMN[k]} = ?`);
      values.push(Array.isArray(v) || (v !== null && typeof v === 'object') ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
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
  /** A user's open (or opening) position in a coin, whichever of their copies holds it. */
  activePositionOfUser(userId: number, mint: string): Position | undefined {
    const r = this.get("SELECT * FROM positions WHERE user_id = ? AND mint = ? AND status IN ('opening','open') ORDER BY id DESC LIMIT 1", userId, mint);
    return r && toPosition(r);
  }
  /** The exact SOL of a fill, once read from its confirmed transaction. */
  updateFillLamports(fillId: number, lamports: bigint): void {
    this.run('UPDATE fills SET lamports = ? WHERE id = ?', lamports, fillId);
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
  /**
   * Totals over EVERY closed position of a user in one mode ('live' or 'paper'), and per copy: History's heading and
   * each copy's line (they were sums of the newest 200 / 1,000 rows only, which a busy trader passes in two days).
   */
  closedTotals(userId: number, mode: 'live' | 'paper'): { trades: number; wins: number; pnlLamports: bigint; feesLamports: bigint; byCopy: Map<number, { closed: number; pnlLamports: bigint }> } {
    const byCopy = new Map<number, { closed: number; pnlLamports: bigint }>();
    let trades = 0;
    let wins = 0;
    let pnlLamports = 0n;
    for (const r of this.all(
      `SELECT copy_id, COUNT(*) AS n, SUM(CASE WHEN proceeds_lamports > cost_lamports THEN 1 ELSE 0 END) AS wins,
              SUM(proceeds_lamports - cost_lamports) AS pnl
       FROM positions WHERE user_id = ? AND status = 'closed' AND mode = ? GROUP BY copy_id`, userId, mode)) {
      byCopy.set(num(r.copy_id), { closed: num(r.n), pnlLamports: big(r.pnl) });
      trades += num(r.n);
      wins += num(r.wins);
      pnlLamports += big(r.pnl);
    }
    const fees = this.get(
      `SELECT COALESCE(SUM(f.fee_lamports), 0) AS fees FROM fills f JOIN positions p ON p.id = f.position_id
       WHERE f.user_id = ? AND p.status = 'closed' AND p.mode = ?`, userId, mode);
    return { trades, wins, pnlLamports, feesLamports: big(fees?.fees ?? 0), byCopy };
  }

  /** Closed positions per local day (offset in ms east of UTC) and mode, newest day first. */
  pnlByDay(userId: number, offsetMs: number): { day: number; mode: string; trades: number; wins: number; pnlLamports: bigint }[] {
    return this.all(
      `SELECT (closed_at + CAST(? AS INTEGER)) / 86400000 AS day, mode, COUNT(*) AS trades,
              SUM(CASE WHEN proceeds_lamports > cost_lamports THEN 1 ELSE 0 END) AS wins,
              SUM(proceeds_lamports - cost_lamports) AS pnl
       FROM positions WHERE user_id = ? AND status = 'closed' AND closed_at IS NOT NULL
       GROUP BY day, mode ORDER BY day DESC, mode`,
      offsetMs, userId,
    ).map((r) => ({ day: num(r.day), mode: String(r.mode), trades: num(r.trades), wins: num(r.wins), pnlLamports: big(r.pnl) }));
  }
  insertFill(f: Omit<Fill, 'id' | 'createdAt' | 'feeLamports'> & { feeLamports?: bigint }): number {
    return this.run(
      'INSERT INTO fills (position_id, user_id, side, reason, tokens, lamports, signature, simulated, error, fee_lamports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.positionId, f.userId, f.side, f.reason, f.tokens, f.lamports, f.signature, f.simulated ? 1 : 0, f.error, f.feeLamports ?? 0n, Date.now(),
    ).lastInsertRowid;
  }
  /** Platform fees a user has paid: real ones, and the ones test mode only pretended to. */
  userFees(userId: number): { live: bigint; test: bigint } {
    const r = this.get('SELECT COALESCE(SUM(CASE WHEN simulated = 0 THEN fee_lamports ELSE 0 END), 0) AS live, COALESCE(SUM(CASE WHEN simulated = 1 THEN fee_lamports ELSE 0 END), 0) AS test FROM fills WHERE user_id = ?', userId);
    return { live: big(r?.live), test: big(r?.test) };
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

  /**
   * Keeps the database from growing until the disk is full (a full disk stops every booking): trades seen more than a
   * day ago are forgotten (a restart never replays trades that old: buys older than 20 s are not copied), and each user
   * keeps the newest 5,000 feed lines (History is read from positions and fills, not from the feed).
   */
  prune(now: number): void {
    this.run('DELETE FROM seen WHERE created_at < ?', now - 24 * 3_600_000);
    for (const r of this.all('SELECT user_id, COUNT(*) AS n FROM events GROUP BY user_id HAVING n > 5000')) {
      const edge = this.get('SELECT id FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET 4999', r.user_id);
      if (edge) this.run('DELETE FROM events WHERE user_id = ? AND id < ?', r.user_id, edge.id);
    }
  }
}
