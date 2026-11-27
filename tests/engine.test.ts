import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Engine } from '../src/engine/engine.js';
import type { Executor, FillResult, TradeRequest } from '../src/engine/executor.js';
import { validateSettings, type CopySettings } from '../src/engine/settings.js';
import { Store } from '../src/store.js';
import type { LeaderTrade } from '../src/watch/parse.js';

const LEADER = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
const MINT = 'EYS1CfL4EM8UXfAeuffB1mKKBJJHr1MnPeMvSzuopump';
const SOL = 1_000_000_000n;

/** A fake market: 1 SOL buys 1,000,000 tokens; price can be moved; wallets have balances. */
class FakeExecutor implements Executor {
  price = 1_000_000n; // tokens per SOL
  sol = 10n * SOL;
  live = false;
  buys: (TradeRequest & { lamports: bigint })[] = [];
  sells: (TradeRequest & { tokens: bigint })[] = [];
  failNextSell = 0;
  sellDelayMs = 0;
  held = 0n;
  async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
    this.buys.push(req);
    const tokens = (req.lamports * this.price) / SOL;
    this.held += tokens;
    return { ok: true, signature: `B${this.buys.length}`, tokens, lamports: req.lamports, simulated: !this.live };
  }
  async sell(req: TradeRequest & { tokens: bigint }): Promise<FillResult> {
    if (this.sellDelayMs) await new Promise((r) => setTimeout(r, this.sellDelayMs));
    if (this.failNextSell > 0) {
      this.failNextSell--;
      return { ok: false, error: 'boom' };
    }
    this.sells.push(req);
    const tokens = req.tokens > this.held && this.live ? this.held : req.tokens;
    this.held -= tokens;
    return { ok: true, signature: `S${this.sells.length}`, tokens, lamports: (tokens * SOL) / this.price, simulated: !this.live };
  }
  async quoteSell(_mint: string, tokens: bigint) {
    return (tokens * SOL) / this.price;
  }
  async solBalance() {
    return this.sol;
  }
  async tokenBalance() {
    return this.held;
  }
  isLive(req: { live: boolean }) {
    return req.live && this.live;
  }
}

function trade(over: Partial<LeaderTrade> = {}): LeaderTrade {
  return {
    signature: `sig${Math.random()}`, leader: LEADER, mint: MINT, side: 'buy', solLamports: 2n * SOL, tokenAmount: 2_000_000n,
    tokensBefore: 0n, tokensAfter: 2_000_000n, venue: 'pumpfun', slot: 1, blockTime: null, ...over,
  };
}

let store: Store;
let ex: FakeExecutor;
let clock: number;
let engine: Engine;
let userId: number;
const wallet = Keypair.generate();

function addCopy(patch: Record<string, unknown> = {}): { id: number; s: CopySettings } {
  const s = validateSettings({ leader: LEADER, buySol: 0.1, minLeaderBuySol: 1, ...patch });
  return { id: store.createCopy(userId, s), s };
}

