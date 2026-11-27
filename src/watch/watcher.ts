// Follows the copied wallets. Two sources, de-duplicated: a websocket log subscription per wallet (fast) and a
// poll of its latest signatures (catches whatever the socket missed or dropped). Each new signature is fetched
// once, parsed into trades and handed to the engine. The first poll of a wallet only records where to start, so a
// restart never copies old trades.
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import { getSignaturesForAddress, getTransaction, type RawTransaction, type SignatureInfo } from '../chain/rpc.js';
import { log, safeErrorMessage } from '../log.js';
import { parseLeaderTrades, type LeaderTrade } from './parse.js';
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
  /** SOL value of `amount` of `mint` (for coins bought with a stablecoin or another coin). */
  valueInSol?: (mint: string, amount: bigint) => Promise<bigint>;
  /** Transaction fetches in flight at once (a very busy wallet must not flood the RPC). */
  maxConcurrentFetches?: number;
  /** True while the Helius transaction stream is delivering full transactions (see handleStreamTx). */
  streamHealthy?: () => boolean;
  /** How long the stream gets to deliver a transaction the websocket announced, before it is fetched (default 400 ms). */
  streamGraceMs?: number;
  /** A transaction whose fetch takes longer than this no longer holds up the wallet's later trades (default 2 s). */
  stuckMs?: number;
}

/** A transaction that could not be fetched is tried again on later cycles for this long. */
const RETRY_FOR_MS = 120_000;
/** While the stream delivers, the poll (the backup) runs this often at most. */
const QUIET_POLL_MS = 20_000;

