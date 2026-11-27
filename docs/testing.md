# Test record

## Automated (every change): `npm test`, 346 tests (27 Nov 2026)

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

## License keys, admin page, trading fees (26 Nov 2026)

Unit and API tests: keys are stored hashed, redeemed once, carry their own fee, revoke/restore lock a user out
and back in; the admin area is closed without the password and to ordinary users; owner settings are validated
before anything is stored (RPC link tested, fee wallet funded), secrets stored encrypted and shown masked; an RPC
change restarts. Per-copy buy/sell priority fee and tip reach the trade; a tip is a transfer to a Jito tip account
and tipped trades also go out through Jito's block engine. In a real browser: admin login, creating keys, sign-up
with a bad and a good key, a copy with custom fees, the redesigned pages on desktop and phone (no sideways
scroll, no script errors). Saving a new RPC link on the admin page restarted the server and came back with it.
Mainnet: a PumpSwap buy with platform fee and tip simulated cleanly.

## 27 Nov 2026: key login, profit by day, Sender, hardening, the real server

- License key as the login (first use opens the account, later uses return to it, reissue kills the old key,
  accounts from before keys get one from the admin page), sessions that renew while used, an admin login that
  survives restarts: API tests, and the whole flow in a real browser.
- Profit today / 7 days / all time and the daily table, following the viewer's clock, live and test apart.
- Several wallets added in one go (a bad address in the list reports which one and how many were added).
- Helius Sender for tipped trades: endpoint, tip accounts and minimums from Helius's docs; unit tests for the
  routing; the endpoint answers from here. Not yet sent live.
- Stricter browser policy: pages load, an injected inline script does not run (checked in a browser).
- **On the real server (walletmotion.app):** automatic updates picked up three pushes, each within about 1–2
  minutes, and the site came back each time, including with the locked-down container settings.

## 27 Nov 2026: timed exit of the original bag, the Scharo preset, Connections

- **Automated, 217 tests.** `tests/exit.test.ts`: steps at +2 s / +4 s / +6 s are shares of the coins the buy
  received and each fires on its own clock; a step that is still unconfirmed does not hold the next one back; a
  failed sell is retried at once and later steps keep their times; the last step sells whatever the wallet holds;
  the timer starts at our confirmed buy; one position per coin per user; the copied wallet selling its whole bag
  sells ours, its partial sell does nothing; every sell is logged with seconds after the buy, tokens and SOL.
  `tests/connections.test.ts`: each connection check, a hanging one cut off, no key ever in the answer. A Jupiter
  key is tried with a real quote before it is saved.
- **In a real browser** (local server, test mode): the owner's Connections tab showed RPC, Sender and a real
  Jupiter quote green; a pasted non-link and a made-up Jupiter key were refused with a plain message; an opened
  "replace" form stayed open across background refreshes. A user pasted a key, imported a wallet, clicked
  **Scharo preset**: wallet `wtb3G6oV…8ksih`, 0.001 / 0.005 fees on buys and sells, 100 % slippage, "only their
  full exit", "% of the original bag" with 2 s 40 %, 4 s 30 %, 6 s the rest, stop loss and dead coin off; saved
  and re-opened with the same values.
- **Test mode against mainnet, following the real wallet** (public RPC, nothing sent, 0.02 SOL buys). Two of its
  buys were copied and exited:
  `9Zoy…pump`: sells at +2.2 s, +4.2 s, +6.0 s after the buy. `4N1P…pump`: +2.0 s, +4.0 s, +6.0 s. Both closed.
- **What that run also showed: the fees decide the result at small sizes.** Every transaction of this preset
  costs 0.006 SOL (0.001 priority + 0.005 tip) and a round trip is four transactions: 0.024 SOL, whatever the buy
  size. The 0.02 SOL test buys cost 0.026 and returned 0.0018. At 0.5 SOL the same fees are about 5 % of the buy,
  at 1 SOL about 2.4 %.
- **How that wallet trades** (its last 60 transactions): 31 failed (it sends several and one lands; failed ones
  are never copied). Buys of 1–5 SOL, sometimes two in the same second or a second one 8–13 s later; it holds
  14 s to several minutes and then almost always sells 100 % in one go. So this preset is out (at +6 s) before
  the wallet itself sells; the "their full exit" rule only matters if it dumps within the first six seconds.