beforeEach(() => {
  store = new Store(':memory:');
  ex = new FakeExecutor();
  clock = 1_000_000;
  userId = store.createUser('alice', 'x');
  store.setWallet(userId, wallet.publicKey.toBase58(), 'enc');
  engine = new Engine({ store, executor: ex, walletFor: (id) => (id === userId ? wallet : null), now: () => clock, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
});

const open = () => store.activePositions(userId);
const feed = () => store.events(userId).map((e) => `${e.kind}: ${e.message}`);

describe('copying buys', () => {
  it('buys the copy amount when the leader buys at least the minimum', async () => {
    addCopy({ sell: { mirror: { enabled: false } } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    expect(ex.buys).toHaveLength(1);
    expect(ex.buys[0]!.lamports).toBe(SOL / 10n);
    expect(open()).toHaveLength(1);
    expect(open()[0]).toMatchObject({ status: 'open', tokensHeld: 100_000n, costLamports: SOL / 10n });
  });

  it('skips a leader buy under the minimum, with the reason in the feed', async () => {
    addCopy();
    await engine.onLeaderTrade(trade({ solLamports: SOL / 2n }));
    await engine.idle();
    expect(ex.buys).toHaveLength(0);
    expect(feed()[0]).toMatch(/skip.*0\.5 SOL.*1 SOL minimum/);
  });

  it('acts on a leader transaction once, however many times it arrives', async () => {
    addCopy();
    const t = trade();
    await Promise.all([engine.onLeaderTrade(t), engine.onLeaderTrade(t)]);
    await engine.onLeaderTrade(t);
    await engine.idle();
    expect(ex.buys).toHaveLength(1);
  });

  it('does not buy a coin it already holds, nor (once per coin) one it already traded', async () => {
    addCopy({ sell: { mirror: { enabled: true, mode: 'all' } } });
    await engine.onLeaderTrade(trade());
    await engine.onLeaderTrade(trade());
    await engine.idle();
    expect(ex.buys).toHaveLength(1);
    await engine.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 0n, tokenAmount: 2_000_000n }));
    await engine.idle();
    expect(open()).toHaveLength(0);
    await engine.onLeaderTrade(trade());
    await engine.idle();
    expect(ex.buys).toHaveLength(1);
  });

  it('skips a live buy when the wallet lacks the SOL', async () => {
    ex.live = true;
    ex.sol = SOL / 20n;
    addCopy({ mode: 'live' });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    expect(ex.buys).toHaveLength(0);
    expect(feed()[0]).toMatch(/skip.*0\.05 SOL/);
  });

  it('skips a buy above the server cap', async () => {
    addCopy({ buySol: 2 });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    expect(ex.buys).toHaveLength(0);
    expect(feed()[0]).toMatch(/skip.*limit/i);
  });

  it('ignores disabled copies and other leaders; serves every user following the leader', async () => {
    addCopy({ enabled: false });
    const bob = store.createUser('bob', 'x');
    store.createCopy(bob, validateSettings({ leader: LEADER, buySol: 0.2, minLeaderBuySol: 1 }));
    const bobWallet = Keypair.generate();
    engine = new Engine({ store, executor: ex, walletFor: (id) => (id === bob ? bobWallet : id === userId ? wallet : null), now: () => clock, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
    await engine.onLeaderTrade(trade({ leader: 'Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA' }));
    await engine.onLeaderTrade(trade());
    await engine.idle();
    expect(ex.buys.map((b) => b.wallet.publicKey.toBase58())).toEqual([bobWallet.publicKey.toBase58()]);
  });

  it('ignores stale leader trades (older than a minute)', async () => {
    addCopy();
    await engine.onLeaderTrade(trade({ blockTime: Math.floor(clock / 1000) - 120 }));
    await engine.idle();
    expect(ex.buys).toHaveLength(0);
  });
});

describe('sell when they sell', () => {
  it('sells the same share of our bag', async () => {
    addCopy({ sell: { mirror: { enabled: true, mode: 'same' } } });
    await engine.onLeaderTrade(trade());
    await engine.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 1_500_000n, tokenAmount: 500_000n }));
    await engine.idle();
    expect(ex.sells[0]!.tokens).toBe(25_000n);
    expect(open()[0]!.tokensHeld).toBe(75_000n);
    expect(feed()[0]).toMatch(/sell.*25%.*they sold/i);
  });

  it("'all' sells everything and closes the position with its profit", async () => {
    addCopy({ sell: { mirror: { enabled: true, mode: 'all' } } });
    await engine.onLeaderTrade(trade());
    ex.price = 500_000n; // price doubled
    await engine.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 1_900_000n, tokenAmount: 100_000n }));
    await engine.idle();
    expect(open()).toHaveLength(0);
    const [closed] = store.closedPositions(userId);
    expect(closed).toMatchObject({ status: 'closed', tokensHeld: 0n, proceedsLamports: SOL / 5n });
  });

  it('a sell by the leader before our buy finished still sells after it', async () => {
    addCopy({ sell: { mirror: { enabled: true, mode: 'all' } } });
    const buy = engine.onLeaderTrade(trade());
    const sell = engine.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 0n, tokenAmount: 2_000_000n }));
    await Promise.all([buy, sell]);
    await engine.idle();
    expect(open()).toHaveLength(0);
  });

  it('mirror off: a leader sell changes nothing', async () => {
    addCopy({ sell: { mirror: { enabled: false } } });
    await engine.onLeaderTrade(trade());
    await engine.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 0n, tokenAmount: 2_000_000n }));
    await engine.idle();
    expect(ex.sells).toHaveLength(0);
  });
});

