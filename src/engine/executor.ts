// How a copy's buys and sells reach the chain. The engine talks to the `Executor` interface; tests use a fake.
//
// ChainExecutor:
//  * live (copy set to live AND server LIVE_TRADING=true): build → simulate → send → confirm → read the real fill
//    (tokens and SOL) from our own confirmed transaction, with the same balance parser used for leaders.
//  * test mode: the buy is built and simulated with the user's real wallet when it holds enough SOL (proving the
//    transaction would go through), the fill is the real quote, nothing is sent. Sells are filled from the quote.
import { PublicKey, type Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config } from '../config.js';
import { getConnection } from '../chain/connection.js';
import { getTransaction } from '../chain/rpc.js';
import { log, safeErrorMessage } from '../log.js';
import { buildSignedTx } from '../tx/build.js';
import { confirmSignature } from '../tx/confirm.js';
import { canSendLive, sendTransaction } from '../tx/send.js';
import { PfDispatcher } from '../venues/pf.js';
import { VenueError, type ResolvedPool } from '../venues/types.js';
import { parseLeaderTrades } from '../watch/parse.js';

export type FillResult =
  | { ok: true; signature: string; tokens: bigint; lamports: bigint; simulated: boolean; note?: string }
  | { ok: false; error: string };

export interface TradeRequest {
  wallet: Keypair;
  mint: string;
  slippagePct: number;
  priorityFeeSol: number;
  /** The copy is set to live. Sent only if the server is live too. */
  live: boolean;
}

export interface Executor {
  buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult>;
  /** `tokens`: how many to sell. Live sells never sell more than the wallet holds on-chain. */
  sell(req: TradeRequest & { tokens: bigint }): Promise<FillResult>;
  /** SOL value of selling `tokens` now. */
  quoteSell(mint: string, tokens: bigint): Promise<bigint>;
  solBalance(owner: string): Promise<bigint>;
  tokenBalance(owner: string, mint: string): Promise<bigint>;
  /** True when a request with live=true would really be sent. */
  isLive(req: { live: boolean }): boolean;
}

const FETCH_FILL_TRIES = 6;

export class ChainExecutor implements Executor {
  readonly pf = new PfDispatcher();

  isLive(req: { live: boolean }): boolean {
    return req.live && canSendLive();
  }

  async solBalance(owner: string): Promise<bigint> {
    return BigInt(await getConnection().getBalance(new PublicKey(owner), 'confirmed'));
  }

  /**
   * Tokens of `mint` the owner holds across all its token accounts. An RPC failure throws: it must never read as
   * "holds nothing" (that would close a position whose coins are still in the wallet).
   */
  async tokenBalance(owner: string, mint: string): Promise<bigint> {
    const res = await getConnection().getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
    let total = 0n;
    for (const a of res.value) total += BigInt((a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount ?? '0');
    return total;
  }

  /** Balance of the owner's associated token account; 0 only when the account does not exist, errors throw. */
  private async ataBalance(pool: ResolvedPool, owner: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(pool.mint, owner, true, pool.tokenProgram);
    const info = await getConnection().getAccountInfo(ata, 'confirmed');
    if (!info) return 0n;
    const bal = await getConnection().getTokenAccountBalance(ata, 'confirmed');
    return BigInt(bal.value.amount);
  }

  async quoteSell(mint: string, tokens: bigint): Promise<bigint> {
    return this.withPool(mint, (pool) => this.pf.venueFor(pool).quoteSell(pool, tokens));
  }

  /** Runs `fn` on the coin's pool; a curve that migrated mid-way is re-resolved to PumpSwap once. */
  private async withPool<T>(mint: string, fn: (pool: ResolvedPool) => Promise<T>): Promise<T> {
    let pool = await this.pf.resolve(mint);
    try {
      return await fn(pool);
    } catch (err) {
      if (err instanceof VenueError && err.code === 'migrated') {
        pool = await this.pf.resolve(mint, { forceRefresh: true });
        return fn(pool);
      }
      throw err;
    }
  }

  async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    try {
      const live = this.isLive(req);
      return await this.withPool(req.mint, async (pool) => {
        const venue = this.pf.venueFor(pool);
        if (!live) {
          const tokens = await venue.quoteBuy(pool, req.lamports);
          if (tokens <= 0n) return { ok: false, error: 'the quote returned zero tokens' };
          const balance = await this.solBalance(req.wallet.publicKey.toBase58());
          if (balance < req.lamports + BigInt(Math.round(config.feeReserveSol * 1e9))) {
            return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens, lamports: req.lamports, simulated: true, note: 'test fill from the live quote (wallet too empty to simulate)' };
          }
          const built = await venue.buildBuy({ pool, user: req.wallet.publicKey, lamportsIn: req.lamports, slippagePct: req.slippagePct });
          const tx = await buildSignedTx({ signer: req.wallet, instructions: built.instructions, validatorTipSol: req.priorityFeeSol, txFeeSol: 0 });
          const sim = await sendTransaction(tx.tx, false);
          if (!sim.ok) return { ok: false, error: sim.error };
          return { ok: true, signature: sim.signature, tokens, lamports: req.lamports, simulated: true, note: 'simulated on-chain, not sent (test mode)' };
        }
        const [built, before] = await Promise.all([
          venue.buildBuy({ pool, user: req.wallet.publicKey, lamportsIn: req.lamports, slippagePct: req.slippagePct }),
          this.tokenBalance(req.wallet.publicKey.toBase58(), req.mint).catch(() => null),
        ]);
        return this.sendAndRead(req, built.instructions, 'buy', built.expectedOut, req.lamports, before);
      });
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  }