- **A pump.fun buy now spends exactly the amount set** (`scripts/check-exact-buy.ts`, simulated on mainnet for
  the wallets that had just bought each coin): 4 of 4 coins passed at 100 % slippage, spending 0.010005 SOL of
  0.01 asked (0.0129 where a new token account's rent was due). pump.fun's older buy, which the site used until
  now, asks for a fixed number of tokens and may take up to the amount plus slippage: on one of the four coins
  it would have paid 0.0108 for the same buy, and at 100 % slippage it could take double.
- **On the real server:** the push was live after about two minutes; `/api/config` serves the Scharo preset.
- **Full simulated mainnet check after the buy change** (`npm run check:mainnet`, public RPC): pump.fun curve buy
  with fee and tip, and sell: ok; PumpSwap buy and sell: ok; Jupiter-routed Raydium LaunchLab and Raydium CPMM,
  buy and sell: ok; Meteora DBC buy: ok. Meteora DLMM found no sample in that run (it passed in the run before).
  A pump.fun coin priced in another token is not traded by the native path: the site sends it through Jupiter,
  and the check now skips such a coin when it looks for its native sample.

## 27 Nov 2026 (later): the Helius link and the Jupiter key live on the server; preset numbers

The owner's decision: the two keys are set on the server, permanently, and nowhere on the website.

- **Where they live now:** `RPC_URL` and `JUPITER_API_KEY` in the server's `.env`. The website refuses to set
  them (tests, and in a browser: a POST with a link is answered "set on the server, not on the website"); the
  admin page has no box for them; the read-only **Status** tab shows only whether each connection answers.
- **The one-time move** (`deploy/keys-to-env.sh`, run by the automatic updater): 9 tests run the real script
  against throwaway folders (both values written, every other line kept, file readable by root only, a value
  already in the file never replaced, nothing printed but names, nothing touched when there is nothing to move
  or the app is down, a second run changes nothing). `src/export-connections.ts`, the tool it calls, is tested as
  a real process against a real database the app has open.
- **Rehearsed end to end here** on a stand-in for the server (a database holding a link and key saved the old
  way, a `.env` without them, the built server running): before, `/api/config` reported
  `keys: helius: saved, jupiter: saved`; the script wrote both into `.env` (mode 600, a copy of the old file kept
  as `.env.before-keys`); after a restart it reported `helius: server, jupiter: server`; neither value appeared
  in the script's output or the server logs. Not rehearsed: the two real `docker compose` calls (no Docker here).
- **`deploy/set-keys.sh`** (to set or replace them by hand on the server), against the real network: a working
  link was saved; a link that does not answer and a made-up Jupiter key were refused and nothing changed.
- **Public status line:** `/api/config` now carries `keys` (where each comes from, never a value) and `health`
  (names only), refreshed every five minutes, so the state of a server can be read without logging in.
- **Scharo preset** changed to the owner's numbers: buy 7 SOL, only when they buy 1 SOL or more, buy fees
  0.001 + 0.005 tip, sell fees 0.001 + 0.001, 100 % slippage; the timed exit and the full-exit rule unchanged.
  The editor warns when a buy is above the site's "Max per buy" (such buys are skipped by the server).
- 233 automated tests pass.

## 27 Nov 2026 (night): real-money tests

Funds: the owner sent 0.5 SOL to a throwaway test wallet. About 0.064 SOL was used over roughly 80 real
transactions (network fees, tips, and small losses on tiny trades); about 0.007 of that is rent that sits in token
accounts. The owner's "Live trading" switch on walletmotion.app stayed OFF through all of this, so the real trades
below were made by the same code running on a private copy of the server (public RPC, Helius Sender without a key)
and by a script calling the site's executor directly; on the real server the same scenarios ran in test mode.

**Tooling** (in `scripts/`, they send real transactions, run on purpose only): `live-leader.ts` (a wallet of our
own that buys and sells so the site has something to copy on demand), `live-executor-check.ts` (one round trip
through `ChainExecutor`, every reported number compared with the wallet's balance change), `check-side-pool.ts`,
`check-exact-buy.ts` (both read-only).

**On the real server, test mode** (Helius stream, real quotes, on-chain simulation with the funded wallet). The
leader wallet really bought and sold; the site's copy was simulated:
- pump.fun curve coin, PumpSwap coin and BONK through Jupiter: the copy was booked 0.25–0.9 s after the leader's
  transaction was SENT (before the sender had its own confirmation), sells at +2.0/2.2 s, +4.0/4.2 s, +6.0 s.
- "Only their full exit": the leader sold half, nothing happened; the leader sold everything, the site sold
  everything 0.17–0.19 s after that sell was sent.

**Real money, the site's executor called directly** (curve coin, PumpSwap coin, BONK via Jupiter; buy, sell 40 %,
sell everything; Sender with a 0.001 SOL tip, Sender's small-tip lane, the plain RPC lane alone, Sender alone):
every transaction landed, confirmed 0.7–2.2 s after the call; tokens and SOL reported matched the wallet's balance
change exactly on every fill, including a small sell that did not cover its own fees (booked as −0.000006 SOL).

**Real money, the whole server (private copy), copying a leader:**
- Buy copied for real, then real sells at +2.0/2.1 s, +4.0/4.1 s and +6.1 s after our buy was confirmed; on chain
  they landed about 2.8 s, 4.6 s and 6.4 s after the buy's slot (slots are about 0.2 s now). Position closed;
  the profit shown equals the wallet's balance change to the lamport. Run three times.
- The public RPC dropped out for about 90 s in the middle of one exit: the last step kept retrying and sold
  everything the moment it came back (+99 s). Nothing was left in the wallet.
- "Only their full exit" with real sells (twice): half-sell ignored, full exit sold our whole bag.
- Sell now: sold for real 1.4 s after the click.
- A buy the wallet could not afford (0.0194 SOL held, 0.02 needed): skipped with a clear line, nothing sent.

**Bugs these runs and the code review found, all fixed with tests and re-proven with real trades:**
1. Coins not launched on pump.fun were bought in a tiny side PumpSwap pool instead of the real market: for BONK,
   WIF and JUP that pool gave 25–55 % of the market's coins for 0.01 SOL and 0.04–0.17 % for 7 SOL. Now only
   pump.fun's curve and the pool a pump.fun coin graduated into are traded directly; everything else goes through
   Jupiter (`tests/pf.test.ts`).
2. PumpSwap buys were not exact-spend: at 100 % slippage a 7 SOL buy wrapped 14 SOL (the wallet needed 14, and
   up to 14 could be spent). Now `buy_exact_quote_in_v2` (`scripts/check-exact-buy.ts`: 3 of 3 PumpSwap coins and
   3 of 3 curve coins spent 0.010005 of 0.01 asked at 100 % slippage; one real PumpSwap buy).
3. A transaction was sent once and never again: one that was dropped waited about 30 s for its blockhash to
   expire. Now the same signed transaction is re-sent about once a second until it lands.
4. The send waited for its slowest lane, and when no lane answered the trade was taken as "not sent" although it
   may have gone out (a buy could land with no position; a sell could be signed twice). Now the first lane that
   takes it is enough, and an unclear result is settled by watching the chain (`tests/send.test.ts`).
5. Live trading switched off while a sell was being built: the simulated result was booked as a real sell. Fixed.
6. The last timed sell gave up after about a minute of failures ("use Sell now"). It now keeps trying every 15 s
   until it sells; earlier steps still give up, because the last step sells what they left.
7. An update restarted the server in the middle of a short exit. The server now finishes an exit in progress
   (up to 40 s) before it restarts.
8. Sell amounts hid losses: a sell that did not cover its fees was booked as 0, and the first estimate left the
   fees out until the exact number arrived. Fills are now the wallet's exact change from the first moment.
9. A Jupiter transaction just over the size limit passed our check and was refused by the network. Fixed.
10. A live buy could leave the wallet without enough SOL to pay for its own sells. The check now counts the fees
    of the buy and one sell and the token-account rent.
11. Smaller: the "now copying" line said "test mode" on a live site; both Helius lanes now ask for MEV Protect
    (routing around sandwiching validators; a buy at 100 % slippage has no price limit of its own); compute limit
    200k instead of 300k (the same fee bids 1.5x more per unit), doubled automatically for a coin that runs out;
    the Sender region is re-measured every five minutes and dropped after three failed sends.

Automated tests: 262.

## 27 Nov 2026 (early morning): four review teams, the rest of the features with real money, a 7 SOL check

**More real money, the whole server (private copy), each scenario copying our own leader wallet:**
- Timed sells of what is left (50 % at +2 s, the rest at +4 s), stop loss at −1 % (sold everything at once),
  "same %" mirror (they sold 50 %, we sold 50 %; they sold the rest, we sold the rest), "everything" mirror (they
  sold 30 %, we sold everything), dead coin (no price change for 5 s sold everything). Every one landed and the
  profit shown matched the wallet's change.
- Platform fee: 1 % of the buy and of the sell, in the same transaction as the swap, seen on chain.
- The sell that empties the bag closes the coin's token account in the same transaction; the rent came back
  (pump.fun curve coin and PumpSwap coin).
- Money: 0.5 SOL sent by the owner; 0.39 SOL is left in the two test wallets, so about 0.11 SOL was used in all
  (network fees, tips, platform fees paid to ourselves, small losses on tiny trades).

**Every-coin sweep** (`scripts/sweep-coins.ts`, read-only): 31 live coins, 122 simulated trades of our own code
(buy, sell part, sell all; curve, PumpSwap, Jupiter, Token-2022 coins, cashback coins, coins priced in USDC/USD1):
all pass except a few micro-coins Jupiter itself refuses ("not tradable"), which now say so in plain words.

**7 SOL, the size the Scharo preset buys** (`scripts/check-big-buy.ts`, read-only, signed as a wallet holding more
than 7 SOL): our buy, wrapped exactly as the executor sends it (compute budget and the 0.001 SOL priority fee, the
1 % platform fee, the 0.005 SOL tip), simulated on 4 pump.fun curve coins and 4 PumpSwap coins that had just been
bought: 8 of 8 pass, each spending 7.0775 SOL (7 + 0.07 fee + tip + priority fee + the coin account's rent), using
69k–96k of the 200k compute units, 885–923 bytes of the 1,232 allowed.

**Fixed after the reviews, each with tests** (commits of 27 Nov, in order):
1. Engine: their full exit while a timed step was in flight sold the same coins twice, or overwrote the step's
   proceeds; the Live switch now stops new real buys only (positions bought for real are still sold); a retry is
   simulated before it is sent; a curve that completed while held re-routes its sell to PumpSwap at once; a buy
   read from pump.fun's event counts as meeting a minimum it is within 1.5 % of; old leader buys (over 20 s) are
   not copied; unknown modes and empty boxes in the editor are refused.
2. Velo lessons and the venue review: a backup RPC link; re-sending on its own timer; failed trades say why in
   the program's own words; a buy's signature is written down when it is signed and an unknown outcome is settled
   from that transaction; a completed curve never reads as a price of 0 (that fired every stop loss); cashback
   coins are bought through Jupiter (exact spend); a buy's short-lived blockhash never comes from a stuck feed.
3. Selling everything closes the coin's token account (rent back), proven with real sells.
4. Logs keep transaction signatures readable (they were blanked like private keys); a real key is still hidden.
5. The watcher: a buy counts only when the copied wallet signed it or paid from its own account (a stranger can no
   longer fake one with a forged log line); the fast path reads only lines pump.fun itself wrote; a stream that
   stops delivering no longer hides the websocket's notice; a failed fetch is retried; a buy heard late together
   with the wallet's full exit is not copied.
6. pump.fun, second review: a mayhem curve that holds less SOL than a sell asks for no longer refuses the sell
   for ever ("Overflow"): it sells what the curve can pay for and the rest as soon as it fills up; a coin between
   its curve and its PumpSwap pool is no longer sent to Jupiter for 20 s; a partly filled mayhem buy pays the fee
   on what it spends; PumpSwap trades always create the wrapped-SOL account if missing.
7. A crash in the middle of a test buy could, after a restart with Live switched on, be restored as a real
   position and sell coins the wallet already held. A buy is now written down as test or live from the start,
   and a live buy that was never signed is marked failed.

## Not yet verified

- **Real trades on the real server** (Helius RPC with the key, the regional Sender, the Helius stream in live
  mode). Everything above ran this code for real elsewhere; on walletmotion.app it ran in test mode. It needs the
  owner's "Live trading" switch. The status line in `/api/config` shows per-lane counters (`sends`) once it has.
- The Helius RPC lane with `mev-protect=true` (no Helius key outside the server). Sender with it was proven.
- A real 7 SOL trade. 7 SOL buys are proven by simulation on 8 live coins (above); the largest real buy so far is
  0.02 SOL. On a curve with less than 7 SOL of coins left, our buy completes it and spends the whole amount
  (pump.fun's exact-spend buy); that case was not simulated.
- The on-chain simulation of a mayhem-curve sell that is cut to what the curve can pay (the public RPC
  rate-limited the script; the arithmetic is covered by tests and pump.fun's refusal of the old sell was seen in
  a simulation by the review).
- That the firewall / fail2ban step ran on the server (it logs to /var/log/motionlarp-update.log).
- The Docker image was not built here (no Docker engine in the build container); `npm run build` and the built
  server were checked, and the real server has rebuilt itself after every push.