describe('timed sells, stop loss, dead coin', () => {
  it('25 % → 50 % → 100 % at 3 s intervals empties the bag', async () => {
    addCopy({ sell: { mirror: { enabled: false }, timed: [{ afterSec: 3, percent: 25 }, { afterSec: 6, percent: 50 }, { afterSec: 9, percent: 100 }] } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    clock += 3000; await engine.tick(); await engine.idle();
    expect(open()[0]!.tokensHeld).toBe(75_000n);
    clock += 3000; await engine.tick(); await engine.idle();
    expect(open()[0]!.tokensHeld).toBe(37_500n);
    await engine.tick(); await engine.idle(); // nothing new due
    expect(ex.sells).toHaveLength(2);
    clock += 3000; await engine.tick(); await engine.idle();
    expect(open()).toHaveLength(0);
    expect(ex.sells.map((s) => s.tokens)).toEqual([25_000n, 37_500n, 37_500n]);
  });

  it('a stop loss level fires once when the price falls through it', async () => {
    addCopy({ sell: { mirror: { enabled: false }, stopLoss: [{ lossPct: 30, percent: 50 }] } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    ex.price = 1_250_000n; // −20 %
    await engine.tick(); await engine.idle();
    expect(ex.sells).toHaveLength(0);
    ex.price = 1_500_000n; // −33 %
    await engine.tick(); await engine.idle();
    await engine.tick(); await engine.idle();
    expect(ex.sells).toHaveLength(1);
    expect(open()[0]!.tokensHeld).toBe(50_000n);
  });

  it('dead coin: sells everything when the price has not moved for idleSec', async () => {
    addCopy({ sell: { mirror: { enabled: false }, deadCoin: { enabled: true, idleSec: 30 } } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    clock += 20_000; ex.price = 990_000n; await engine.tick(); await engine.idle(); // a trade happened: timer resets
    clock += 20_000; await engine.tick(); await engine.idle();
    expect(open()).toHaveLength(1);
    clock += 11_000; await engine.tick(); await engine.idle();
    expect(open()).toHaveLength(0);
  });

  it('two sells due together run one after the other on what is left', async () => {
    ex.sellDelayMs = 5;
    addCopy({ sell: { mirror: { enabled: true, mode: 'same' }, timed: [{ afterSec: 1, percent: 50 }] } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    clock += 1000;
    const a = engine.tick();
    const b = engine.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 1_000_000n, tokenAmount: 1_000_000n }));
    await Promise.all([a, b]);
    await engine.idle();
    expect(ex.sells.map((s) => s.tokens)).toEqual([50_000n, 25_000n]);
    expect(open()[0]!.tokensHeld).toBe(25_000n);
  });

  it('a failed sell is retried a quarter of a second later, not on every tick', async () => {
    addCopy({ sell: { mirror: { enabled: false }, timed: [{ afterSec: 1, percent: 100 }] } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    ex.failNextSell = 1;
    clock += 1000; await engine.tick(); await engine.idle();
    clock += 100; await engine.tick(); await engine.idle(); // retry not due yet (0.25 s pause)
    expect(open()).toHaveLength(1);
    expect(feed().filter((f) => /retrying/.test(f))).toHaveLength(1);
    clock += 200; await engine.tick(); await engine.idle();
    expect(open()).toHaveLength(0);
  });

  it('a sell of everything never gives up: after the quick tries it keeps trying, and says so once', async () => {
    addCopy({ sell: { mirror: { enabled: false }, timed: [{ afterSec: 1, percent: 100 }] } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    ex.failNextSell = 100;
    for (let i = 0; i < 12; i++) { clock += 61_000; await engine.tick(); await engine.idle(); }
    expect(open()).toHaveLength(1);
    expect(feed().some((f) => /gave up/i.test(f))).toBe(false);
    expect(feed().filter((f) => /still trying/.test(f))).toHaveLength(1);
    ex.failNextSell = 0;
    clock += 61_000; await engine.tick(); await engine.idle();
    expect(open()).toHaveLength(0); // it sold as soon as selling worked again
  });

  it('a sell of a PART gives up after 8 tries (later rules sell what is left) and says so', async () => {
    addCopy({ sell: { mirror: { enabled: false }, timed: [{ afterSec: 1, percent: 50 }] } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    ex.failNextSell = 100;
    for (let i = 0; i < 12; i++) { clock += 61_000; await engine.tick(); await engine.idle(); }
    expect(open()).toHaveLength(1);
    expect(feed().some((f) => /gave up.*8 failed tries/i.test(f))).toBe(true);
    ex.failNextSell = 0;
    const attempts = ex.sells.length;
    clock += 61_000; await engine.tick(); await engine.idle();
    expect(ex.sells.length).toBe(attempts); // given up: no more automatic tries for that step
  });

  it('a failed "sell when they sell" is retried too', async () => {
    addCopy({ sell: { mirror: { enabled: true, mode: 'all' } } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    ex.failNextSell = 1;
    await engine.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 0n, tokenAmount: 2_000_000n }));
    await engine.idle();
    expect(open()).toHaveLength(1);
    clock += 2000; await engine.tick(); await engine.idle();
    expect(open()).toHaveLength(0);
  });

  it('rate-limit errors read in plain words', async () => {
    addCopy({ sell: { mirror: { enabled: false } } });
    ex.buy = async () => ({ ok: false, error: 'failed to get info about account X: Error: 429 Too Many Requests: {"jsonrpc":"2.0"}' });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    expect(feed()[0]).toMatch(/RPC is busy/);
  });

  it('after a restart, overdue timed sells fire straight away', async () => {
    addCopy({ sell: { mirror: { enabled: false }, timed: [{ afterSec: 5, percent: 100 }] } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    clock += 60_000;
    const restarted = new Engine({ store, executor: ex, walletFor: () => wallet, now: () => clock, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
    await restarted.tick();
    await restarted.idle();
    expect(open()).toHaveLength(0);
  });

  it('Sell now sells the whole position', async () => {
    addCopy({ sell: { mirror: { enabled: false } } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    const [p] = open();
    expect(await engine.sellNow(userId, p!.id)).toEqual({ ok: true });
    expect(open()).toHaveLength(0);
    expect(await engine.sellNow(userId + 1, p!.id)).toMatchObject({ ok: false });
  });

  it('live: the bag is re-read from the chain after each sell (a manual sell elsewhere is noticed)', async () => {
    ex.live = true;
    addCopy({ mode: 'live', sell: { mirror: { enabled: false }, timed: [{ afterSec: 1, percent: 50 }] } });
    await engine.onLeaderTrade(trade());
    await engine.idle();
    ex.held = 20_000n; // the user sold most of it by hand in another app
    clock += 1000; await engine.tick(); await engine.idle();
    expect(ex.sells[0]!.tokens).toBe(10_000n);
    expect(open()[0]!.tokensHeld).toBe(10_000n);
  });
});

describe('platform fee', () => {
  /** A market that charges the fee the way the chain executor does: added to buys, taken from sells. */
  class FeeExecutor extends FakeExecutor {
    async buy(req: TradeRequest & { lamports: bigint }): Promise<FillResult> {
      const f = await super.buy(req);
      if (!f.ok) return f;
      const fee = (req.lamports * BigInt(req.feeBps)) / 10_000n;
      return { ...f, lamports: f.lamports + fee, feeLamports: fee };
    }
    async sell(req: TradeRequest & { tokens: bigint }): Promise<FillResult> {
      const f = await super.sell(req);
      if (!f.ok) return f;
      const fee = (f.lamports * BigInt(req.feeBps)) / 10_000n;
      return { ...f, lamports: f.lamports - fee, feeLamports: fee };
    }
  }

  it('friends pay the fee on buys and sells; it counts in their profit and is recorded per fill', async () => {
    const fx = new FeeExecutor();
    const e = new Engine({ store, executor: fx, walletFor: () => wallet, now: () => clock, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01, feeBpsFor: () => 100 });
    addCopy({ sell: { mirror: { enabled: true, mode: 'all' } } });
    await e.onLeaderTrade(trade()); await e.idle();
    expect(fx.buys[0]!.feeBps).toBe(100);
    expect(open()[0]!.costLamports).toBe(SOL / 10n + SOL / 1000n); // 0.1 SOL + 1 %
    await e.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 0n, tokenAmount: 2_000_000n })); await e.idle();
    const [closed] = store.closedPositions(userId);
    expect(closed!.proceedsLamports).toBe(SOL / 10n - SOL / 1000n);
    expect(store.fills(closed!.id).map((f) => f.feeLamports)).toEqual([SOL / 1000n, SOL / 1000n]);
  });

  it('an exempt user (e.g. the owner) pays none', async () => {
    const fx = new FeeExecutor();
    const e = new Engine({ store, executor: fx, walletFor: () => wallet, now: () => clock, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01, feeBpsFor: (id) => (id === userId ? 0 : 100) });
    addCopy();
    await e.onLeaderTrade(trade()); await e.idle();
    expect(fx.buys[0]!.feeBps).toBe(0);
    expect(open()[0]!.costLamports).toBe(SOL / 10n);
  });

  it('a live buy needs the fee on top of the buy and the reserve', async () => {
    const fx = new FeeExecutor(); fx.live = true;
    fx.sol = SOL / 10n + SOL / 100n + SOL / 2000n; // buy + reserve, but not the 1 % fee
    const e = new Engine({ store, executor: fx, walletFor: () => wallet, now: () => clock, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01, feeBpsFor: () => 100 });
    addCopy({ mode: 'live' });
    await e.onLeaderTrade(trade()); await e.idle();
    expect(fx.buys).toHaveLength(0);
    expect(feed()[0]).toMatch(/fee/);
  });
});

describe('a live buy keeps enough SOL to get out again', () => {
  // Review, 27 Nov 2026: the check before a live buy counted the buy and a flat 0.01 SOL. With large fees (the
  // Scharo preset pays 0.006 SOL on the buy and 0.002 on each sell) a wallet could afford the buy and then be
  // unable to pay for its own sells, leaving the coins stuck.
  const setup = (sol: bigint) => {
    const fx = new FakeExecutor(); fx.live = true; fx.sol = sol;
    const e = new Engine({ store, executor: fx, walletFor: () => wallet, now: () => clock, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
    addCopy({ priorityFeeSol: 0.01, tipSol: 0.02, sellPriorityFeeSol: 0.004, sellTipSol: 0.006 });
    return { fx, e };
  };
  // buy 0.1 + buy fees 0.03 + one sell's fees 0.01 + two token accounts' rent 0.0042 = 0.1442 (above the flat 0.01 reserve)
  it('a wallet that covers the buy and the flat reserve but not the fees is skipped, and told the real number', async () => {
    const { fx, e } = setup(SOL / 10n + SOL / 50n); // 0.12
    await e.onLeaderTrade(trade()); await e.idle();
    expect(fx.buys).toHaveLength(0);
    expect(feed()[0]).toMatch(/needs 0\.144\d* SOL/);
  });

  it('a wallet that covers all of it buys', async () => {
    const { fx, e } = setup(SOL / 10n + SOL / 20n); // 0.15
    await e.onLeaderTrade(trade()); await e.idle();
    expect(fx.buys).toHaveLength(1);
  });

  it('with small fees the flat reserve still decides', async () => {
    const fx = new FakeExecutor(); fx.live = true; fx.sol = SOL / 10n + SOL / 200n; // 0.105: under buy + 0.01
    const e = new Engine({ store, executor: fx, walletFor: () => wallet, now: () => clock, priceMs: 0, maxSolPerBuy: 1, feeReserveSol: 0.01 });
    addCopy({ priorityFeeSol: 0.0001, tipSol: 0 });
    await e.onLeaderTrade(trade()); await e.idle();
    expect(fx.buys).toHaveLength(0);
    expect(feed()[0]).toMatch(/needs 0\.11 SOL/);
  });
});

describe('trading fees per copy reach the trade', () => {
  it('buys use the buy fees, sells the sell fees', async () => {
    addCopy({ priorityFeeSol: 0.001, tipSol: 0.002, sellPriorityFeeSol: 0.0001, sellTipSol: 0.0005, sell: { mirror: { enabled: true, mode: 'all' } } });
    await engine.onLeaderTrade(trade()); await engine.idle();
    expect(ex.buys[0]).toMatchObject({ priorityFeeSol: 0.001, tipSol: 0.002 });
    await engine.onLeaderTrade(trade({ side: 'sell', tokensBefore: 2_000_000n, tokensAfter: 0n, tokenAmount: 2_000_000n })); await engine.idle();
    expect(ex.sells[0]).toMatchObject({ priorityFeeSol: 0.0001, tipSol: 0.0005 });
  });
});

describe('one switch decides real or test: the site owner\'s', () => {
  it('site live: every copy trades for real, whatever its old per-copy setting said', async () => {
    ex.live = true;
    addCopy({ mode: 'paper', sell: { mirror: { enabled: false } } });
    await engine.onLeaderTrade(trade()); await engine.idle();
    expect(ex.buys[0]!.live).toBe(true);
    expect(open()[0]!.mode).toBe('live');
  });
  it('site in test mode: every copy is simulated, whatever its old per-copy setting said', async () => {
    ex.live = false;
    addCopy({ mode: 'live', sell: { mirror: { enabled: false } } });
    await engine.onLeaderTrade(trade()); await engine.idle();
    expect(open()[0]!.mode).toBe('paper');
    expect(feed()[0]).toMatch(/\(test\)/);
  });
});
