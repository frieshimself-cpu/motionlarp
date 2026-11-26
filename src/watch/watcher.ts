// Follows the copied wallets. Two sources, de-duplicated: a websocket log subscription per wallet (fast) and a
// poll of its latest signatures (catches whatever the socket missed or dropped). Each new signature is fetched
// once, parsed into trades and handed to the engine. The first poll of a wallet only records where to start, so a
// restart never copies old trades.
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { getSignaturesForAddress, getTransaction, type RawTransaction, type SignatureInfo } from '../chain/rpc.js';
import { log, safeErrorMessage } from '../log.js';
import { parseLeaderTrades, PUMP_AMM_PROGRAM, PUMP_PROGRAM, type LeaderTrade } from './parse.js';

export interface WatcherDeps {
  leaders: () => string[];
  onTrade: (t: LeaderTrade) => Promise<void>;
  pollMs: number;
  getSignatures?: (leader: string, until?: string) => Promise<SignatureInfo[]>;
  getTransaction?: (signature: string) => Promise<RawTransaction | null>;
  /** Subscribe to a wallet's transactions (with their logs when known); returns an unsubscribe function. */
  subscribe?: (leader: string, onSignature: (signature: string, logs?: string[]) => void) => () => void;
  fetchRetryMs?: number;
  /** Transaction fetches in flight at once (a very busy wallet must not flood the RPC). */
  maxConcurrentFetches?: number;
}

const SEEN_CAP = 20_000;
const FETCH_TRIES = 6;

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
      id = conn.onLogs(new PublicKey(leader), (l) => { if (!l.err) onSignature(l.signature, l.logs); }, 'confirmed');
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
    this.getSigs = deps.getSignatures ?? ((leader, until) => getSignaturesForAddress(leader, { limit: 50, until }));
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
          if (this.deps.subscribe) this.unsubs.set(leader, this.deps.subscribe(leader, (sig, logs) => this.handle(sig, leader, logs)));
        }
      }
      await Promise.all([...wanted].map((leader) => this.poll(leader)));
      await this.drain();
    } finally {
      this.syncing = false;
    }
  }

  private async poll(leader: string): Promise<void> {
    let sigs: SignatureInfo[];
    const cursor = this.cursors.get(leader);
    try {
      sigs = await this.getSigs(leader, cursor || undefined); // "" = started, wallet had no history
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
  handle(signature: string, leader: string, logs?: string[]): void {
    const key = `${signature}:${leader}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (logs && logs.length && !logs.some((l) => l.includes(PUMP_PROGRAM) || l.includes(PUMP_AMM_PROGRAM))) return;
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

  private async process(signature: string, leader: string): Promise<void> {
    const release = await this.slot();
    let tx: RawTransaction | null = null;
    try {
      tx = await this.fetchTx(signature);
    } finally {
      release();
    }
    if (!tx) return;
    for (const t of parseLeaderTrades(tx, leader)) {
      log.info('leader trade', { leader, side: t.side, mint: t.mint, sol: Number(t.solLamports) / 1e9, signature });
      await this.deps.onTrade(t);
    }
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
