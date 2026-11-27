// How a copy's buys and sells reach the chain. The engine talks to the `Executor` interface; tests use a fake.
//
// Two routes, picked per coin:
//  * native: pump.fun bonding curve and PumpSwap, built with pump.fun's official SDKs (fastest, no third party);
//  * Jupiter: everything else — any launchpad, any DEX, coins paired with USDC / USD1 / anything, PumpSwap pools set
//    up the other way round. A coin the native route refuses is remembered and routed through Jupiter from then on.
//
// Modes:
//  * live (copy set to live AND server LIVE_TRADING=true): build → send → confirm → read the real fill (tokens and
//    SOL) from our own confirmed transaction, with the same balance parser used for leaders.
//  * test: the buy is built and simulated with the user's real wallet when it holds enough SOL (proving it would go
//    through), the fill is the real quote, nothing is sent. Sells are filled from the quote.
// The platform fee rides inside the same transaction as the trade on both routes.
import { PublicKey, SystemProgram, type Keypair, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config } from '../config.js';
import { getConnection } from '../chain/connection.js';
import { getTransaction } from '../chain/rpc.js';
import { log, safeErrorMessage } from '../log.js';
import { buildSignedTx } from '../tx/build.js';
import { feeLamports, withFee } from '../fee.js';
import { confirmSignature } from '../tx/confirm.js';
import { canSendLive, sendTransaction } from '../tx/send.js';
import { tipAccount, tipInstruction, tipLamports, tipRoute } from '../tx/tip.js';
import { appendInstruction, Jupiter } from '../venues/jupiter.js';
import { PfDispatcher } from '../venues/pf.js';
import { VenueError, type ResolvedPool } from '../venues/types.js';
import { parseLeaderTrades, WSOL_MINT } from '../watch/parse.js';

export type FillResult =
  /** lamports: buy = SOL spent, platform fee included; sell = SOL received, platform fee taken off. */
  | { ok: true; signature: string; tokens: bigint; lamports: bigint; simulated: boolean; note?: string; feeLamports?: bigint }
  | { ok: false; error: string };

export interface TradeRequest {
  wallet: Keypair;
  mint: string;
  slippagePct: number;
  priorityFeeSol: number;
  /** Tip to the block builder (Jito), in SOL; 0 = none. With a tip the transaction also goes through Jito. */
  tipSol: number;
  /** The copy is set to live. Sent only if the server is live too. */
  live: boolean;
  /** Platform fee in basis points for this user (0 = none). */
  feeBps: number;
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
/** Native-route refusals that mean "not a coin this route can trade": use Jupiter instead. */
const USE_JUPITER = new Set(['unresolved', 'unsupported_pool', 'unsupported_quote', 'unsupported_program', 'migrating']);
/** Smaller routes leave room for our fee instruction; tried in order when a route does not fit. */
const ROUTE_SIZES = [48, 32, 20];
const QUOTE_CACHE_MS = 4_000;

export class ChainExecutor implements Executor {
  readonly pf = new PfDispatcher();
  readonly jup = new Jupiter(config.jupiterUrl, config.jupiterApiKey);
  private readonly viaJupiter = new Map<string, number>();
  private readonly tokenPrograms = new Map<string, PublicKey>();
  private readonly quoteCache = new Map<string, { at: number; lamports: bigint }>();

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

  private async tokenProgramOf(mint: string): Promise<PublicKey> {
    const hit = this.tokenPrograms.get(mint);
    if (hit) return hit;
    const info = await getConnection().getAccountInfo(new PublicKey(mint), 'confirmed');
    if (!info) throw new Error(`mint ${mint} not found`);
    this.tokenPrograms.set(mint, info.owner);
    return info.owner;
  }

  /** Balance of the owner's associated token account; 0 only when the account does not exist, errors throw. */
  private async ataBalance(mint: string, owner: PublicKey, tokenProgram?: PublicKey): Promise<bigint> {
    const program = tokenProgram ?? (await this.tokenProgramOf(mint));
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, program);
    const info = await getConnection().getAccountInfo(ata, 'confirmed');
    if (!info) return 0n;
    const bal = await getConnection().getTokenAccountBalance(ata, 'confirmed');
    return BigInt(bal.value.amount);
  }

  /** SOL value of `amount` of any token (a stablecoin, another coin) — for leaders who did not pay in SOL. */
  async valueInSol(mint: string, amount: bigint): Promise<bigint> {
    if (mint === WSOL_MINT) return amount;
    const q = await this.jup.quote(mint, WSOL_MINT, amount, 100, 48, false);
    return BigInt(q.outAmount);
  }