const SEEN_CAP = 20_000;
/** Programs that move SOL or tokens without trading: a transaction that invokes only these is skipped unfetched. */
const NON_TRADING = new Set([
  '11111111111111111111111111111111', // System
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

/** True when the logs show a program that could be a trade (any DEX, launchpad, aggregator or bot router). */
export function mightTrade(logs: string[]): boolean {
  for (const l of logs) {
    const m = /^Program (\w{32,44}) invoke/.exec(l);
    if (m && !NON_TRADING.has(m[1]!)) return true;
  }
  return false;
}
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
  private stopped = false;
  /** Signatures whose fetch failed: tried again on later cycles (the poll's cursor has moved past them). */
  private readonly retryLater = new Map<string, { signature: string; leader: string; until: number }>();
  private readonly getSigs: NonNullable<WatcherDeps['getSignatures']>;
  private readonly getTx: NonNullable<WatcherDeps['getTransaction']>;

  constructor(private readonly deps: WatcherDeps) {
    this.getSigs = deps.getSignatures ?? ((leader, until, before) => getSignaturesForAddress(leader, { limit: PAGE, until, before }));
    this.getTx = deps.getTransaction ?? ((s) => getTransaction(s));
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const loop = async () => {
      await this.sync().catch((err) => log.warn('watch cycle failed', { error: safeErrorMessage(err) }));
      if (this.stopped) return; // stopped while the cycle ran: do not start another
      // While the stream delivers, the poll is only the backup: every 20 s instead of every few seconds (each poll
      // costs one request per copied wallet).
      const wait = this.deps.streamHealthy?.() ? Math.max(this.deps.pollMs, QUIET_POLL_MS) : this.deps.pollMs;
      this.timer = setTimeout(loop, wait);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
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
      // Transactions whose fetch failed earlier: once more, for a couple of minutes.
      const now = Date.now();
      for (const [key, r] of this.retryLater) {
        this.retryLater.delete(key);
        if (now > r.until || !wanted.has(r.leader) || this.stopped) continue;
        const job = this.process(r.signature, r.leader, r.until).catch((err) => log.warn('leader transaction failed', { signature: r.signature, error: safeErrorMessage(err) }));
        this.pending.add(job);
        void job.finally(() => this.pending.delete(job));
      }
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
    const fresh: string[] = [];
    for (const s of [...sigs].reverse()) {
      if (s.signature === cursor) continue;
      if (s.err) { this.seen.add(`${s.signature}:${leader}`); continue; }
      if (!this.seen.has(`${s.signature}:${leader}`)) fresh.push(s.signature);
    }
    if (fresh.length > 1) {
      const job = this.processBatch(leader, fresh).catch((err) => log.warn('leader transactions failed', { leader, error: safeErrorMessage(err) }));
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
    } else if (fresh.length === 1) {
      this.handle(fresh[0]!, leader);
    }
  }

  /**
   * Several transactions of one wallet found at once (the push feeds missed them, or the server stalled): all are
   * fetched first. A buy followed in the same batch by that wallet's full exit of the coin is not copied: it would
   * be bought late and dumped at once.
   */
  private async processBatch(leader: string, signatures: string[]): Promise<void> {
    for (const s of signatures) this.markSeen(`${s}:${leader}`);
    const fetched = signatures.map((s) => (async () => {
      const release = await this.slot();
      try {
        return await this.fetchTx(s);
      } finally {
        release();
      }
    })());
    const txs = await Promise.all(fetched);
    const trades = txs.map((tx) => (tx ? parseLeaderTrades(tx, leader) : null));
    for (let i = 0; i < signatures.length; i++) {
      const tx = txs[i];
      if (!tx) {
        this.retryLater.set(`${signatures[i]}:${leader}`, { signature: signatures[i]!, leader, until: Date.now() + RETRY_FOR_MS });
        continue;
      }
      const exitedLater = (mint: string) => trades.slice(i + 1).some((ts) => ts?.some((t) => t.mint === mint && t.side === 'sell' && t.tokensAfter === 0n));
      const keep = trades[i]!.filter((t) => {
        if (t.side === 'buy' && exitedLater(t.mint)) {
          log.info('leader buy skipped: heard late, together with its full exit', { leader, mint: t.mint, sig: signatures[i]!.slice(0, 12) });
          return false;
        }
        return true;
      });
      await this.deliver(leader, signatures[i]!, Promise.resolve(tx), 'fetch', keep);
    }
  }

  /** Fetch, parse and pass on one signature, once. Logs that never mention pump.fun / PumpSwap skip the fetch. */
  handle(signature: string, leader: string, logs?: string[], slot?: number, afterGrace = false): void {
    if (this.stopped) return;
    const key = `${signature}:${leader}`;
    if (this.seen.has(key)) return;
    const truncated = logs?.some((l) => /log truncated/i.test(l));
    const fromSocket = logs !== undefined;
    const plainBuy = logs && slot !== undefined && !truncated ? fastBuysFromLogs(logs, signature, leader, slot) : null;
    // The Helius stream brings this transaction in full (no fetch) a moment from now: give it that moment. If it has
    // not delivered by then (a stream that says it is healthy but has quietly stopped), fetch it as usual.
    if (fromSocket && !plainBuy && !afterGrace && this.deps.streamHealthy?.()) {
      setTimeout(() => this.handle(signature, leader, logs, slot, true), this.deps.streamGraceMs ?? 400).unref?.();
      return;
    }
    this.markSeen(key);
    if (logs && logs.length && !truncated && !mightTrade(logs)) return;
    // Fast path: a plain pump.fun buy is copied straight from the logs, no fetch. (The engine's slot check keeps a
    // later sell that was handled first from being undone by this buy.)
    const fast = plainBuy;
    if (fast) {
      for (const t of fast) {
        log.info('leader trade', { leader, side: t.side, mint: t.mint, sol: Number(t.solLamports) / 1e9, fast: true, sig: signature.slice(0, 12) });
        const job = this.deps.onTrade(t).catch((err) => log.warn('leader trade failed', { signature, error: safeErrorMessage(err) }));
        this.pending.add(job);
        void job.finally(() => this.pending.delete(job));
      }
      return;
    }
    const job = this.process(signature, leader).catch((err) => log.warn('leader transaction failed', { signature, error: safeErrorMessage(err) }));
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  private markSeen(key: string): void {
    this.seen.add(key);
    if (this.seen.size > SEEN_CAP) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
  }

  /**
   * A full transaction pushed by the Helius stream: parsed and passed on without any fetch, once per copied wallet
   * it involves, in order behind that wallet's earlier transactions.
   */
  handleStreamTx(tx: RawTransaction): void {
    if (this.stopped) return;
    const signature = tx.transaction.signatures[0];
    if (!signature || tx.meta?.err) return;
    const keys = new Set(tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)));
    for (const leader of this.cursors.keys()) {
      if (!keys.has(leader)) continue;
      const key = `${signature}:${leader}`;
      if (this.seen.has(key)) continue;
      this.markSeen(key);
      const job = this.deliver(leader, signature, Promise.resolve(tx), 'stream').catch((err) => log.warn('leader transaction failed', { signature, error: safeErrorMessage(err) }));
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
    }
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

  private async process(signature: string, leader: string, retryUntil = Date.now() + RETRY_FOR_MS): Promise<void> {
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
    await this.deliver(leader, signature, fetched, 'fetch', undefined, retryUntil);
  }

  /** Hand a transaction's trades to the engine, strictly after this wallet's earlier transactions. */
  private async deliver(leader: string, signature: string, source: Promise<RawTransaction | null>, via: 'fetch' | 'stream', parsed?: LeaderTrade[], retryUntil = Date.now() + RETRY_FOR_MS): Promise<void> {
    const prev = this.delivery.get(leader) ?? Promise.resolve();
    const handOver = async (tx: RawTransaction | null) => {
      if (!tx) {
        // Not fetched: tried again on later cycles (the poll's cursor has already moved past it).
        if (Date.now() < retryUntil) this.retryLater.set(`${signature}:${leader}`, { signature, leader, until: retryUntil });
        return;
      }
      for (const t of parsed ?? parseLeaderTrades(tx, leader)) {
        if (t.counter && t.side === 'buy' && this.deps.valueInSol) {
          // Paid in a stablecoin or another coin (perhaps with a little SOL too): its SOL value is what "bought at
          // least X SOL" means. (A sell paid out in another coin needs no price: it is mirrored by its share.)
          t.solLamports += await this.deps.valueInSol(t.counter.mint, t.counter.amount).catch(() => 0n);
        }
        log.info('leader trade', { leader, side: t.side, mint: t.mint, sol: Number(t.solLamports) / 1e9, via, lagMs: t.blockTime ? Date.now() - t.blockTime * 1000 : null, sig: signature.slice(0, 12) });
        await this.deps.onTrade(t);
      }
    };
    const STUCK = Symbol('stuck');
    const mine = prev.then(async () => {
      // A fetch that hangs must not hold up this wallet's later trades (its exit above all): after a short wait the
      // queue moves on, and this one is handed over on its own when it arrives. (The engine refuses a buy that
      // arrives after the same wallet's later sell of the coin.)
      let timer: NodeJS.Timeout | undefined;
      const first = await Promise.race([source, new Promise<typeof STUCK>((r) => { timer = setTimeout(() => r(STUCK), this.deps.stuckMs ?? 2_000); })]);
      clearTimeout(timer);
      if (first === STUCK) {
        void source.then(handOver).catch((err) => log.warn('leader transaction failed', { signature, error: safeErrorMessage(err) }));
        return;
      }
      await handOver(first);
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
