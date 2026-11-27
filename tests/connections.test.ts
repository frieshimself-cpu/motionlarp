import { describe, expect, it } from 'vitest';
import { checkConnections, type ConnectionProbes } from '../src/connections.js';

const good: ConnectionProbes = {
  rpcSet: true,
  jupiterKeySet: true,
  rpc: async () => 301_234_567,
  stream: () => ({ ok: true, note: 'live (12 transactions)' }),
  sender: async () => ({ region: 'fra', ms: 6.4 }),
  jupiter: async () => undefined,
};

describe('connection checks (the owner\'s Connections page)', () => {
  it('everything connected: four green rows, each saying what was actually tested', async () => {
    const r = await checkConnections(good);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(['rpc', 'stream', 'sender', 'jupiter']);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks[0]!.detail).toContain('301234567');
    expect(r.checks[2]!.detail).toContain('fra');
    expect(r.checks[2]!.detail).toContain('6 ms');
  });

  it('no Helius link on the server: the Helius rows are red and say so, without calling anything', async () => {
    let called = 0;
    const r = await checkConnections({ ...good, rpcSet: false, rpc: async () => { called++; return 1; }, sender: async () => { called++; return null; } });
    expect(called).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'rpc')).toMatchObject({ ok: false, detail: 'the Helius link is not set on the server' });
  });

  it('a failing check is red with a short reason, and never shows a key', async () => {
    const r = await checkConnections({
      ...good,
      rpc: async () => { throw new Error('request to https://mainnet.helius-rpc.com/?api-key=9e1b6213-aaaa-bbbb-cccc-1234567890ab failed: 401'); },
      jupiter: async () => { throw new Error('jupiter: HTTP 401'); },
    });
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    expect(text).not.toContain('9e1b6213');
    expect(r.checks.find((c) => c.id === 'rpc')!.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'jupiter')).toMatchObject({ ok: false });
    expect(r.checks.find((c) => c.id === 'jupiter')!.detail).toMatch(/key was refused.*server file/);
  });

  it('a check that hangs is cut off and reported, the others still answer', async () => {
    const r = await checkConnections({ ...good, jupiter: () => new Promise(() => undefined) }, 30);
    expect(r.checks.find((c) => c.id === 'jupiter')).toMatchObject({ ok: false, detail: 'no answer in time' });
    expect(r.checks.find((c) => c.id === 'rpc')!.ok).toBe(true);
  });

  it('no Jupiter key: works on the free endpoint and says it is the slower one', async () => {
    const r = await checkConnections({ ...good, jupiterKeySet: false });
    const j = r.checks.find((c) => c.id === 'jupiter')!;
    expect(j.ok).toBe(true);
    expect(j.detail).toMatch(/no key/);
  });

  it('the stream switched off or down is reported but does not fail the page (the standard feed carries on)', async () => {
    const r = await checkConnections({ ...good, stream: () => ({ ok: false, note: 'connecting' }) });
    expect(r.checks.find((c) => c.id === 'stream')).toMatchObject({ ok: false, optional: true });
    expect(r.ok).toBe(true);
  });
});
