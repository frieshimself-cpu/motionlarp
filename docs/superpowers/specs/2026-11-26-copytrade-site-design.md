# motionlarp — copytrade website: design

Approved by the owner in chat on 26 Nov 2026.

## Intent

The owner and their friends each want to pick a Solana wallet and copy its pump.fun trades without watching a
screen. A friend opens the website, signs in, pastes the private key of the wallet they trade from, adds the
wallets they want to copy, and the server does the rest around the clock.

## Goals

- Accounts: username + password, gated by a sign-up code the owner sets.
- One trading wallet per account, imported by private key (base58 or the `[n, n, …]` JSON array Phantom /
  solana-keygen export). Stored encrypted (AES-256-GCM, server master key), never shown again, never logged.
- Any number of copies per account. Each copy:
  - leader wallet address, a name, on/off;
  - buy amount (SOL);
  - minimum leader buy (SOL): a leader buy smaller than this is skipped;
  - slippage %, priority fee (SOL);
  - test / live switch (live only works when the server is in live mode);
  - sell options, any combination of:
    1. **Sell when they sell** — sell the same share of our bag that the leader sold of theirs, or everything;
    2. **Timed sells** — a list of "after N seconds, sell P %";
    3. **Stop loss levels** — a list of "at −L %, sell P %", each fires once;
    4. **Dead coin** — no trades in the coin for N seconds → sell everything.
  - **Every sell % is a share of what is still held.** 25 → 50 → 100 sells a quarter, half the rest, the rest.
- A "Sell now" button on every open position.
- Dashboard: wallet balance, copies, open positions with live value and profit, a feed of every buy, sell and
  skipped copy with the reason, history with profit per trade.
- A good-looking site that works on a phone.

## Non-goals

- Coins outside pump.fun's bonding curve and PumpSwap (the same scope as Velo). Leader buys elsewhere are
  skipped with a reason.
- Sniper-grade speed: a copy lands a second or two after the leader.
- Take-profit, trailing stop, migration sell (the owner chose only the four sell options above).
- Platform fees, admin panel, withdrawals (users own their keys).

## Anti-goals

- A secret key in a log, an error, an API response, or the database in plain text.
- A real transaction sent while the server is not in live mode.
- Two sells of the same position racing each other; a sell larger than the bag.

## Approaches considered

1. **Own copy engine built on Velo's pump.fun / PumpSwap code, users import a key** — chosen (owner: "they
   import a priv key and it works like that"). Velo's venue code wraps pump.fun's official SDKs.
2. On top of OKTech (each friend pastes an OKTech key) — rejected: every friend needs an OKTech account.
3. Browser wallet (Phantom approves each trade) — rejected: copies stop when the tab closes.

## How it works

One Node 22 / TypeScript process: HTTP server (API + static site), leader watcher, copy engine, SQLite
(`node:sqlite`).

- **Watching leaders.** `logsSubscribe` (websocket, `mentions: [leader]`) per leader wallet, plus a poller
  (`getSignaturesForAddress`, every few seconds) that catches anything the socket missed. Each new signature is
  fetched once (`getTransaction`) and parsed from the leader's own SOL and token balance changes: a pump.fun or
  PumpSwap transaction where the leader's balance of a mint rises is a buy (SOL spent = the drop in the leader's
  SOL minus the network fee), where it falls is a sell (share sold = tokens sold ÷ tokens held before). Signatures
  are de-duplicated.
- **Copying a buy.** For each enabled copy of that leader: skip when the leader spent less than the minimum, when
  the copy already holds that coin, when the wallet lacks the SOL, or when the buy exceeds the server's
  `MAX_SOL_PER_BUY`. Otherwise build the buy with Velo's venue code, simulate, and (live) send.
- **Positions.** The fill is read from the confirmed transaction (tokens received, SOL spent). Sells of a position
  run one at a time through a queue; each sells P % of the tokens held at that moment; a position closes when
  nothing is left. Timers survive restarts (they are recomputed from the position's open time).
- **Price and activity.** Every couple of seconds each open position's coin is quoted (sell value of what we
  hold). The value against the cost of what we still hold drives the stop loss levels; an unchanged quote means
  no trades, which drives the dead-coin timer.
- **Test mode.** The default. Buys are simulated against the real chain with the user's wallet; fills come from
  the real quote; nothing is sent. Positions and sells are tracked on paper so a friend can watch a copy work
  before risking SOL. Live needs `LIVE_TRADING=true` on the server *and* the copy switched to live.

## Constraints

- Velo is read, never modified; its code is copied in with a note of where it came from.
- Secrets live in the server's environment (`RPC_URL`, `MASTER_KEY`, `SIGNUP_CODE`).
- Tests: vitest, real mainnet transactions as fixtures for the parser, a fake clock and a fake executor for the
  engine, the HTTP API over a real socket with a temporary database.

## Left to the builder

File layout, the exact page design, polling intervals, default values (slippage 25 %, priority fee 0.0005 SOL).
