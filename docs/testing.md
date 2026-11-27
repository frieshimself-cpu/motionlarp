# Test record

## Automated (every change): `npm test`, 564 tests (27 Nov 2026)

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
8. A transaction first seen in a block that is then dropped is pushed again, and an error seen only at
   "processed" is not taken as final (the transaction can still land).
9. The pages (checked in a real browser): Enter in the license-key box now gets you in (the login form used to
   stay on screen); "0,05" in a number box is 0.05 SOL (an English-language Chrome saved it as 5 SOL); a box that
   is not a number, or a required box left empty, is refused by name; the admin's Set fee box reads "0%" and
   "0,5" correctly; a new key logs out every browser that got in with the old one.

**The timing fuzzer** (`e2e/fuzz`, `npx tsx e2e/fuzz/fuzz.ts`): a simulated market drives the real engine and store
with random timing: our confirmations late or lost, sells that land before the engine hears of them, markets that pay
for only part of a sell, failures, RPC outages, restarts, the copied wallet trading in between. Invariants are checked
at every step (coins, SOL, rules, feed). It found nine defects, each saved as a case in `e2e/fuzz/cases/`, all fixed
with tests (`--cases`: all nine pass):
1-2. their exit or Sell now right after our +2 s sell had landed (before we heard) sold 20 % instead of the 60 % left,
   and the position then closed with 40 % in the wallet for good;
3. a stop loss and a timed step at once closed the position with a quarter of the bag in the wallet;
4. a stuck sell that landed after its position had closed sold the next position's coins;
5. a sell booked while another waited for the wallet lost its SOL from the profit;
6. their sell while our buy's outcome was unknown was dropped;
7. a sell whose outcome nobody could tell us was sold again, and the first sale's SOL never booked;
8. in test mode the last timed step finished while an earlier step was still trying, leaving half the bag.
Also fixed from its runs: a full exit that went out while another sell was on its way sells whatever that sell did not
sell (a market that paid only part, a step that failed). After the fixes, 3,000 runs inside the executor's contract
(no "failed but landed" sells, no crashes): coins never sit in the wallet without an open position, no SOL is lost or
doubled, every position whose rules call for a full exit is closed, every step fires at its time; the only runs
flagged (5) were the new "sell the rest" follow-up, which the harness does not know yet.