  async quoteSell(mint: string, tokens: bigint): Promise<bigint> {
    const key = `${mint}:${tokens}`;
    const hit = this.quoteCache.get(key);
    if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) return hit.lamports;
    const lamports = await this.route(
      mint,
      (pool) => this.pf.venueFor(pool).quoteSell(pool, tokens),
      // price checks never wait on retries: they must not hold up the clock that fires timed sells
      async () => BigInt((await this.jup.quote(mint, WSOL_MINT, tokens, 100, 48, false)).outAmount),
    );
    this.quoteCache.set(key, { at: Date.now(), lamports });
    if (this.quoteCache.size > 5_000) this.quoteCache.clear();
    return lamports;
  }

  /** Native route when it can trade the coin, Jupiter otherwise (and from then on, for an hour). */
  private async route<T>(mint: string, native: (pool: ResolvedPool) => Promise<T>, jupiter: () => Promise<T>): Promise<T> {
    const until = this.viaJupiter.get(mint);
    if (until && until > Date.now()) return jupiter();
    try {
      return await this.withPool(mint, native);
    } catch (err) {
      if (err instanceof VenueError && USE_JUPITER.has(err.code)) {
        this.viaJupiter.set(mint, Date.now() + 3_600_000);
        return jupiter();
      }
      throw err;
    }
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

  // ── buy ────────────────────────────────────────────────────────────────
  async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    try {
      return await this.route(req.mint, (pool) => this.nativeBuy(req, pool), () => this.jupiterBuy(req));
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  }

  private reserve(): bigint {
    return BigInt(Math.round(config.feeReserveSol * 1e9));
  }

  /** What one transaction costs besides the trade itself: base fee + priority fee + tip (counted in test fills). */
  private txCost(req: TradeRequest): bigint {
    return 5_000n + BigInt(Math.round(Math.max(0, req.priorityFeeSol) * 1e9)) + this.tip(req);
  }

  /** The tip this request carries, in lamports (0 when unset or under the route's minimum). */
  private tip(req: TradeRequest): bigint {
    return tipLamports(req.tipSol, tipRoute(config.senderUrl));
  }

  /** Sign a native transaction: priority fee, the trade, our platform fee, then the tip when one is set. */
  private nativeTx(req: TradeRequest, instructions: TransactionInstruction[]) {
    const tipped = this.tip(req) > 0n;
    return buildSignedTx({
      signer: req.wallet, instructions, validatorTipSol: req.priorityFeeSol, txFeeSol: tipped ? req.tipSol : 0,
      tipAccount: tipped ? tipAccount(tipRoute(config.senderUrl)) : undefined,
    });
  }

  private async nativeBuy(req: TradeRequest & { lamports: bigint }, pool: ResolvedPool): Promise<FillResult> {
    const venue = this.pf.venueFor(pool);
    const owner = req.wallet.publicKey.toBase58();
    if (!this.isLive(req)) {
      const tokens = await venue.quoteBuy(pool, req.lamports);
      if (tokens <= 0n) return { ok: false, error: 'the quote returned zero tokens' };
      const fee = config.feeWallet ? feeLamports(req.lamports, req.feeBps) : 0n;
      const cost = this.txCost(req);
      if ((await this.solBalance(owner)) < req.lamports + fee + cost + this.reserve()) {
        return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens, lamports: req.lamports + fee + cost, feeLamports: fee, simulated: true, note: 'test fill from the live quote (wallet too empty to simulate)' };
      }
      const built = await venue.buildBuy({ pool, user: req.wallet.publicKey, lamportsIn: req.lamports, slippagePct: req.slippagePct });
      const ixs = withFee(built.instructions, req.wallet.publicKey, req.lamports, req.feeBps, config.feeWallet);
      const tx = await this.nativeTx(req, ixs.instructions);
      const sim = await sendTransaction(tx.tx, false);
      if (!sim.ok) return { ok: false, error: sim.error };
      return { ok: true, signature: sim.signature, tokens, lamports: req.lamports + ixs.fee + cost, feeLamports: ixs.fee, simulated: true, note: 'simulated on-chain, not sent (test mode)' };
    }
    const [built, before] = await Promise.all([
      venue.buildBuy({ pool, user: req.wallet.publicKey, lamportsIn: req.lamports, slippagePct: req.slippagePct }),
      this.tokenBalance(owner, req.mint).catch(() => null),
    ]);
    // The fee transfer rides in the same transaction, after the swap: no trade, no fee.
    const ixs = withFee(built.instructions, req.wallet.publicKey, req.lamports, req.feeBps, config.feeWallet);
    const tx = await this.nativeTx(req, ixs.instructions);
    return this.sendAndRead(req, tx.tx, tx.lastValidBlockHeight, 'buy', built.expectedOut, req.lamports + ixs.fee, before, ixs.fee);
  }

  /** A Jupiter swap with our fee transfer appended, signed by the user; smaller routes are tried if it does not fit. */
  private async jupiterTx(req: TradeRequest, inputMint: string, outputMint: string, amount: bigint, feeOn: (outAmount: bigint) => bigint) {
    let lastErr: unknown;
    for (const size of ROUTE_SIZES) {
      try {
        const quote = await this.jup.quote(inputMint, outputMint, amount, Math.round(req.slippagePct * 100), size);
        const { tx, lastValidBlockHeight } = await this.jup.swap(quote, req.wallet.publicKey, BigInt(Math.round(req.priorityFeeSol * 1e9)));
        const fee = config.feeWallet ? feeOn(BigInt(quote.outAmount)) : 0n;
        let signed: VersionedTransaction = tx;
        const extra: TransactionInstruction[] = [];
        if (fee > 0n) extra.push(SystemProgram.transfer({ fromPubkey: req.wallet.publicKey, toPubkey: new PublicKey(config.feeWallet), lamports: fee }));
        const tip = tipInstruction(req.wallet.publicKey, req.tipSol, tipRoute(config.senderUrl));
        if (tip) extra.push(tip);
        if (extra.length) {
          signed = await appendInstruction(tx, extra, async (keys) => (await Promise.all(keys.map((k) => getConnection().getAddressLookupTable(k)))).map((r) => r.value!).filter(Boolean));
        }
        signed.sign([req.wallet]);
        return { tx: signed, lastValidBlockHeight, quote, fee };
      } catch (err) {
        lastErr = err;
        if (!/overrun|too large|encoding/i.test(String(err))) throw err;
      }
    }
    throw lastErr;
  }

  private async jupiterBuy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    const owner = req.wallet.publicKey.toBase58();
    const feeOnBuy = () => feeLamports(req.lamports, req.feeBps);
    if (!this.isLive(req)) {
      const fee = config.feeWallet ? feeOnBuy() : 0n;
      const cost = this.txCost(req);
      if ((await this.solBalance(owner)) < req.lamports + fee + cost + this.reserve()) {
        const q = await this.jup.quote(WSOL_MINT, req.mint, req.lamports, Math.round(req.slippagePct * 100));
        return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens: BigInt(q.outAmount), lamports: req.lamports + fee + cost, feeLamports: fee, simulated: true, note: 'test fill from the Jupiter quote (wallet too empty to simulate)' };
      }
      const built = await this.jupiterTx(req, WSOL_MINT, req.mint, req.lamports, feeOnBuy);
      const sim = await sendTransaction(built.tx, false);
      if (!sim.ok) return { ok: false, error: sim.error };
      return { ok: true, signature: sim.signature, tokens: BigInt(built.quote.outAmount), lamports: req.lamports + built.fee + cost, feeLamports: built.fee, simulated: true, note: 'Jupiter route simulated on-chain, not sent (test mode)' };
    }
    const [built, before] = await Promise.all([this.jupiterTx(req, WSOL_MINT, req.mint, req.lamports, feeOnBuy), this.tokenBalance(owner, req.mint).catch(() => null)]);
    return this.sendAndRead(req, built.tx, built.lastValidBlockHeight, 'buy', BigInt(built.quote.outAmount), req.lamports + built.fee, before, built.fee);
  }

  // ── sell ───────────────────────────────────────────────────────────────
  async sell(req: TradeRequest & { tokens: bigint }): Promise<FillResult> {
    try {
      return await this.route(req.mint, (pool) => this.nativeSell(req, pool), () => this.jupiterSell(req));
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  }

  private async nativeSell(req: TradeRequest & { tokens: bigint }, pool: ResolvedPool): Promise<FillResult> {
    const venue = this.pf.venueFor(pool);
    if (!this.isLive(req)) {
      const gross = await venue.quoteSell(pool, req.tokens);
      const fee = config.feeWallet ? feeLamports(gross, req.feeBps) : 0n;
      const net = gross - fee - this.txCost(req);
      return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens: req.tokens, lamports: net > 0n ? net : 0n, feeLamports: fee, simulated: true, note: 'test fill from the live quote' };
    }
    // A sell draws from the standard (associated) token account: never ask for more than it holds.
    const held = await this.ataBalance(req.mint, req.wallet.publicKey, pool.tokenProgram);
    const tokens = req.tokens > held ? held : req.tokens;
    if (tokens <= 0n) return { ok: false, error: 'the wallet holds none of this coin' };
    const built = await venue.buildSell({ pool, user: req.wallet.publicKey, tokensIn: tokens, slippagePct: req.slippagePct });
    const ixs = withFee(built.instructions, req.wallet.publicKey, built.expectedOut, req.feeBps, config.feeWallet);
    const tx = await this.nativeTx(req, ixs.instructions);
    return this.sendAndRead(req, tx.tx, tx.lastValidBlockHeight, 'sell', tokens, built.expectedOut - ixs.fee, held, ixs.fee);
  }

  private async jupiterSell(req: TradeRequest & { tokens: bigint }): Promise<FillResult> {
    const feeOnSell = (out: bigint) => feeLamports(out, req.feeBps);
    if (!this.isLive(req)) {
      const q = await this.jup.quote(req.mint, WSOL_MINT, req.tokens, Math.round(req.slippagePct * 100));
      const gross = BigInt(q.outAmount);
      const fee = config.feeWallet ? feeOnSell(gross) : 0n;
      const net = gross - fee - this.txCost(req);
      return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens: req.tokens, lamports: net > 0n ? net : 0n, feeLamports: fee, simulated: true, note: 'test fill from the Jupiter quote' };
    }
    const held = await this.ataBalance(req.mint, req.wallet.publicKey);
    const tokens = req.tokens > held ? held : req.tokens;
    if (tokens <= 0n) return { ok: false, error: 'the wallet holds none of this coin' };
    const built = await this.jupiterTx(req, req.mint, WSOL_MINT, tokens, feeOnSell);
    return this.sendAndRead(req, built.tx, built.lastValidBlockHeight, 'sell', tokens, BigInt(built.quote.outAmount) - built.fee, held, built.fee);
  }

  /**
   * Live path: send, confirm (until the blockhash expires), then read what really happened from our own confirmed
   * transaction. If confirmation is unknown or says "not landed", the wallet's balance of the coin decides: a
   * transaction that landed late is still recorded as a fill, never left as orphaned coins.
   */
  private async sendAndRead(req: TradeRequest, tx: VersionedTransaction, lastValidBlockHeight: number, side: 'buy' | 'sell', expectedTokens: bigint, expectedLamports: bigint, balanceBefore: bigint | null, platformFee: bigint): Promise<FillResult> {
    const sent = await sendTransaction(tx, true, this.tip(req));
    if (!sent.ok) return { ok: false, error: sent.error };
    const confirmed = await confirmSignature(sent.signature, lastValidBlockHeight);
    const owner = req.wallet.publicKey.toBase58();
    if (!confirmed.landed) {
      if (balanceBefore !== null) {
        try {
          const after = await this.tokenBalance(owner, req.mint);
          const moved = side === 'buy' ? after - balanceBefore : balanceBefore - after;
          if (moved > 0n) {
            return { ok: true, signature: sent.signature, tokens: moved, lamports: side === 'buy' ? expectedLamports : (expectedLamports * moved) / (expectedTokens || 1n), simulated: false, feeLamports: platformFee, note: 'landed late; fill estimated from the balance change' };
          }
        } catch {
          // fall through
        }
      }
      return { ok: false, error: `sent but did not land: ${confirmed.reason}` };
    }
    for (let i = 0; i < FETCH_FILL_TRIES; i++) {
      try {
        const got = await getTransaction(sent.signature);
        const mine = got ? parseLeaderTrades(got, owner).find((t) => t.mint === req.mint && t.side === side) : undefined;
        if (mine && got?.meta) {
          // Our own profit counts the network + priority fee we paid (the parser leaves the payer's fee out). The
          // platform fee transfer is already in the wallet's SOL change.
          const fee = BigInt(got.meta.fee);
          const lamports = side === 'buy' ? mine.solLamports + fee : mine.solLamports > fee ? mine.solLamports - fee : 0n;
          return { ok: true, signature: sent.signature, tokens: mine.tokenAmount, lamports, simulated: false, feeLamports: platformFee };
        }
      } catch (err) {
        log.warn('could not read the fill yet', { signature: sent.signature, error: safeErrorMessage(err) });
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    return { ok: true, signature: sent.signature, tokens: expectedTokens, lamports: expectedLamports, simulated: false, feeLamports: platformFee, note: 'landed; fill estimated from the quote' };
  }
}
