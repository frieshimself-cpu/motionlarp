# Test record

## Automated (every change): `npm test`, 103 tests

- **Leader trade parser**: real mainnet transactions saved as fixtures (`tests/fixtures/tx/`): a pump.fun curve
  buy in the new version-1 transaction format, a buy whose fee was paid by a bot relayer, a full curve sell, a
  PumpSwap buy that pump.fun's own log calls "Sell" (balances decide, not instruction names), a PumpSwap
  partial sell, an arbitrage transaction, a failed transaction, a non-pump transaction.
- **Sell rules**: timed ladders fire in order and once each; overdue timers after a restart all fire; stop loss
  levels fire once, a crash fires every level it passes, loss is judged per token; dead coin; settings validation.
- **Copy engine** (fake chain, fake clock): minimum leader buy, already holding, buy once per coin, live wallet
  without enough SOL, server cap, disabled copies, several users on one leader, stale trades ignored, one action
  per leader transaction however often it arrives; sell when they sell (same %, all, before our buy finished,
  off); 25/50/100 at 3 s intervals empties the bag; two sells due together run one after the other on what is
  left; failed sells retry with growing pauses (mirror sells too) and give up after 8 tries; Sell now; live bags
  re-read from the chain after each sell.
- **Watcher**: first poll never copies history; socket + poll duplicates handled once; failed transactions not
  fetched; non-pump socket notifications skipped; at most N fetches at once; a wallet with no history.
- **API**: invite code, taken usernames, wrong passwords, missing app header, key import never echoed, another
  user's copy invisible, open positions block wallet removal, Sell now only for the owner.
- **Crypto**: keys round-trip only for the same user and master key; passwords.

## Against mainnet, 26 Nov 2026 (public RPC, test mode, nothing sent)

1. `npm run check:mainnet`: real wallets' recent pump.fun-curve and PumpSwap buys found and parsed; our 0.01
   SOL buy and a 50 % sell built for each of those wallets and simulated on mainnet without error (curve buy
   ~73–83k compute units, sell ~55–62k; PumpSwap buy ~75k, sell ~72–73k).
2. Full server run, five copies of active wallets, 0.02 SOL buys, timed sells 25 % @10 s → 50 % @20 s → 100 %
   @30 s: buys copied within seconds of the leader; every position sold 25 %, 50 % of the rest, then the rest, on
   time, priced from live quotes; positions closed with their profit recorded. A coin quoted in USDC was
   refused with a reason.
3. One copy switched to "sell when they sell" only: it bought five coins the wallet bought and sold each out
   when the wallet sold (about a minute later), positions closed; repeat buys of the same coin were skipped by
   "buy once per coin".
4. Found and fixed in these runs: sells gave up too fast under RPC rate limits (now retry with backoff, mirror
   included); a very busy wallet (674 trades in 3 minutes) flooded the RPC (now non-pump notifications are
   skipped and fetches are capped); a followed wallet with no history broke polling (empty cursor).

## Code review (26 Nov 2026) and fixes

An independent review of the money paths found, among others: a failed balance read could close a live position
with the coins still in the wallet; a buy landing after the confirmation timeout left orphaned coins; live sells
used the wallet's whole balance (two copies of the same coin sold each other's tokens); a partial stage could fire
twice; old leader sells were dropped; trades could reach the engine out of order; interrupted buys stuck in
"opening"; a copy flipped to Live on a test server stored paper positions as live. All fixed; each has a
regression test in `tests/review.test.ts` that reproduced the bug first. Added: a 30 s safety net that settles
interrupted buys and sells coins the followed wallet no longer holds.

## Speed (26 Nov 2026, public RPC)

`npm run measure`: a pump.fun buy is heard ~1 slot after it happens on the websocket ("processed"); resolving
the coin and building our buy takes ~70–150 ms (one RPC round trip for the coin). Full server run with the fast
path: buys copied from the websocket logs without a fetch; the public RPC's websocket dropped several times
(close code 1006) and the backup poll then delivered trades 3–8 s late, so production needs a paid RPC.

Also from these runs: PumpSwap pools not created by pump.fun are now found (by base mint, offset verified on a
real pool); pools quoted the other way round (SOL as base) are refused with a reason.

## Platform fee (26 Nov 2026)

Unit tests: fee maths, the transfer instruction (after the swap, to FEE_WALLET, exact lamports), startup checks,
fees through the engine (cost and proceeds include them, recorded per fill, exempt users pay none, live buys
need the fee on top). Mainnet: buys and sells with a 1 % fee transfer simulate cleanly. Found in that run: a fee
paid into an EMPTY wallet fails the whole trade (below the rent minimum), so the server refuses to start unless
FEE_WALLET holds at least 0.001 SOL.

## Any coin, any launchpad (26 Nov 2026)

Parser tested on real mainnet transactions from Raydium LaunchLab, Meteora DBC and Jupiter routes (buys and
sells), plus a USDC-paid buy, a coin-for-coin swap and a plain transfer (not a trade). Mainnet check, our buy and
50 % sell with a 1 % fee, built through Jupiter for real wallets and simulated: Meteora DBC ok, Raydium CPMM ok
(also via a two-hop route), Raydium LaunchLab ok once Jupiter had indexed the coin. Found: a coin seconds old has
"no route" on Jupiter for ~10 s, so buys retry for up to ~15 s; price checks never wait on that. Also: timed sells
no longer wait for a slow price check (regression test).

## Not yet verified

- A **live** buy and sell with real SOL (needs a funded wallet, a paid RPC and the owner's go-ahead):
  `LIVE_TRADING=true`, one copy set to Live, 0.01 SOL. Check on Solscan that the buy lands, the fill in the
  history matches the transaction, and the sells fire.
- The Docker image was not built here (no Docker engine in the build container); `npm run build` and the built
  server were checked.