**From the Jupiter review**: a copy buy of a coin Jupiter has not picked up yet waits 2.5 s, then is skipped (it waited
about 15 s and bought at any price); requests are cut off after 3 s (a swap 6 s) and tried once more; the best route
goes without the tip before a smaller route, a smaller route only when it pays 99 % of the best, a sell finally without
our transfers (an exit is never blocked by the site's own fee or tip); every price check gets a fresh price; a coin
with no route is asked again only every 30 s; a platform fee too small to open an emptied fee wallet is left out.

**After an independent review of those fixes** (three reviewers: coins and SOL, things that can hang, regressions;
each finding checked by two skeptics), each with a test that fails on the code before: a sell keeps its coins
reserved until it is booked (a booking in between took them off twice and could close a position with coins in the
wallet); a trade whose confirmation was never told is settled from its own transaction, never credited with the
wallet's whole balance change; "landed but not readable yet" is asked again, not taken as "never landed"; a buy signed
while its row said test (Live switched on meanwhile) is live and is settled after a restart; a full exit that fires
while every coin is out in a timed step stays owed; the last step is done only when the position is empty, and checks
its position is still open after reading the wallet (it could sell the next position's coins). After all of it:
**5,000 randomized runs inside the executor's contract, no violation**; every saved case passes.

**Running unattended** (from the operations review): a landed buy is handed back within a second even when the reads
are slow (a stalled read held the whole 2/4/6 s exit); positions with no stop loss or dead-coin rule are priced every
30 s instead of every 2 s; the auto-updater waits for the app to answer after a rebuild, rolls back a version whose
build fails or whose app does not answer, retries a failed build after half an hour (it never retried), and the status
shows the running commit (the health check was run end to end against a running copy of the site); container logs
are capped, old images pruned, seen trades older than a day forgotten and each user's feed kept to 5,000 lines;
indexes for the admin page; History's heading and each copy's line count every closed position (they stopped at 200 /
1,000).

**The every-button test** (`e2e/buttons`: every button and form of the site and the admin page in a real browser,
desktop and phone; 486 and 482 checks passed, no page errors): fixed from it, each checked in a browser: only failed
logins count against the login limit (the right key from several devices was locked out); a user whose key is revoked
cannot be enabled; the page no longer waits for Google's font server; nothing is wider than a phone screen; a balance
that could not be read shows "—"; the 3-second refresh keeps scroll positions and selected text; an empty wallet box
is refused. Not changed (cosmetic or owner-only): the owner's Users table adds test profit to real; dates for viewers
at UTC+12 and beyond; very small numbers printed as 5e-7; two minus signs on a History line.

**Restarts** (an update restarts the server): a full exit that is owed (failed and waiting for its retry, left coins
to other sells, or came while our buy's outcome was unknown) is written down on the position and sold by the settling
pass after the restart (fuzzer cases 9 and 10 pass; it used to be held in memory only).

**Known, not changed yet** (from the reviews and the timing fuzzer; none blocks the Scharo preset; as it stands after
the restart fixes further down, which removed two items: a partial "same %" sell lost by a restart, and a sell of unknown
outcome given up by a restart): a timed step sizes itself from the quote's coin count when the exact count arrives late
(it sells a little less, the later steps sell the rest); after a buy booked with the quote's coin count, if its
position is sold out on that count and the same coin is bought again before the first buy's exact count arrives (a few
seconds), the coins beyond the quote are sold together with the new position's, or the first position is opened again
beside the new one to sell them (two positions of one coin for that moment): the wallet's SOL and the total profit are
right, but the profit is split wrongly between the two positions (the slow-read fuzzer profile, 6 of 3,000 seeds; not
changed because no clean way was found: moving coins and their cost from one position to the other breaks the rule
that a position's buy row describes it, and holding back a new copy of the coin while the last buy's count is still an
estimate would cost real copies to fix a split that only shows in History); a stop loss is measured against the buy
cost with every fee in it, so a level tighter than the entry costs fires at once (the preset has no stop loss); a
sell's feed line shows the quoted SOL (History and the profit use the exact amount); the admin's Live switch takes
effect when Save is pressed; the Helius RPC lane's MEV Protect is unproven (Sender's is proven).


## 27 Nov 2026, 05:40 UTC: real money on walletmotion.app itself

The owner switched Live trading on. A copy on the test account followed our own leader wallet with the Scharo exit
(0.02 SOL buy, fees 0.001 + 0.005 tip on the buy, 0.001 + 0.001 on each sell; 40 % at +2 s, 30 % at +4 s, the rest at
+6 s). The leader bought 0.006 SOL of a pump.fun curve coin:
- our buy landed **2 slots (about 0.4 s) after the leader's** (slots 474436171 and 474436173), booked 1.2 s after the
  leader's buy was sent; sells at **+2.2 s, +4.2 s, +6.3 s** after our buy, position closed; every transaction
  finalized without error;
- both lanes of the real server took every transaction (`sends`: Helius Sender 4/4, Helius RPC 4/4), with the server's
  Helius key, the regional Sender (Frankfurt) and the Helius stream in live mode;
- the profit shown (−0.0125 SOL, nearly all of it the fees of a 0.02 SOL test) is the trade's exact change; the wallet
  changed by −0.0110 SOL because the last sell closed an empty coin account left by an earlier test (its rent came back).
The two test copies were deleted afterwards.

## 27 Nov 2026, 06:00–06:30 UTC: the copy with no read in front of it; updates at a quiet moment

**The copy path.** A pump.fun curve buy of the copied wallet is now copied with no network read before our buy is
sent: the buy is built from pump.fun's own event of their buy (the curve as their buy left it, and the coin's token
program as pump.fun called it in that trade), from any feed (the Helius stream, the websocket's log notices, a fetch);
the fee tables stay in memory and are renewed in the background; the wallet's SOL is renewed every 3 s and right after
each of our trades (two buys at once never count the same SOL); the coin balance before the buy is asked for alongside,
never waited for. What is left in front of the send is CPU: about 3 ms (build 2.4, compile 0.4, sign 0.5). The feed
says "sent N ms after their trade was seen".
- Mainnet, sending nothing (`scripts/check-copy-from-event.ts`), two runs on 24 coins just bought on the curve (7 of
  them mayhem coins): the token program read from the logs is the mint's owner 24/24; the buy built from the event has
  exactly the accounts of one built from a fresh read 24/24 (pump.fun's SDK picks its buyback fee wallet at random on
  every build: that one account is allowed to differ); simulated with the priority fee, the platform fee and the tip,
  without an error, 24/24; the event's reserves are the curve right after the trade 15/15 wherever no trade came in
  between (two more in the first run were read at a newer commitment than the signature list). It also showed that
  mayhem curves hold 1 billion coins like the others (the code first assumed 2 billion).
- `tests/review-speed.test.ts`, `tests/watcher.test.ts`: nothing is read from the network before the send (a
  connection that records every call records none); the coin balance is still unanswered when the buy goes out; a
  classic SPL coin gets the classic program; a token program pump.fun did not call itself is never taken.
- **Real money on walletmotion.app, 06:28 UTC** (b889f12; the same check as at 05:40: a 0.02 SOL copy of our own
  leader wallet, fees 0.001 + 0.005 tip on the buy and 0.001 + 0.001 on each sell, 40 % / 30 % / the rest at 2 / 4 /
  6 s). The leader bought 0.006 SOL of a curve coin: **our buy landed in the same block as the leader's** (both slot
  474449727; at 05:40, before this work, it was 2 blocks behind), sent **88 ms** after their trade was seen (the first
  copy after a restart, most of it code loading: the server now runs the copy path once at start); sells at +2.1 /
  +4.1 / +6.1 s; every transaction landed; the four transactions changed the wallet by −0.012514 SOL, the fees the site
  booked (the dashboard showed a balance from before the sells for a few seconds: it now shows the engine's own
  figure, read right after each trade). The test copy was deleted.
