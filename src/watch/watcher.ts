// Follows the copied wallets. Two sources, de-duplicated: a websocket log subscription per wallet (fast) and a
// poll of its latest signatures (catches whatever the socket missed or dropped). Each new signature is fetched
// once, parsed into trades and handed to the engine. The first poll of a wallet only records where to start, so a
// restart never copies old trades.
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { getSignaturesForAddress, getTransaction, type RawTransaction, type SignatureInfo } from '../chain/rpc.js';
import { log, safeErrorMessage } from '../log.js';
import { parseLeaderTrades, PUMP_AMM_PROGRAM, PUMP_PROGRAM, type LeaderTrade } from './parse.js';
import { fastBuysFromLogs } from './events.js';

export interface WatcherDeps {
  leaders: () => string[];
  onTrade: (t: LeaderTrade) => Promise<void>;
  pollMs: number;
  getSignatures?: (leader: string, until?: string, before?: string) => Promise<SignatureInfo[]>;
  getTransaction?: (signature: string) => Promise<RawTransaction | null>;
  /** Subscribe to a wallet's transactions (with their logs when known); returns an unsubscribe function. */
  subscribe?: (leader: string, onSignature: (signature: string, logs?: string[], slot?: number) => void) => () => void;
  fetchRetryMs?: number;
  /** Transaction fetches in flight at once (a very busy wallet must not flood the RPC). */
  maxConcurrentFetches?: number;
}

const SEEN_CAP = 20_000;
const FETCH_TRIES = 6;
const PAGE = 50;
/** After a stall, read back at most this many pages of a busy wallet's history to reach the last one seen. */
const MAX_PAGES = 6;

export function wsUrlFor(rpcUrl: string): string {
  return rpcUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/** Real websocket subscription through @solana/web3.js (it reconnects by itself). */
export function websocketSubscriber(): WatcherDeps['subscribe'] {
  if (!config.rpcUrl) return undefined;
  const conn = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: config.rpcWsUrl || wsUrlFor(config.rpcUrl) });
  return (leader, onSignature) => {
    let id: number | null = null;
    try {
      // 'processed': the earliest the RPC can tell us (about a second before 'confirmed').
      id = conn.onLogs(new PublicKey(leader), (l, ctx) => { if (!l.err) onSignature(l.signature, l.logs, ctx.slot); }, 'processed');
    } catch (err) {
      log.warn('log subscription failed; polling only', { leader, error: safeErrorMessage(err) });
    }
    return () => { if (id !== null) void conn.removeOnLogsListener(id).catch(() => undefined); };
  };
}

export class Watcher {
  private readonly cursors = new Map<string, string | null>();
  private readonly unsubs = new Map<string, () => void>();
  private readonly seen = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  private readonly getSigs: NonNullable<WatcherDeps['getSignatures']>;
  private readonly getTx: NonNullable<WatcherDeps['getTransaction']>;

  constructor(private readonly deps: WatcherDeps) {
    this.getSigs = deps.getSignatures ?? ((leader, until, before) => getSignaturesForAddress(leader, { limit: PAGE, until, before }));
    this.getTx = deps.getTransaction ?? ((s) => getTransaction(s));
  }

  start(): void {
    if (this.timer) return;
    const loop = async () => {
      await this.sync().catch((err) => log.warn('watch cycle failed', { error: safeErrorMessage(err) }));
      this.timer = setTimeout(loop, this.deps.pollMs);
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const u of this.unsubs.values()) u();
    this.unsubs.clear();
  }

  watching(): string[] {
    return [...this.cursors.keys()];
  }

