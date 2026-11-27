// The owner's Status page: the Helius link and the Jupiter key are set once in the server's file and used for every user on the
// site. This runs a real request against each of them, so "connected" means it answered just now, not "it was saved".
// Nothing here returns a key or a link: only what was tested and whether it worked.
import { safeErrorMessage } from './log.js';

export interface ConnectionProbes {
  rpcSet: boolean;
  jupiterKeySet: boolean;
  /** The current slot from the saved Helius link. */
  rpc: () => Promise<number>;
  /** Helius's transaction stream; null when it is switched off. */
  stream: () => { ok: boolean; note: string } | null;
  /** The Helius Sender region in use and one fresh ping of it; null when Sender is switched off. */
  sender: () => Promise<{ region: string; ms: number } | null>;
  /** A real Jupiter quote with the saved key (throws when refused). */
  jupiter: () => Promise<void>;
}

export interface ConnectionCheck {
  id: 'rpc' | 'stream' | 'sender' | 'jupiter';
  name: string;
  ok: boolean;
  detail: string;
  ms?: number;
  /** A red optional row does not make the page red: trading works without it, only slower. */
  optional?: boolean;
}

export interface ConnectionReport {
  ok: boolean;
  checks: ConnectionCheck[];
}

const NO_LINK = 'the Helius link is not set on the server';

async function timed<T>(fn: () => Promise<T>, timeoutMs: number): Promise<{ value: T; ms: number } | { error: string }> {
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in time')), timeoutMs); }),
    ]);
    return { value, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { error: safeErrorMessage(err, 120).replace(/api-key=[^&\s"']+/gi, 'api-key=…') };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkConnections(p: ConnectionProbes, timeoutMs = 6_000): Promise<ConnectionReport> {
  const rpc = async (): Promise<ConnectionCheck> => {
    const base = { id: 'rpc' as const, name: 'Helius RPC' };
    if (!p.rpcSet) return { ...base, ok: false, detail: NO_LINK };
    const r = await timed(p.rpc, timeoutMs);
    if ('error' in r) return { ...base, ok: false, detail: /401|403|unauthor|forbidden|invalid api/i.test(r.error) ? 'Helius refused the link: the key in it is wrong or was deleted (RPC_URL in the server file)' : r.error };
    return { ...base, ok: true, detail: `answered in ${r.ms} ms (slot ${r.value})`, ms: r.ms };
  };

  const stream = async (): Promise<ConnectionCheck> => {
    const base = { id: 'stream' as const, name: 'Helius stream', optional: true };
    if (!p.rpcSet) return { ...base, ok: false, detail: NO_LINK };
    const s = p.stream();
    if (!s) return { ...base, ok: false, detail: 'switched off: the standard feed is used' };
    return { ...base, ok: s.ok, detail: s.note };
  };

  const sender = async (): Promise<ConnectionCheck> => {
    const base = { id: 'sender' as const, name: 'Helius Sender', optional: true };
    if (!p.rpcSet) return { ...base, ok: false, detail: NO_LINK };
    const r = await timed(p.sender, timeoutMs);
    if ('error' in r) return { ...base, ok: false, detail: `${r.error}: tipped trades fall back to the normal route` };
    if (!r.value) return { ...base, ok: false, detail: 'switched off' };
    return { ...base, ok: true, detail: `${r.value.region} answers in ${Math.round(r.value.ms)} ms`, ms: Math.round(r.value.ms) };
  };

  const jupiter = async (): Promise<ConnectionCheck> => {
    const base = { id: 'jupiter' as const, name: 'Jupiter' };
    const r = await timed(p.jupiter, timeoutMs);
    if ('error' in r) {
      const refused = /401|403|unauthor|forbidden|invalid/i.test(r.error);
      return { ...base, ok: false, detail: refused && p.jupiterKeySet ? 'the key was refused: it is wrong or expired (JUPITER_API_KEY in the server file)' : r.error };
    }
    return { ...base, ok: true, detail: p.jupiterKeySet ? `real quote with your key in ${r.ms} ms` : `real quote in ${r.ms} ms, with no key (the free, slower lane)`, ms: r.ms };
  };

  const checks = await Promise.all([rpc(), stream(), sender(), jupiter()]);
  return { ok: checks.every((c) => c.ok || c.optional), checks };
}