- **Again at 06:38 UTC** (d445249, with the warm-up at start; again the first copy after a restart): sent **27 ms**
  after their trade was seen, landed **1 block** after the leader's (474452516 and 474452517); sells at +2.0 / +4.0 /
  +6.1 s; the wallet changed by −0.012514 SOL again. Which block a copy lands in depends on where in the leader's block
  their trade was and on the network; a few ms of our own work do not decide it.
- The whole path measured here (`handleStreamTx` of the real curve buy, through the watcher, the engine with a file
  database and the executor, to the signed transaction; sending mocked), 25 copies after the warm-up: median
  **4.2 ms**, 3.7 to 10.7 ms.

Updates also leave the app alone when a push changes only notes and tests (docs, tests, the fuzzer, scripts): pulled,
written down as deployed, no restart.

**Updates.** `deploy/update.sh` now builds a new version while the running one keeps trading, and restarts it only at
a quiet moment: nothing open and nothing under way; after 20 minutes, nothing under way and nothing due in the next
30 s; after an hour, any moment (the app finishes what is under way first). The app answers `/api/quiet` on its own
machine only. A build that fails stops nothing. The restart measured from outside: **2.3 s** without an answer (b200258),
then **1.3 s** once watching no longer waits for the sender region to be measured (58f4054).

