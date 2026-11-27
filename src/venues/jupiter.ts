// Jupiter: the route for every coin the native pump.fun / PumpSwap path does not cover — other launchpads
// (Raydium LaunchLab / Bonk, Meteora DBC, Moonshot, …), every DEX (Raydium, Meteora, Orca, …), PumpSwap pools set
// up "the other way round", coins paired with USDC / USD1 / anything. We always pay and receive SOL; Jupiter finds
// the path through whatever the coin is paired with.
import { AddressLookupTableAccount, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Accounts a route may use: small leaves room for our own transfers; large is Jupiter's default. */
export const ROUTE_SMALL = 48;
export const ROUTE_LARGE = 64;
const NO_ROUTE = /no routes|could_not_find|not tradable|not_tradable/i;

/** The most a Solana transaction may weigh on the wire (one network packet). */
export const MAX_TRANSACTION_BYTES = 1232;

export class Jupiter {
  private readonly buyWaitMs: number;
  private readonly timeoutMs: number;
  /**
   * `retryMs`: pause between tries when a coin has no route yet (a coin seconds old is not indexed yet; seen on
   * mainnet: a LaunchLab coin routed after ~10 s). `buyWaitMs`: how long a copy buy waits for such a coin (default
   * 2.5 s): a copy that misses its moment is skipped, never filled seconds later at any price. `timeoutMs`: the most
   * one quote may take (default 3 s; a swap twice that).
   */
  constructor(private readonly base: string, private readonly apiKey: string, private readonly fetchFn: FetchFn = fetch, private readonly retryMs = 1000, private readonly busyRetryMs = 250, opts: { buyWaitMs?: number; timeoutMs?: number } = {}) {
    this.buyWaitMs = opts.buyWaitMs ?? 2_500;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) };
  }

  /** One request. A busy answer (429, 5xx) is retried three times with short, growing pauses (0.25, 0.5, 1 s): one
   *  rate-limit blip must not lose a copy. A real refusal (4xx with a reason) is returned at once. A request that
   *  hangs is cut off after a few seconds (it was 10: a +2 s sell could leave at +12 s), and one that hung or whose
   *  connection dropped is tried once more at once. */
  private async call<T>(url: string | URL, init?: RequestInit, timeoutMs = this.timeoutMs): Promise<T> {
    let dropped = 0;
    for (let busy = 0; ;) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { ...init, headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (dropped++ >= 1) throw err;
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as T & { error?: string; errorCode?: string };
      if (res.ok && !body.error) return body;
      const isBusy = res.status === 429 || res.status >= 500;
      if (!isBusy || busy >= 3) throw new Error(`jupiter: ${body.error ?? body.errorCode ?? `HTTP ${res.status}`}`);
      await new Promise((r) => setTimeout(r, this.busyRetryMs * 2 ** busy));
      busy++;
    }
  }

  /** ExactIn quote. `maxAccounts` keeps the route small enough to add our fee transfer to the transaction. */
  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number, maxAccounts = 48, retryNoRoute = true): Promise<JupiterQuote> {
    const u = new URL(`${this.base.replace(/\/$/, '')}/swap/v1/quote`);
    u.searchParams.set('inputMint', inputMint);
    u.searchParams.set('outputMint', outputMint);
    u.searchParams.set('amount', amount.toString());
    u.searchParams.set('slippageBps', String(Math.round(slippageBps)));
    u.searchParams.set('maxAccounts', String(maxAccounts));
    u.searchParams.set('restrictIntermediateTokens', 'true');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call<JupiterQuote>(u);
      } catch (err) {
        if (!retryNoRoute || attempt >= 5 || !NO_ROUTE.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, this.retryMs * (attempt + 1)));
      }
    }
  }

  /**
   * Finds a route. First within ROUTE_SMALL accounts (that leaves room in the transaction for our fee and tip
   * transfers); when there is none, within ROUTE_LARGE, Jupiter's own default: a coin priced in something other than
   * SOL (a launchpad coin against USD1: SOL -> USD1 -> coin) needs more hops, which is not the same as no route.
   * Only when both say "no route" and `patient` is set (a buy: the coin may be seconds old and not picked up yet)
   * is the larger one asked again, for a moment only (`buyWaitMs`): a copy that misses its moment is skipped (it
   * used to wait about 15 s and then buy at any price, even after the copied wallet had sold).
   */
  async route(inputMint: string, outputMint: string, amount: bigint, slippageBps: number, patient: boolean): Promise<{ quote: JupiterQuote; maxAccounts: number }> {
    let noRoute: unknown;
    for (const maxAccounts of [ROUTE_SMALL, ROUTE_LARGE]) {
      try {
        return { quote: await this.quote(inputMint, outputMint, amount, slippageBps, maxAccounts, false), maxAccounts };
      } catch (err) {
        if (!NO_ROUTE.test(String(err))) throw err;
        noRoute = err;
      }
    }
    if (!patient) throw noRoute;
    const until = Date.now() + this.buyWaitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(this.retryMs * 0.4 + 1, Math.max(0, until - Date.now()))));
      try {
        return { quote: await this.quote(inputMint, outputMint, amount, slippageBps, ROUTE_LARGE, false), maxAccounts: ROUTE_LARGE };
      } catch (err) {
        if (!NO_ROUTE.test(String(err))) throw err;
        noRoute = err;
      }
    }
    throw new Error(`jupiter: no market for this coin on Jupiter yet (waited ${(this.buyWaitMs / 1000).toFixed(1)} s): skipped, not bought late`);
  }

  async swap(quote: JupiterQuote, user: PublicKey, priorityFeeLamports: bigint): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }> {
    const r = await this.call<{ swapTransaction: string; lastValidBlockHeight: number }>(`${this.base.replace(/\/$/, '')}/swap/v1/swap`, {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: user.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: Number(priorityFeeLamports),
      }),
    }, this.timeoutMs * 2);
    return { tx: VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64')), lastValidBlockHeight: r.lastValidBlockHeight };
  }
}

/**
 * Adds instructions (the tip, our platform fee) at the end of a prebuilt v0 transaction: decompile with its address
 * lookup tables, append, recompile with the same tables and blockhash. Throws if the result no longer fits.
 */
export async function appendInstruction(tx: VersionedTransaction, ix: TransactionInstruction | TransactionInstruction[], loadTables: (keys: PublicKey[]) => Promise<AddressLookupTableAccount[]>): Promise<VersionedTransaction> {
  const lookups = tx.message.addressTableLookups ?? [];
  const tables = lookups.length ? await loadTables(lookups.map((l) => l.accountKey)) : [];
  const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  msg.instructions.push(...(Array.isArray(ix) ? ix : [ix]));
  const out = new VersionedTransaction(msg.compileToV0Message(tables));
  // A transaction may be 1232 bytes in all, signatures included. serialize() only throws when the MESSAGE alone is
  // over that, so the size is checked here (the empty signature slots are already counted).
  if (out.serialize().length > MAX_TRANSACTION_BYTES) throw new Error(`transaction too large: ${out.serialize().length} bytes`);
  return out;
}
