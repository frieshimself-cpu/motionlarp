// Helius's transaction stream (`transactionSubscribe`, part of LaserStream WebSocket; Developer plan and up): one
// websocket that pushes the FULL transaction of every copied wallet the moment it is processed. No second request
// to fetch the transaction, which is what makes sells and non-pump.fun buys slow on the standard subscription.
// Request and notification shapes from Helius's docs (27 Nov 2026). If Helius refuses the subscription or the
// connection is down, `healthy()` is false and the watcher's standard path carries on by itself.
import type { RawTransaction } from '../chain/rpc.js';
import { log } from '../log.js';

export interface HeliusStreamDeps {
  url: string;
  leaders: () => string[];
  onTransaction: (tx: RawTransaction, slot: number) => void;
  WebSocketImpl?: typeof WebSocket;
  reconnectMs?: number;
  pingMs?: number;
}

/** The stream lives on the same host as the RPC link; only Helius links have it. */
export function streamUrlFor(rpcUrl: string): string | null {
  try {
    const u = new URL(rpcUrl);
    if (!u.hostname.endsWith('helius-rpc.com')) return null;
    u.protocol = 'wss:';
    return u.toString();
  } catch {
    return null;
  }
}

const STALE_MS = 90_000;

export class HeliusStream {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private subId: number | null = null;
  private pendingSubscribe: number | null = null;
  private subscribedTo = '';
  private refused = '';
  private lastMessageAt = 0;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  delivered = 0;

  constructor(private readonly deps: HeliusStreamDeps) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    this.subId = null;
  }

  /** Subscribed, and the connection has been heard from recently. */
  healthy(): boolean {
    return this.subId !== null && Date.now() - this.lastMessageAt < STALE_MS;
  }

  status(): string {
    if (this.refused) return `refused by Helius: ${this.refused}`;
    if (this.healthy()) return `live (${this.delivered} transactions)`;
    if (this.ws?.readyState === 1 && this.subscribedTo === '' && this.pendingSubscribe === null) return 'connected (no wallets copied yet)';
    return this.ws ? 'connecting' : 'down';
  }

  /** Call when the list of copied wallets may have changed. */
  sync(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const leaders = [...this.deps.leaders()].sort();
    const key = leaders.join(',');
    if (key === this.subscribedTo) return;
    if (this.subId !== null) this.send({ method: 'transactionUnsubscribe', params: [this.subId] });
    this.subId = null;
    this.subscribedTo = key;
    if (!leaders.length) return;
    this.pendingSubscribe = this.send({
      method: 'transactionSubscribe',
      params: [
        { failed: false, vote: false, accountInclude: leaders },
        { commitment: 'processed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 1 },
      ],
    });
  }

  private send(msg: { method: string; params?: unknown[] }): number {
    const id = this.nextId++;
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, ...msg }));
    return id;
  }

  private connect(): void {
    if (this.stopped) return;
    const Impl = this.deps.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.deps.url);
    this.ws = ws;
    this.subscribedTo = '';
    this.subId = null;
    ws.onopen = () => {
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      this.sync();
      if (this.pingTimer) clearInterval(this.pingTimer);
      // Helius drops idle connections: a ping well inside every minute keeps this one up.
      this.pingTimer = setInterval(() => { if (ws.readyState === 1) this.send({ method: 'ping' }); }, this.deps.pingMs ?? 25_000);
      this.pingTimer.unref?.();
    };
    ws.onmessage = (e: { data: unknown }) => this.onMessage(String(e.data));
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.subId = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      // After a refusal (plan, method) retrying fast is pointless: look again every few minutes.
      const wait = this.refused ? 300_000 : Math.min((this.deps.reconnectMs ?? 1_000) * 2 ** Math.min(this.attempts++, 5), 30_000);
      this.retryTimer = setTimeout(() => this.connect(), wait);
      this.retryTimer.unref?.();
    };
  }

  private onMessage(text: string): void {
    this.lastMessageAt = Date.now();
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { result?: { signature?: string; slot?: number; transaction?: { transaction?: unknown; meta?: unknown } } } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id === this.pendingSubscribe) {
      this.pendingSubscribe = null;
      if (typeof msg.result === 'number') {
        this.subId = msg.result;
        this.refused = '';
        log.info('helius stream subscribed', { wallets: this.subscribedTo.split(',').filter(Boolean).length });
      } else {
        this.refused = msg.error?.message ?? 'no subscription id';
        log.warn('helius stream refused; using the standard feed', { reason: this.refused });
      }
      return;
    }
    if (msg.method !== 'transactionNotification') return;
    const r = msg.params?.result;
    const inner = r?.transaction?.transaction as { signatures?: string[]; message?: { accountKeys?: (string | { pubkey: string })[] } } | undefined;
    const meta = r?.transaction?.meta as RawTransaction['meta'];
    if (!r || !inner?.message?.accountKeys || !meta) return;
    const signature = r.signature ?? inner.signatures?.[0];
    if (!signature) return;
    this.delivered++;
    this.deps.onTransaction({ slot: r.slot ?? 0, blockTime: null, meta, transaction: { signatures: [signature], message: { accountKeys: inner.message.accountKeys } } }, r.slot ?? 0);
  }
}
