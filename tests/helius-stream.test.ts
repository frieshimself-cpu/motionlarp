import { describe, expect, it } from 'vitest';
import { HeliusStream, streamUrlFor } from '../src/watch/helius-stream.js';

/** A stand-in for the WebSocket: records what is sent, lets the test play the server. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static opened = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  constructor(readonly url: string) { FakeSocket.last = this; FakeSocket.opened++; }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  say(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const A = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
const B = 'GsJuHUtw6ni41HNgiycuAn4xeFw5GupsZUBPHgzW6PJR';
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(leaders: string[] = [A]) {
  const got: { signature: string; slot: number }[] = [];
  let list = leaders;
  FakeSocket.opened = 0;
  const s = new HeliusStream({ url: 'wss://mainnet.helius-rpc.com/?api-key=k', leaders: () => list, onTransaction: (tx, slot) => got.push({ signature: tx.transaction.signatures[0]!, slot }), WebSocketImpl: FakeSocket as never, reconnectMs: 5, pingMs: 1e9 });
  return { s, got, set: (l: string[]) => { list = l; } };
}

describe('Helius transaction stream', () => {
  it('only Helius links get the stream', () => {
    expect(streamUrlFor('https://mainnet.helius-rpc.com/?api-key=abc')).toBe('wss://mainnet.helius-rpc.com/?api-key=abc');
    expect(streamUrlFor('https://beta.helius-rpc.com/?api-key=abc')).toBe('wss://beta.helius-rpc.com/?api-key=abc');
    expect(streamUrlFor('https://api.mainnet-beta.solana.com')).toBeNull();
    expect(streamUrlFor('')).toBeNull();
  });

  it('subscribes to the copied wallets at "processed", full transactions, new transaction format included', () => {
    const { s } = setup([A, B]);
    s.start();
    FakeSocket.last!.open();
    expect(FakeSocket.last!.sent[0]).toMatchObject({
      method: 'transactionSubscribe',
      params: [{ failed: false, vote: false, accountInclude: [A, B] }, { commitment: 'processed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 1 }],
    });
    s.stop();
  });

  it('is healthy once the subscription is confirmed, and hands over each transaction with its slot', () => {
    const { s, got } = setup();
    s.start();
    const ws = FakeSocket.last!;
    ws.open();
    expect(s.healthy()).toBe(false);
    ws.say({ jsonrpc: '2.0', id: ws.sent[0]!.id, result: 777 });
    expect(s.healthy()).toBe(true);
    ws.say({ jsonrpc: '2.0', method: 'transactionNotification', params: { subscription: 777, result: { signature: 'SIG1', slot: 42, transaction: { transaction: { signatures: ['SIG1'], message: { accountKeys: [{ pubkey: A }] } }, meta: { err: null, fee: 5000, preBalances: [1], postBalances: [1] } } } } });
    expect(got).toEqual([{ signature: 'SIG1', slot: 42 }]);
    s.stop();
  });

  it('a changed wallet list replaces the subscription', () => {
    const { s, set } = setup([A]);
    s.start();
    const ws = FakeSocket.last!;
    ws.open();
    ws.say({ jsonrpc: '2.0', id: ws.sent[0]!.id, result: 777 });
    set([A, B]);
    s.sync();
    expect(ws.sent.map((m) => m.method)).toEqual(['transactionSubscribe', 'transactionUnsubscribe', 'transactionSubscribe']);
    expect(ws.sent[1]).toMatchObject({ params: [777] });
    expect((ws.sent[2]!.params as { accountInclude: string[] }[])[0]!.accountInclude).toEqual([A, B]);
    s.sync(); // same list: nothing new
    expect(ws.sent).toHaveLength(3);
    s.stop();
  });

  it('no wallets: no subscription; a refused subscription is not healthy and says why', () => {
    const none = setup([]);
    none.s.start();
    FakeSocket.last!.open();
    expect(FakeSocket.last!.sent).toHaveLength(0);
    expect(none.s.status()).toBe('connected (no wallets copied yet)');
    none.s.stop();

    const { s } = setup();
    s.start();
    const ws = FakeSocket.last!;
    ws.open();
    ws.say({ jsonrpc: '2.0', id: ws.sent[0]!.id, error: { code: -32601, message: 'Method not found' } });
    expect(s.healthy()).toBe(false);
    expect(s.status()).toMatch(/refused.*Method not found/);
    s.stop();
  });

  it('reconnects after the connection drops and subscribes again', async () => {
    const { s } = setup();
    s.start();
    const first = FakeSocket.last!;
    first.open();
    first.say({ jsonrpc: '2.0', id: first.sent[0]!.id, result: 1 });
    first.onclose?.();
    expect(s.healthy()).toBe(false);
    await tick(); await tick();
    expect(FakeSocket.opened).toBe(2);
    FakeSocket.last!.open();
    expect(FakeSocket.last!.sent[0]).toMatchObject({ method: 'transactionSubscribe' });
    s.stop();
  });
});
