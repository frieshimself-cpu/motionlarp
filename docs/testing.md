# Test record

## Automated (every change): `npm test`, 80 tests

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
3. Found and fixed in these runs: sells gave up too fast under RPC rate limits (now retry with backoff, mirror
   included); a very busy wallet (674 trades in 3 minutes) flooded the RPC (now non-pump notifications are
   skipped and fetches are capped); a followed wallet with no history broke polling (empty cursor).

## Not yet verified

- A **live** buy and sell with real SOL (needs a funded wallet, a paid RPC and the owner's go-ahead):
  `LIVE_TRADING=true`, one copy set to Live, 0.01 SOL. Check on Solscan that the buy lands, the fill in the
  history matches the transaction, and the sells fire.
- The Docker image was not built here (no Docker engine in the build container); `npm run build` and the built
  server were checked.
