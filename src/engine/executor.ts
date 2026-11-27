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
import { getConnection, getShortBlockhash } from '../chain/connection.js';
import { getTransaction } from '../chain/rpc.js';
import { log, safeErrorMessage } from '../log.js';
import { buildSignedTx } from '../tx/build.js';
import { feeLamports, withFee } from '../fee.js';
import { confirmSignature } from '../tx/confirm.js';
import { canSendLive, resend, sendTransaction, signatureOf } from '../tx/send.js';
import { programError } from '../tx/errors.js';
import { tipAccount, tipInstruction, tipLamports, tipRoute } from '../tx/tip.js';
import { appendInstruction, Jupiter, MAX_TRANSACTION_BYTES, ROUTE_SMALL } from '../venues/jupiter.js';
import { PfDispatcher } from '../venues/pf.js';
import { VenueError, type ResolvedPool } from '../venues/types.js';
import { walletChange, WSOL_MINT } from '../watch/parse.js';

export type FillResult =
  /** lamports: buy = SOL spent, every fee included; sell = SOL received net of every fee (negative when a small sell did not cover its own costs). */
  | {
      ok: true; signature: string; tokens: bigint; lamports: bigint; simulated: boolean; note?: string; feeLamports?: bigint;
      /** When the transaction was seen confirmed (the clock for timed sells starts here). */
      confirmedAt?: number;
      /** Live fills return at confirmation with an estimate; this resolves later with the exact SOL read from the transaction. */
      refine?: Promise<{ lamports: bigint } | null>;
    }
  /** `uncertain`: the transaction went out and its fate could not be read (the RPC did not answer): it may have landed. */
  | { ok: false; error: string; uncertain?: boolean };

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
  /** A sell of a position bought with real SOL: it goes out even while the owner's Live switch is off (the switch
   *  stops new real buys; it must not strand coins already bought). */
  exit?: boolean;
  /** Simulate before sending (a retry: one that cannot work then costs nothing). */
  checkFirst?: boolean;
  /** Told the transaction's signature the moment it is signed, before it is sent (so it can be written down). */
  onSigned?: (signature: string) => void;
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
  isLive(req: { live: boolean; exit?: boolean }): boolean;
  /** Optional: look the coin up ahead of the buy (the engine calls it while it checks the wallet's balance). */
  warm?(mint: string): Promise<void>;
  /** Optional: what became of a buy, from its own transaction (restore after a crash or an unknown outcome). Throws
   *  when the RPC cannot be read. */
  settleBuy?(signature: string, owner: string, mint: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' | 'not_found' }>;
}

const FETCH_FILL_TRIES = 6;
/** Native-route refusals that mean "not a coin this route can trade": use Jupiter instead. */
const USE_JUPITER = new Set(['unresolved', 'unsupported_pool', 'unsupported_quote', 'unsupported_program', 'migrating']);
/** Smaller routes leave room for our fee instruction; tried in order when a route does not fit. */
/** Smaller routes to fall back to when a transaction does not fit with our own transfers inside. */
const SMALLER_ROUTE_SIZES = [32, 20];
const QUOTE_CACHE_MS = 4_000;

export class ChainExecutor implements Executor {
  readonly pf = new PfDispatcher();
  readonly jup = new Jupiter(config.jupiterUrl, config.jupiterApiKey);
  private readonly viaJupiter = new Map<string, number>();
  private readonly tokenPrograms = new Map<string, PublicKey>();
  private readonly quoteCache = new Map<string, { at: number; lamports: bigint }>();

  isLive(req: { live: boolean; exit?: boolean }): boolean {
    // A sell of a position bought for real goes out even while the Live switch is off (only new buys stop).
    return req.live && (canSendLive() || (!!req.exit && !!config.rpcUrl));
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
    // One read: a token account's amount is a 64-bit number at byte 64 (classic and Token-2022 alike).
    if (info.data.length < 72) throw new Error('unexpected token account layout');
    return info.data.readBigUInt64LE(64);
  }