  async sell(req: TradeRequest & { tokens: bigint }): Promise<FillResult> {
    try {
      const live = this.isLive(req);
      return await this.withPool(req.mint, async (pool) => {
        const venue = this.pf.venueFor(pool);
        if (!live) {
          const lamports = await venue.quoteSell(pool, req.tokens);
          return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens: req.tokens, lamports, simulated: true, note: 'test fill from the live quote' };
        }
        // A sell draws from the standard (associated) token account: never ask for more than it holds.
        const held = await this.ataBalance(pool, req.wallet.publicKey);
        const tokens = req.tokens > held ? held : req.tokens;
        if (tokens <= 0n) return { ok: false, error: 'the wallet holds none of this coin' };
        const built = await venue.buildSell({ pool, user: req.wallet.publicKey, tokensIn: tokens, slippagePct: req.slippagePct });
        return this.sendAndRead(req, built.instructions, 'sell', tokens, built.expectedOut, held);
      });
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  }

  /**
   * Live path: sign, send, confirm (until the blockhash expires), then read what really happened from our own
   * confirmed transaction. If confirmation is unknown or says "not landed", the wallet's balance of the coin
   * decides: a transaction that landed late is still recorded as a fill, never left as orphaned coins.
   */
  private async sendAndRead(req: TradeRequest, instructions: import('@solana/web3.js').TransactionInstruction[], side: 'buy' | 'sell', expectedTokens: bigint, expectedLamports: bigint, balanceBefore: bigint | null): Promise<FillResult> {
    const built = await buildSignedTx({ signer: req.wallet, instructions, validatorTipSol: req.priorityFeeSol, txFeeSol: 0 });
    const sent = await sendTransaction(built.tx, true);
    if (!sent.ok) return { ok: false, error: sent.error };
    const confirmed = await confirmSignature(sent.signature, built.lastValidBlockHeight);
    const owner = req.wallet.publicKey.toBase58();
    if (!confirmed.landed) {
      if (balanceBefore !== null) {
        try {
          const after = await this.tokenBalance(owner, req.mint);
          const moved = side === 'buy' ? after - balanceBefore : balanceBefore - after;
          if (moved > 0n) {
            return { ok: true, signature: sent.signature, tokens: moved, lamports: side === 'buy' ? expectedLamports : (expectedLamports * moved) / (expectedTokens || 1n), simulated: false, note: 'landed late; fill estimated from the balance change' };
          }
        } catch {
          // fall through
        }
      }
      return { ok: false, error: `sent but did not land: ${confirmed.reason}` };
    }
    for (let i = 0; i < FETCH_FILL_TRIES; i++) {
      try {
        const tx = await getTransaction(sent.signature);
        const mine = tx ? parseLeaderTrades(tx, owner).find((t) => t.mint === req.mint && t.side === side) : undefined;
        if (mine && tx?.meta) {
          // Our own profit counts the network + priority fee we paid (the parser leaves the payer's fee out).
          const fee = BigInt(tx.meta.fee);
          const lamports = side === 'buy' ? mine.solLamports + fee : mine.solLamports > fee ? mine.solLamports - fee : 0n;
          return { ok: true, signature: sent.signature, tokens: mine.tokenAmount, lamports, simulated: false };
        }
      } catch (err) {
        log.warn('could not read the fill yet', { signature: sent.signature, error: safeErrorMessage(err) });
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    return { ok: true, signature: sent.signature, tokens: expectedTokens, lamports: expectedLamports, simulated: false, note: 'landed; fill estimated from the quote' };
  }
}
