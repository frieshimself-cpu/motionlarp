// Raw JSON-RPC for the calls whose exact JSON shape we parse ourselves (transactions, signatures).
import { config } from '../config.js';

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface RawTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
    logMessages?: string[];
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: (string | { pubkey: string })[] } };
}

let nextId = 1;

/** One JSON-RPC call; a 429 (rate limited) is retried up to 4 times with a growing pause. */
export async function rpc<T>(method: string, params: unknown[], url = config.rpcUrl): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpcOnce<T>(method, params, url);
    } catch (err) {
      if (!(err instanceof RateLimited) || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

class RateLimited extends Error {}

async function rpcOnce<T>(method: string, params: unknown[], url: string): Promise<T> {
  if (!url) throw new Error('RPC_URL is not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) throw new RateLimited(`rpc ${method}: rate limited (429)`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? 'error'}`);
  return body.result as T;
}

export function getTransaction(signature: string, url?: string): Promise<RawTransaction | null> {
  return rpc<RawTransaction | null>('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], url);
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

export function getSignaturesForAddress(address: string, opts: { limit?: number; until?: string; before?: string } = {}, url?: string): Promise<SignatureInfo[]> {
  return rpc<SignatureInfo[]>('getSignaturesForAddress', [address, { limit: opts.limit ?? 20, until: opts.until, before: opts.before, commitment: 'confirmed' }], url);
}