**Timing fuzzer cases 12–17**, fixed with tests that fail on the code before: an owed Sell now's failure line written
every 30 s (12); the last step of a "% of the original bag" ladder selling coins the user bought by hand (13: it now
sells what is left of the copy's bag; a remainder within 2 % of the books is still swept up); an update in the middle
of an exit leaving the last sale at its quote for good (14: a fill now says it is an estimate until its exact figures
are read, and the safety pass reads any estimate from the chain for a day); a buy booked with the quote's coin count
whose exact count was taken off a second time after a sell had already matched the books to the wallet (15, 16); a
position sold out on the quote's count whose buy had received more (17: it is opened again and the rest sold). The
harness does not know case 17's follow-up sell yet (it flags it, and the 2 s before the exact count arrives).

## 27 Nov 2026: restarts, crashes and sells of unknown outcome (the timing fuzzer's findings at af4bf0d)

The timing fuzzer's report at af4bf0d had five open findings in the engine. Each is fixed with tests that fail on the
code before (`tests/restarts.test.ts`, one case in `tests/review-exact.test.ts`); saved cases 11, 18, 19, 20 and 21 now
pass, so all 21 do:
- **A position open with nothing in its books and nothing under way is closed** (case 18). The exact coin count of a
  buy booked with the quote's count could take the books to nothing while a sell of the rest was out; that sell then
  failed and the position stayed open for good (no rule, button or safety pass looks at a position holding nothing, and
  the coin could not be copied again). It now closes the moment the last thing of it ends; the clock checks as well.
- **A stopped server sends nothing** (cases 20 and 21). During an update's shutdown, a price check coming back after
  the stop fired a dead-coin sell, and the exact count of a buy arriving while the server waited for its last figures
  sold the coins beyond the quote; both landed after the process had exited and nobody booked them. From the stop on,
  nothing new goes out: a full exit (their exit, Sell now, the rest of a full exit) is written down and sold right after
  the restart, a timed step is overdue then, stop loss and dead coin are checked again. Their full exit is written down
  the moment it is heard. Sell now pressed during a restart says so, in its answer and in the feed.
- **Every real sell is written down before it is sent** (case 11, and the crash profile). A new table, `sells_out`,
  holds each sell from the moment it is signed until it is booked (in the same transaction) or known to have failed.
  After a crash, or a restart while a sell's outcome is unknown, the next start settles it from its own transaction
  before that position's rules go on: landed, it is booked by the same code as any sell (the step done, the SOL in);
  failed, its rule sells again; not found, it is kept for three minutes from its sending, then dropped. Meanwhile its
  coins count as on their way: Sell now sells only what is free, and the coin is not bought again (a late landing would
  sell the new coins).
- **Their partial sell ("same share") is written down until our share is sold** (case 19), in a new column,
  `positions.owed_sells`; after a restart it is sold once, unless it went out before and landed.
- Databases of earlier versions open as before and get the table and the column at start (tested on an old database).

The fuzzer, the report's commands, before and after (seeds flagged): default mix 32 → **0** of 6,000; crash profile
272 → **0** of 3,000; ghost 112 → **0**; outage 1 → **0**; slow-read 18 → **6** (the quoted coin count case kept as
known, above); the five core profiles 0 of 3,000 before and after; the self-test catches every planted fault. (Part of
the first two drops is the harness, not the engine, as a reviewer showed by adding only that one harness line to the old
code: 11 of the 32 and 115 of the 272 were test-mode sells cut off by a crash, which sold nothing anywhere and are now
counted as a note. The engine's own share is 21 → 0 and 157 → 0.) The
harness learnt what the engine now does, each time with a check that it is written down: a stopped engine leaves the
rest of a full exit to the next start (accepted only when it is in `exit_owed`); a new engine knows the real sells the
old one left written down (they stay on their way until it settles them, a position waiting for one sends nothing
until then, and stop loss levels are counted afresh after a restart, as the engine checks them again); a test sell cut
off by a crash sold nothing anywhere.

## 27 Nov 2026 (later): what the reviewers of those fixes found, fixed

Three reviewers read the engine fixes above and ran their own probes; two more ran the site's every-button suite
against the site fixes. What they found still open in the engine is fixed, each with a test that fails on the code
before (`tests/restarts.test.ts`, the last 15 cases):
- **The coins beyond a quote, found after the position was sold on the quote's count, are written down as owed before
  their sell goes out.** Their first try failing (an RPC error) used to leave them in the wallet for good, although the
  feed said "tried again every 30 s"; so did a crash while that sell was out. Now the settling pass sells them.
- **Sell now while every coin is already in a sell of ours on its way** answers what happens instead of "Sold" with
  nothing sold: the answer and the feed say the coins are in a sell being read from the chain (or sent just before the
  restart), and sold right after if it did not go through.
- **A sell left by the process before is dropped as soon as its blockhash has run out** (the chain is past its last
  valid height and it was not found), about a minute after it was signed, instead of three minutes. The server reads
  such a sell again every 5 s while there is one. The position's rules and Sell now wait for it meanwhile, so the wait
  was up to three and a half minutes after a crash.
- **A stop loss level or the dead-coin rule that comes due while a position waits for such a sell is held and sold
  once it is settled**, as it waits behind a sell of ours that is out. The clock used to skip the position, and judged
  the level again at the later price: one that had come back was never sold.
- **A sale that landed but whose booking failed** (a database error, undone whole) is not a failed sale any more: it
  is not retried and writes no failure line; it is booked from its own transaction within seconds. Their partial sell
  ("same share") was sold a second time that way. Such an order is also never run again once it is no longer owed.
- **An error after a booking was written** (its feed line) no longer leaves the sell to be booked a second time by the
  next pass, and a booking that is undone no longer leaves its exact SOL to be added to the books later.
- **A sell booked from its own transaction keeps its platform fee** (it was booked with none, so the fees shown were
  short), and the safety pass runs one at a time (two at once settled one buy twice).
- **"The market could pay for only part of it" is said only when the market capped the sell** (the executor says so);
  a sell that took fewer coins for another reason is done, and the rest of the exit is sold right after.

The fuzzer's fake chain learnt what the real executor now tells with each signature (its blockhash's last valid
height, its fee, whether the market can pay for all of it); its check of stop loss levels no longer forgives a
restart or a position waiting for a sell from before one (it found one more case that way, ghost seed 1916: a level
held while the position waited, lost by a second restart after the price had come back; such a level is now written
down as owed until it is sold); and its safety-pass flag starts fresh with each new process (a pass of the dead
process could block every pass of the new one). On the final code, seeds flagged: default mix **0** of 6,000; crash,
ghost, outage and the core profiles **0** of 3,000 each; slow-read **6** of 3,000 (the same six seeds, the known quoted
coin count case); all 22 saved cases pass; the self-test catches every planted fault. `npm test`: 490 tests.

## 27 Nov 2026 (evening): the site on phones; a database that cannot be written; a lagging RPC node

**The site** (what the every-button reviewers found, fixed by a helper and merged): long sell rules (the Scharo
preset's "40% @ 2s → 30% @ 4s → rest @ 6s · of the bag") and long nicknames stay inside their cards, and the copy
editor fits a 320 px phone; History fits a phone (each day on one line, every profit on the screen); the owner's page
keeps its password form alone after Log out, checks the connections after any login and keeps its figures moving while
something is typed; History's heading says which kind of trade its numbers count; a copy's line counts one kind of
position; each trade is put on the day it closed on the viewer's own calendar, also across a change of the clocks; on a
320 px phone the owner's Status tab no longer runs past the screen; Sell now that sells nothing itself says what
happens instead of "Sold". The browser suite now runs at four sizes (1280, 390, 360 and 320 px): on the live site
(version 49f9fd5), **586 checks passed at each size, no page errors, nothing wider than the screen**.

**The site, third review** (four reviewers, each finding checked by a separate verifier; three commits after
685995f). The owner's page no longer wipes a half-typed number in a background redraw, nor sends it ("1e" in the Fee
box became an empty box that Save sent as a fee of 0 %, and Create key gave a key the default fee); a tap no longer
acts on a row that a redraw moved between the finger lifting and the click, and each question names its row; the
keyboard stays on Create key and Save settings; a word cut off while it was being composed no longer stops the redraws
for good; no old note after a new login; what is typed stays while Status is looked at. On the user's site History
keeps the copy names whole and uses its phone layout up to 760 px, the top bar keeps one row from 641 px, the editor's
steps keep room for their unit ("100" read "10%" below 340 px), figures shrink instead of being cut, card heads wrap,
the toast takes a phone's width, and a copy's line names the kind of both its parts. The server keeps its time-zone
caches under each zone's own name, bounded (spellings of one zone could add some 150 MB), and reads the closed positions
once per poll for the copy lines (GET /api/state at 50,000 closed positions: 95–117 ms before, 62–64 ms after). The
browser suite now runs at seven sizes (1280, 1024, 768, 412, 390, 360 and 320 px), checks on every screen that nothing
runs out of its own card or box, and resizes Alice's pages from 280 to 1100 px: **652 checks passed at each size (655
at 1280 px), none failed, no page errors, nothing wider than the screen**. `npm test`: 564 tests.