  /** SOL value of `amount` of any token (a stablecoin, another coin) — for leaders who did not pay in SOL. */
  async valueInSol(mint: string, amount: bigint): Promise<bigint> {
    if (mint === WSOL_MINT) return amount;
    const { quote } = await this.jup.route(mint, WSOL_MINT, amount, 100, false);
    return BigInt(quote.outAmount);
  }

  async quoteSell(mint: string, tokens: bigint): Promise<bigint> {
    const key = `${mint}:${tokens}`;
    const hit = this.quoteCache.get(key);
    if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) return hit.lamports;
    const lamports = await this.route(
      mint,
      async (pool) => {
        const out = await this.pf.venueFor(pool).quoteSell(pool, tokens);
        // A quote of nothing for something is not a price (a finished curve, a drained pool): no price this time.
        if (out === 0n && tokens > 0n) throw new Error('no price: the quote came back 0');
        return out;
      },
      // price checks never wait on retries: they must not hold up the clock that fires timed sells
      async () => BigInt((await this.jup.route(mint, WSOL_MINT, tokens, 100, false)).quote.outAmount),
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
        // What a coin IS does not change (not a pump.fun coin, priced in another token): Jupiter for an hour. A coin
        // that is only in between (its curve complete, its pool not there yet) is looked at again after 20 s.
        this.viaJupiter.set(mint, Date.now() + (err.code === 'migrating' ? 20_000 : 3_600_000));
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

  /** What became of a buy, from its own transaction: landed (exact tokens and SOL), failed, or not found (yet). */
  async settleBuy(signature: string, owner: string, mint: string): Promise<{ state: 'landed'; tokens: bigint; lamports: bigint } | { state: 'failed' | 'not_found' }> {
    const status = (await getConnection().getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (!status) return { state: 'not_found' };
    if (status.err) return { state: 'failed' };
    if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') return { state: 'not_found' };
    const got = await getTransaction(signature);
    const change = got ? walletChange(got, owner, mint) : null;
    if (!change || change.tokens <= 0n) return { state: 'failed' };
    return { state: 'landed', tokens: change.tokens, lamports: -change.lamports };
  }

  /** Looks the coin up ahead of its buy (cached for a minute), so the buy itself has one round trip less to wait for. */
  async warm(mint: string): Promise<void> {
    const until = this.viaJupiter.get(mint);
    if (until && until > Date.now()) return;
    await this.pf.resolve(mint).catch(() => undefined);
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
  private nativeTx(req: TradeRequest, instructions: TransactionInstruction[], buy = false) {
    const tipped = this.tip(req) > 0n;
    return buildSignedTx({
      signer: req.wallet, instructions, validatorTipSol: req.priorityFeeSol, txFeeSol: tipped ? req.tipSol : 0,
      tipAccount: tipped ? tipAccount(tipRoute(config.senderUrl)) : undefined,
      // A live buy lives only a few seconds: one that misses its moment must not fill half a minute later.
      shortLived: buy,
      ...(this.heavy.has(req.mint) ? { cuLimit: this.heavy.get(req.mint)! } : {}),
    });
  }

  /** Coins whose trades ran out of compute units once: their next transactions ask for twice the usual limit. */
  private readonly heavy = new Map<string, number>();

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
    const tx = await this.nativeTx(req, ixs.instructions, true);
    return this.sendAndRead(req, tx.tx, tx.lastValidBlockHeight, 'buy', built.expectedOut, req.lamports + ixs.fee + this.txCost(req), before, ixs.fee);
  }

  /**
   * A Jupiter swap with our fee and tip transfers appended, signed by the user.
   *
   * The route: within the small account limit when there is one, else Jupiter's default (a coin priced in USD1 or
   * another token needs more hops). A buy waits for a coin that is seconds old to be picked up; a sell never waits
   * (the engine retries it on its own clock). When the transaction does not fit in one packet with our transfers
   * inside, a smaller route is tried, and last the same route WITHOUT the tip: it then goes out through the RPC
   * with its priority fee only, which is slower to land but trades.
   */
  private async jupiterTx(req: TradeRequest, inputMint: string, outputMint: string, amount: bigint, feeOn: (outAmount: bigint) => bigint, buy = false) {
    const slippageBps = Math.round(req.slippagePct * 100);
    const found = await this.jup.route(inputMint, outputMint, amount, slippageBps, buy);
    const attempts: { size: number | null; tip: boolean }[] = [{ size: null, tip: true }];
    if (found.maxAccounts === ROUTE_SMALL) for (const size of SMALLER_ROUTE_SIZES) attempts.push({ size, tip: true });
    attempts.push({ size: null, tip: false });
    let lastErr: unknown;
    for (const attempt of attempts) {
      try {
        const quote = attempt.size === null ? found.quote : await this.jup.quote(inputMint, outputMint, amount, slippageBps, attempt.size, false);
        const { tx, lastValidBlockHeight } = await this.jup.swap(quote, req.wallet.publicKey, BigInt(Math.round(req.priorityFeeSol * 1e9)));
        const fee = config.feeWallet ? feeOn(BigInt(quote.outAmount)) : 0n;
        let signed: VersionedTransaction = tx;
        const extra: TransactionInstruction[] = [];
        if (fee > 0n) extra.push(SystemProgram.transfer({ fromPubkey: req.wallet.publicKey, toPubkey: new PublicKey(config.feeWallet), lamports: fee }));
        const tip = attempt.tip ? tipInstruction(req.wallet.publicKey, req.tipSol, tipRoute(config.senderUrl)) : null;
        if (tip) extra.push(tip);
        if (extra.length) {
          signed = await appendInstruction(tx, extra, async (keys) => (await Promise.all(keys.map((k) => getConnection().getAddressLookupTable(k)))).map((r) => r.value!).filter(Boolean));
        } else if (signed.serialize().length > MAX_TRANSACTION_BYTES) {
          throw new Error(`transaction too large: ${signed.serialize().length} bytes`);
        }
        let lastValid = lastValidBlockHeight;
        if (buy && this.isLive(req)) {
          // A live buy: our own blockhash with only a few seconds left, in place of Jupiter's fresh one.
          const bh = await getShortBlockhash();
          signed.message.recentBlockhash = bh.blockhash;
          lastValid = bh.lastValidBlockHeight;
        }
        signed.sign([req.wallet]);
        return { tx: signed, lastValidBlockHeight: lastValid, quote, fee, tip: tip ? this.tip(req) : 0n };
      } catch (err) {
        lastErr = err;
        // Does not fit, or no route that small: the next, lighter attempt. Anything else is a real failure.
        if (!/overrun|too large|encoding|no routes|could_not_find/i.test(String(err))) throw err;
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
        const { quote: q } = await this.jup.route(WSOL_MINT, req.mint, req.lamports, Math.round(req.slippagePct * 100), true);
        return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens: BigInt(q.outAmount), lamports: req.lamports + fee + cost, feeLamports: fee, simulated: true, note: 'test fill from the Jupiter quote (wallet too empty to simulate)' };
      }
      const built = await this.jupiterTx(req, WSOL_MINT, req.mint, req.lamports, feeOnBuy);
      const sim = await sendTransaction(built.tx, false);
      if (!sim.ok) return { ok: false, error: sim.error };
      return { ok: true, signature: sim.signature, tokens: BigInt(built.quote.outAmount), lamports: req.lamports + built.fee + cost, feeLamports: built.fee, simulated: true, note: 'Jupiter route simulated on-chain, not sent (test mode)' };
    }
    const [built, before] = await Promise.all([this.jupiterTx(req, WSOL_MINT, req.mint, req.lamports, feeOnBuy, true), this.tokenBalance(owner, req.mint).catch(() => null)]);
    return this.sendAndRead(req, built.tx, built.lastValidBlockHeight, 'buy', BigInt(built.quote.outAmount), req.lamports + built.fee + this.txCost(req), before, built.fee, built.tip);
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
      return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens: req.tokens, lamports: net, feeLamports: fee, simulated: true, note: 'test fill from the live quote' };
    }
    // A sell draws from the standard (associated) token account: never ask for more than it holds.
    const held = await this.ataBalance(req.mint, req.wallet.publicKey, pool.tokenProgram);
    const tokens = req.tokens > held ? held : req.tokens;
    if (tokens <= 0n) return { ok: false, error: 'the wallet holds none of this coin' };
    const built = await venue.buildSell({ pool, user: req.wallet.publicKey, tokensIn: tokens, slippagePct: req.slippagePct });
    const ixs = withFee(built.instructions, req.wallet.publicKey, built.expectedOut, req.feeBps, config.feeWallet);
    const tx = await this.nativeTx(req, ixs.instructions);
    return this.sendAndRead(req, tx.tx, tx.lastValidBlockHeight, 'sell', tokens, built.expectedOut - ixs.fee - this.txCost(req), held, ixs.fee);
  }

  private async jupiterSell(req: TradeRequest & { tokens: bigint }): Promise<FillResult> {
    const feeOnSell = (out: bigint) => feeLamports(out, req.feeBps);
    if (!this.isLive(req)) {
      const { quote: q } = await this.jup.route(req.mint, WSOL_MINT, req.tokens, Math.round(req.slippagePct * 100), false);
      const gross = BigInt(q.outAmount);
      const fee = config.feeWallet ? feeOnSell(gross) : 0n;
      const net = gross - fee - this.txCost(req);
      return { ok: true, signature: `PAPER_${Date.now().toString(36)}`, tokens: req.tokens, lamports: net, feeLamports: fee, simulated: true, note: 'test fill from the Jupiter quote' };
    }
    const held = await this.ataBalance(req.mint, req.wallet.publicKey);
    const tokens = req.tokens > held ? held : req.tokens;
    if (tokens <= 0n) return { ok: false, error: 'the wallet holds none of this coin' };
    const built = await this.jupiterTx(req, req.mint, WSOL_MINT, tokens, feeOnSell);
    return this.sendAndRead(req, built.tx, built.lastValidBlockHeight, 'sell', tokens, BigInt(built.quote.outAmount) - built.fee - this.txCost(req), held, built.fee, built.tip);
  }

  /**
   * Live path: send, then return THE MOMENT the transaction is confirmed (timed sells count from there), with the
   * tokens known and the SOL as quoted; the exact SOL is read from the confirmed transaction afterwards (`refine`).
   *
   * A transaction that errored or expired did not land, full stop. Only when the outcome is unknown (the RPC could
   * not be reached) does the wallet's balance decide, so a late landing is never left as orphaned coins. With
   * timed steps overlapping, another sell's balance change must not be mistaken for this one's.
   */
  private async sendAndRead(req: TradeRequest, tx: VersionedTransaction, lastValidBlockHeight: number, side: 'buy' | 'sell', expectedTokens: bigint, expectedLamports: bigint, balanceBefore: bigint | null, platformFee: bigint, tipCarried?: bigint): Promise<FillResult> {
    // The tip the transaction really carries decides its lanes (a Jupiter route too big for it goes without).
    const tip = tipCarried ?? this.tip(req);
    const sendOpts = { exit: !!req.exit, simulateFirst: !!req.checkFirst };
    const mine = signatureOf(tx);
    try { req.onSigned?.(mine); } catch { /* bookkeeping must not stop the trade */ }
    const t0 = Date.now();
    const sent = await sendTransaction(tx, true, tip, sendOpts);
    log.info('trade sent', { side, mint: req.mint, wallet: req.wallet.publicKey.toBase58(), signature: mine, ok: sent.ok, tip: Number(tip) / 1e9, priorityFee: req.priorityFeeSol, retry: !!req.checkFirst, ...(sent.ok ? {} : { error: sent.error }) });
    if (!sent.ok) return { ok: false, error: sent.error };
    // The owner switched live trading off while this was being built: it was only simulated. Nothing happened.
    if (sent.simulated) return { ok: false, error: 'live trading was switched off before this was sent' };
    // Until it lands, the same signed transaction is put out again about once a second (it can only land once).
    // A buy only for its first moments (it should land now or not at all); a sell until it lands.
    const confirmed = await confirmSignature(sent.signature, lastValidBlockHeight, { resend: () => resend(tx, tip, sendOpts.exit), ...(side === 'buy' ? { resendForMs: config.buyResendMs } : {}) });
    const owner = req.wallet.publicKey.toBase58();
    if (!confirmed.landed) {
      // Out of compute units: the retry (the engine retries a failed trade) asks for twice as many.
      if (/ComputationalBudgetExceeded|ProgramFailedToComplete|exceeded CUs/i.test(confirmed.reason)) this.heavy.set(req.mint, config.computeUnitLimit * 2);
      if (!confirmed.certain) {
        // The RPC never told us. By now the blockhash has long expired, so the wallet's balance settles it; if
        // even that cannot be read the outcome stays unknown ("uncertain"): the caller must not book it as failed.
        if (balanceBefore === null) return { ok: false, error: `sent, outcome unknown: ${confirmed.reason}`, uncertain: true };
        try {
          const after = await this.tokenBalance(owner, req.mint);
          const moved = side === 'buy' ? after - balanceBefore : balanceBefore - after;
          if (moved > 0n) {
            return { ok: true, signature: sent.signature, tokens: moved, lamports: side === 'buy' ? expectedLamports : (expectedLamports * moved) / (expectedTokens || 1n), simulated: false, feeLamports: platformFee, confirmedAt: Date.now(), note: 'landed late; fill estimated from the balance change' };
          }
        } catch {
          return { ok: false, error: `sent, outcome unknown: ${confirmed.reason}`, uncertain: true };
        }
      }
      // Landed and failed: the program's own words say why (slippage, a finished curve, not enough SOL, …).
      let reason = confirmed.reason;
      if (/errored/.test(reason)) {
        const detail = await getTransaction(sent.signature).then((t) => programError(t?.meta?.logMessages)).catch(() => null);
        if (detail) reason = `${reason} (${detail})`;
        if (/ComputationalBudgetExceeded|exceeded CUs/i.test(reason)) this.heavy.set(req.mint, config.computeUnitLimit * 2);
      }
      log.warn('trade did not land', { side, mint: req.mint, signature: sent.signature, ms: Date.now() - t0, reason });
      return { ok: false, error: `sent but did not land: ${reason}` };
    }
    log.info('trade landed', { side, mint: req.mint, signature: sent.signature, ms: Date.now() - t0 });
    const confirmedAt = Date.now();
    const exact = this.readFill(sent.signature, owner, req.mint, side);
    const refine = exact.then((r) => (r ? { lamports: r.lamports } : null));
    const base = { ok: true as const, signature: sent.signature, simulated: false, feeLamports: platformFee, confirmedAt };
    if (side === 'sell') return { ...base, tokens: expectedTokens, lamports: expectedLamports, refine };
    // A buy: the bag is what the wallet really received, read at once as the change in its balance.
    if (balanceBefore !== null) {
      try {
        const after = await this.tokenBalance(owner, req.mint);
        if (after > balanceBefore) return { ...base, tokens: after - balanceBefore, lamports: expectedLamports, refine };
      } catch {
        // fall through to the transaction itself
      }
    }
    const r = await exact;
    return { ...base, tokens: r?.tokens ?? expectedTokens, lamports: r?.lamports ?? expectedLamports, ...(r ? {} : { note: 'landed; fill estimated from the quote' }) };
  }

  /** What our confirmed transaction really did: tokens moved and SOL spent / received, fees included. */
  private async readFill(signature: string, owner: string, mint: string, side: 'buy' | 'sell'): Promise<{ tokens: bigint; lamports: bigint } | null> {
    for (let i = 0; i < FETCH_FILL_TRIES; i++) {
      try {
        const got = await getTransaction(signature);
        // Exactly what this transaction did to the wallet: everything it paid (network and priority fee, tip,
        // platform fee) is inside. A sell that did not cover its own costs is a small loss, never rounded to zero.
        const change = got ? walletChange(got, owner, mint) : null;
        if (change && (side === 'buy' ? change.tokens > 0n : change.tokens < 0n)) {
          return side === 'buy' ? { tokens: change.tokens, lamports: -change.lamports } : { tokens: -change.tokens, lamports: change.lamports };
        }
      } catch (err) {
        log.warn('could not read the fill yet', { signature, error: safeErrorMessage(err) });
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    return null;
  }
}