  /** One cycle: reconcile the wallet list, then poll each wallet. */
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const wanted = new Set(this.deps.leaders());
      for (const leader of [...this.cursors.keys()]) {
        if (wanted.has(leader)) continue;
        this.unsubs.get(leader)?.();
        this.unsubs.delete(leader);
        this.cursors.delete(leader);
      }
      for (const leader of wanted) {
        if (!this.cursors.has(leader)) {
          this.cursors.set(leader, null);
          if (this.deps.subscribe) this.unsubs.set(leader, this.deps.subscribe(leader, (sig, logs, slot) => this.handle(sig, leader, logs, slot)));
        }
      }
      await Promise.all([...wanted].map((leader) => this.poll(leader)));
      await this.drain();
    } finally {
      this.syncing = false;
    }
  }

  private async poll(leader: string): Promise<void> {
    const cursor = this.cursors.get(leader);
    let sigs: SignatureInfo[];
    try {
      sigs = await this.getSigs(leader, cursor || undefined); // "" = started, wallet had no history
      // A full page that does not reach the last signature seen: page back so nothing in between is skipped.
      for (let page = 1; cursor && sigs.length >= PAGE * page && page < MAX_PAGES; page++) {
        const older = await this.getSigs(leader, cursor, sigs[sigs.length - 1]!.signature);
        if (!older.length) break;
        sigs = [...sigs, ...older];
      }
    } catch (err) {
      log.warn('signature poll failed', { leader, error: safeErrorMessage(err) });
      return;
    }
    if (!this.cursors.has(leader)) return; // unfollowed meanwhile
    const newest = sigs[0]?.signature;
    if (cursor === null) {
      // First look: remember where we are; mark what exists as seen so the socket does not replay it either.
      for (const s of sigs) this.seen.add(`${s.signature}:${leader}`);
      this.cursors.set(leader, newest ?? '');
      return;
    }
    if (newest) this.cursors.set(leader, newest);
    for (const s of [...sigs].reverse()) {
      if (s.signature === cursor) continue;
      if (s.err) { this.seen.add(`${s.signature}:${leader}`); continue; }
      this.handle(s.signature, leader);
    }
  }

  /** Fetch, parse and pass on one signature, once. Logs that never mention pump.fun / PumpSwap skip the fetch. */
  handle(signature: string, leader: string, logs?: string[], slot?: number): void {
    const key = `${signature}:${leader}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const truncated = logs?.some((l) => /log truncated/i.test(l));
    if (logs && logs.length && !truncated && !logs.some((l) => l.includes(PUMP_PROGRAM) || l.includes(PUMP_AMM_PROGRAM))) return;
    // Fast path: a plain pump.fun buy is copied straight from the logs, no fetch. (The engine's slot check keeps a
    // later sell that was handled first from being undone by this buy.)
    const fast = logs && slot !== undefined ? fastBuysFromLogs(logs, signature, leader, slot) : null;
    if (fast) {
      for (const t of fast) {
        log.info('leader trade', { leader, side: t.side, mint: t.mint, sol: Number(t.solLamports) / 1e9, fast: true, sig: signature.slice(0, 12) });
        const job = this.deps.onTrade(t).catch((err) => log.warn('leader trade failed', { signature, error: safeErrorMessage(err) }));
        this.pending.add(job);
        void job.finally(() => this.pending.delete(job));
      }
      return;
    }
    if (this.seen.size > SEEN_CAP) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
    const job = this.process(signature, leader).catch((err) => log.warn('leader transaction failed', { signature, error: safeErrorMessage(err) }));
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  private active = 0;
  private readonly waiting: (() => void)[] = [];

  private async slot(): Promise<() => void> {
    const max = this.deps.maxConcurrentFetches ?? 6;
    if (this.active >= max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiting.shift()?.();
    };
  }

  /** Per wallet, the previous transaction's hand-off to the engine: trades are passed on in arrival order. */
  private readonly delivery = new Map<string, Promise<void>>();

  private async process(signature: string, leader: string): Promise<void> {
    // Fetch now (in parallel, within the cap) but hand over strictly after this wallet's earlier transactions, so
    // a quick buy-then-sell is never seen as sell-then-buy.
    const fetched = (async () => {
      const release = await this.slot();
      try {
        return await this.fetchTx(signature);
      } finally {
        release();
      }
    })();
    const prev = this.delivery.get(leader) ?? Promise.resolve();
    const mine = prev.then(async () => {
      const tx = await fetched;
      if (!tx) {
        this.seen.delete(`${signature}:${leader}`); // let a later poll try again
        return;
      }
      for (const t of parseLeaderTrades(tx, leader)) {
        log.info('leader trade', { leader, side: t.side, mint: t.mint, sol: Number(t.solLamports) / 1e9, lagMs: t.blockTime ? Date.now() - t.blockTime * 1000 : null, sig: signature.slice(0, 12) });
        await this.deps.onTrade(t);
      }
    });
    const tail = mine.catch(() => undefined);
    this.delivery.set(leader, tail);
    void tail.then(() => { if (this.delivery.get(leader) === tail) this.delivery.delete(leader); });
    await mine;
  }

  private async fetchTx(signature: string): Promise<RawTransaction | null> {
    let tx: RawTransaction | null = null;
    for (let i = 0; i < FETCH_TRIES && !tx; i++) {
      try {
        tx = await this.getTx(signature);
      } catch (err) {
        log.debug('transaction fetch failed', { signature, error: safeErrorMessage(err) });
      }
      if (!tx) await new Promise((r) => setTimeout(r, (this.deps.fetchRetryMs ?? 400) * (i + 1)));
    }
    return tx;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