**The engine.** A second round of reviewers (money, restarts, the user's view, the fuzzer) read the fixes above; each
finding was checked by a separate verifier, and the eight checked were all confirmed. Fixed, each with a test that
fails on the code before (`tests/restarts.test.ts`, `tests/db-faults.test.ts`, `tests/send.test.ts`):
- **Nothing goes out that the server could not write down first.** A sell's row in `sells_out`, and a buy's signature,
  is written the moment it is signed; when that write fails (a full disk, a failing one), the trade is not sent and
  fails like any other: it is tried again, and Sell now says "the server cannot save to its database right now, its
  disk may be full: nothing was sent, the coins are still in the wallet". It used to be sent all the same, and with its
  booking failing too the sale was never booked and its rule sold again: a 40 % step sold the whole bag in four ticks
  of a full disk, and a full exit closed with no SOL booked. While the database cannot write nothing sells; the coins
  stay in the user's own wallet, where any wallet app can sell them.
- **A failure while the database cannot write keeps to its own retry pauses**: the retry is set before anything about
  the failure is written, and a feed line that cannot be written is skipped. A timed step used to be sent again on every
  tick of the clock (five times a second), and errors escaped unhandled.
- **A transaction whose commit fails is undone whole**, and the next one can start. The connection used to stay inside
  it, and every later write went into a transaction that was never committed.
- **A buy that landed but could not be booked stays "opening"**, and the safety pass books it from its own transaction;
  a feed line that cannot be written after a buy no longer marks it failed. Both used to mark the position failed, and
  its coins were never sold.
- **A sell left by a crash is dropped as "never landed" only on the word of an RPC node at least as far along as the one
  that gave the chain's height**, and only a few blocks (about 4 s) past the last block it could land in, which is one
  past its blockhash's last valid height. The height and the status are two requests, perhaps answered by two nodes (a
  load-balanced link, or the backup link taking over one request); a node some blocks behind had not seen a sale that
  landed in its last blocks, which was then never booked, and its rule sold again. The same check now guards a trade
  declared expired while it waits for its confirmation (a buy that landed in its last block could be marked failed, its
  coins never sold). Without the slots of the two reads to compare (an executor that does not tell them), only well past
  it (about 12 s).
- **Sell now pressed while their exit, or a stop loss, is selling everything** answers "Nothing was left to sell: the
  position was closed just before (see the feed)" instead of the red error "position is not open"; so does a press on a
  position closed a moment before the page caught up. A press whose own sale landed but could not be booked at once
  answers "Sold: it shows in the feed and History within a few seconds" (it was tried twice more and answered as not
  sold); Sell now while every coin is in such a sale of ours says it was just sold, not "if it did not go through".
- **The exact figures of a trade are written whole or not at all**: a sell's exact SOL with the proceeds; a buy's exact
  coins and SOL with its position; the coins beyond a quote opened again together with their exit owed. A failure
  between two of those writes left the books wrong for good, or the coins in the wallet.
- **A buy settled from its own transaction keeps its platform fee**: it is written with the buy's signature when the buy
  is signed (the fees shown were short; profit was right).
- **A stop loss level or the dead-coin rule is written down the moment its sell goes out** and sold even if the price has
  come back by the time it can be: a level whose sell failed and waited for its retry, or went out and did not land, was
  lost by a crash or a restart once the stored price had come back.
- **The stop loss level that sells everything is named in the feed** when it is sold as an exit owed after a restart, or
  as the rest of a sell that took fewer; it was named after the first level. One whose level is not known says "stop
  loss".
- **The rest of a Sell now that keeps failing says so once**: its first try and the safety pass's re-runs carried other
  tags, and each said so.
- Tests now guard what only the reviewers' own probes covered: the fee, and "the market could pay for only part", on
  sells booked from their own transaction (left by a crash, or of unknown outcome) and on the last step of the bag (at
  once, and left by a crash); two sells left by a crash, one whose booking fails. Each of 18 planted regressions of these
  fixes fails at least one test.

The fuzzer on this code, seeds flagged: default mix **0** of 3,000 and of 6,000 more (seeds 10,001 on); crash and ghost
**0** of 2,000 and of 3,000 more; outage **0** of 2,000 and of 2,000 more; partial **0** of 2,000; slow-read **5** of
2,000 (the same seeds as before, the known quoted coin count case); all 22 saved cases pass; the self-test catches every
planted fault. The browser suite on this code (version 67c9307, live since 13:20 UTC after a 1.5 s gap): 585 of 586
checks at each of the four sizes; the one check that failed, the same at each size, found a real fault of the page: a
signed amount too small for its decimals was printed "−0", in red (a test account's profit today was −0.0002 SOL at
that time of day). Such an amount is now shown with as many more decimals as it takes ("−0.0002"), and under half a
millionth of a SOL it is "0", with no sign and no colour (tests/review-site-pages.test.ts); that check then passes.
`npm test`: 550 tests.

## Not yet verified

- A crash or a restart with a real sell out on the real server: the settling of sells written down before a crash is
  proven offline only (tests, the fuzzer's crash and ghost profiles).
- A full disk on the real server: proven offline only (every write of the store failing in tests, and a real SQLite on a
  full disk by a reviewer).
- The Helius RPC lane with `mev-protect=true` on its own (it carried the trades above together with Sender).
- A real 7 SOL trade. 7 SOL buys are proven by simulation on 8 live coins (above); the largest real buy so far is
  0.02 SOL. On a curve with less than 7 SOL of coins left, our buy completes it and spends the whole amount
  (pump.fun's exact-spend buy); that case was not simulated.
- The on-chain simulation of a mayhem-curve sell that is cut to what the curve can pay (the public RPC
  rate-limited the script; the arithmetic is covered by tests and pump.fun's refusal of the old sell was seen in
  a simulation by the review).
- That the firewall / fail2ban step ran on the server (it logs to /var/log/motionlarp-update.log).
- The Docker image was not built here (no Docker engine in the build container); `npm run build` and the built
  server were checked, and the real server has rebuilt itself after every push.
