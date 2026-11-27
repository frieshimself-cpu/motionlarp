# motionlarp — copy club

A website where you and your friends each import a wallet, pick wallets to copy, and let the server copy their
pump.fun trades around the clock: your buy size, your minimum, your exits.

- **Copy any wallet, on any coin.** Paste its address. When it buys a coin for at least your minimum, you buy your
  amount: pump.fun and PumpSwap through the fast native route; every other launchpad and exchange (Raydium
  LaunchLab / Bonk, Meteora DBC, Raydium, Meteora, Orca, …) and coins paired with USDC, USD1 or anything else
  through Jupiter. You always pay and receive SOL. A wallet paying with USDC or another coin counts as a buy too,
  valued in SOL for your minimum.
- **Four sell options, mixed however you like.**
  - **Sell when they sell**: the same share of your bag they sold of theirs; or everything on any sell of theirs;
    or everything only when they sell their whole bag in one go (their partial sells are then ignored).
  - **Timed sells**: e.g. 25 % after 3 s → 50 % after 6 s → 100 % after 9 s, each a share of what you still hold.
    Or "% of the original bag": every step sells a share of the coins your buy received, on its own clock from the
    moment your buy is confirmed; a failed sell is retried at once without pushing the later steps back, and the
    last step always sells whatever is left in the wallet. Every sell is logged with its time after the buy, the
    tokens sold and the SOL received.
  - **Stop loss levels**: e.g. −30 % sell half, −60 % sell the rest. Each fires once.
  - **Dead coin**: no trades for N seconds → sell everything.
- **Presets.** One click fills a whole copy. "Scharo": buys 7 SOL when `wtb3G6oV…8ksih` buys 1 SOL or more;
  buy fees 0.001 SOL priority + 0.005 tip, sell fees 0.001 + 0.001; 100 % slippage; sells 40 % of the bag at
  +2 s, 30 % at +4 s, everything left at +6 s; sells everything at once if that wallet sells its whole bag first;
  no stop loss, no dead coin. Every field can still be changed before saving. A buy above the site's
  "Max per buy" is skipped (the editor says so), so the owner sets that limit to 7 SOL or more for this preset.
  Presets live in `src/engine/settings.ts` (`PRESETS`).
- **Sell now** button on every open position.
- **License keys and an owner page.** A friend pastes the key you created and is in (no sign-up, no password); you manage keys, users, fees and
  settings at `/admin`.
- **Custom trading fees.** Priority fee and tip per copy, for buys and sells.
- **Test mode first.** Every copy starts in test mode: buys are checked against the real chain, fills come from
  real prices, nothing is sent. Switch a copy to Live once you trust it.
- A live feed of every buy, sell and skipped copy (with the reason), and a history with profit per trade.

- **Profit today, last 7 days, all time**, and a day-by-day table; real and test trades kept apart.

A clean, dense trading dashboard that also works on a phone.

## How it works (one paragraph)

One Node.js process. It watches every copied wallet two ways at once (a live websocket feed and a check of its
latest transactions every few seconds, so nothing is missed), reads each transaction's balance changes to see
what the wallet bought or sold, and copies it for every friend following that wallet. Buys and sells are built
with pump.fun's official code libraries, the trading code ported from the Velo repo. Each position's buy and
sells run one at a time, so two sells never collide. Failed sells retry with growing pauses. Wallet keys are
stored encrypted (AES-256-GCM) and never leave the server.

## Speed

Measured on mainnet (26 Nov 2026): a followed wallet's pump.fun buy reaches the server about **1 slot (~0.4 s)**
after it happens (websocket at "processed", read straight from the transaction's logs with no extra fetch);
resolving the coin and building our buy takes **~70–150 ms**; the buy is then sent without a simulation round
trip. Expect copies to land **about 2–4 slots (~1–1.5 s) behind** the wallet, with a paid RPC close to the
server. Before this tuning it was ~6–10 slots.

For comparison, OKTech's sniper lands copies in the leader's *own* block (snipetech's record). Every slot behind
costs on hot coins (snipetech measured +18–43 % entry price at 2–4 trades behind a crowded leader). So:

- Fine for wallets that buy and hold for a while, or trade coins that aren't being swarmed.
- Weak against the most-copied wallets, where everyone races into the same block. Use a higher priority fee
  there, and test in test mode first: the history shows what the copy would have made.
- Next steps if needed: a Geyser / Helius LaserStream feed (sees trades as they are processed, ~1 slot sooner)
  and sending through Jito / Helius Sender for faster landing.

The free public RPC drops websocket connections; the backup poll then catches trades seconds late. A paid RPC
keeps the websocket up.

## Put it online

You need a small Ubuntu server, a domain pointed at it (a DNS "A" record), and a paid Solana RPC (Helius).

Log in to the server and paste one line:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/frieshimself-cpu/motionlarp/claude/ecstatic-mccarthy-q58vzz/deploy/install.sh)
```

It installs Docker, downloads the site, asks for your **domain**, an **admin password**, your **Helius link** and
your **Jupiter key**, starts everything
(HTTPS certificate included), and switches on automatic updates: every 2 minutes the server checks this branch
for new code and, if there is any, rebuilds and restarts by itself (trades in flight finish first; open positions
and their sell rules survive a restart). Running the line again later is safe: it keeps your settings.

Everything else is done in the browser.

### The Helius link and the Jupiter key: on the server, for good

They live in the server's own file, `/root/motionlarp/.env`, as `RPC_URL=` and `JUPITER_API_KEY=`: set once, used
for every user, readable by root only. The website, the admin page included, cannot show or change them, and
updates and restarts never touch them. To set or replace them, on the server:

```bash
bash /root/motionlarp/deploy/set-keys.sh
```

It asks for each (what you type is not shown; Enter keeps the current one), tests it with a real request, writes
it into the file and restarts the site. A server whose owner typed them into the admin page in the past needs
nothing: the automatic updater moves them into the file by itself (`deploy/keys-to-env.sh`), once.

## The owner page: `https://your-domain/admin`

Log in with the admin password. Only you have it; a user account is never an admin.

- **Status** (its own tab, read-only). A real request to each thing the site trades through, sent when you open
  it: the Helius RPC, the Helius transaction stream, the Helius Sender region, and a real Jupiter quote with the
  key. Green means it answered just now. No key or link is shown and none can be typed there. A red row also
  shows as a banner on the Admin tab.
- **Settings.** The platform fee and the wallet it is paid to, the most a single buy may spend, and the
  **Live trading** switch.
- **License keys.** One key = one account. Create a key for each friend (and one for yourself), copy it when it
  is shown (once), send it to them; pasting it on the site is all they need. "New key" replaces a lost one. A key can carry its own fee (0 % for you, say).
  Revoke a key and its user is locked out and gets no new copies; open positions still sell by their rules.
- **Users.** Wallet, copies, open and closed positions, profit, fees paid; disable or enable anyone.

## Fees

- **Slippage never raises what a buy spends.** A buy spends the amount set; a price that moved gets you fewer
  coins, and the buy fails only when it would get fewer than the quote less your slippage (at 100 % it always
  fills). The same on pump.fun, PumpSwap and Jupiter (each uses its exact-spend instruction; checked on mainnet by
  `npm run check:exactbuy`).
- **Where a coin is traded.** pump.fun's curve and the pool a pump.fun coin graduated into are traded directly;
  every other coin goes through Jupiter's best route (never a side pool somebody opened for it).
- **How a trade is sent.** On every lane at once (the RPC and, with a tip, Helius Sender in the nearest region),
  re-sent about once a second until it lands; both Helius lanes ask for MEV Protect (routing around validators
  linked to sandwich attacks; `MEV_PROTECT=off` switches it off). The last sell of a timed exit never gives up.
- **Trading fees, set per copy by each user:** priority fee and tip, separately for buys and sells, plus slippage.
  The priority fee goes to the network; a tipped trade is also sent through
  Helius Sender (Jito and staked connections at once): a tip of 0.001 SOL or more uses every fast lane, a smaller
  one (from 0.000005 SOL) the lighter lane.
- **Platform fee, set by you on the admin page:** a % of every copy buy and sell, sent to your fee wallet inside
  the same transaction, after the swap: no trade, no fee. A license key can override it. The fee wallet must hold
  at least 0.001 SOL (a transfer into an empty wallet fails and would take the trade with it). Users see the fee
  they pay, and their profit figures include it.

## Going live

1. Run copies in test mode first and read the activity feed and history.
2. Fund a **fresh** wallet with a little SOL, import it, and keep one copy with a small buy (0.01–0.02 SOL).
3. On the admin page turn **Live trading** on and save.
4. Watch the first live buys and sells on Solscan (the feed links each one).

One switch decides: with Live trading on, every enabled copy on the site trades real SOL; off, everything is simulated.

## How the private keys are protected

- **In the browser:** the key is pasted into a masked box, sent once over HTTPS, and never comes back: no page
  or API answer ever contains it, and there is no "export" or "withdraw" on the site. Only scripts served by this
  site can run on its pages (a strict content policy), so injected markup cannot run code.
- **On the server:** keys are stored encrypted (AES-256-GCM under `MASTER_KEY`, each bound to its account), never
  logged (a redactor scrubs anything key-shaped), and decrypted only in memory to sign a trade. The app runs in a
  locked-down container (read-only, no Linux capabilities, non-root). The firewall leaves only SSH and the website
  open; repeated SSH password guesses get the address blocked (fail2ban).
- **Logins:** a license key is the login, so treat it like a password. A lost or leaked key is replaced on the
  admin page ("New key": the old one stops working). Sessions last 90 days from the last visit, in an HttpOnly
  cookie. The admin area has its own password.

What no setting can remove, because the bot has to be able to sign trades while nobody is watching:

- **Whoever controls the server controls the wallets on it.** Keep the server's root password long and unique,
  keep `MASTER_KEY` backed up somewhere else, and delete `MASTER_KEY_BACKUP.txt` from the server once you have.
- **Automatic updates run whatever is pushed to this repository's branch.** Turn on two-factor login on the
  GitHub account that owns it. To stop automatic updates: delete `/etc/cron.d/motionlarp-update`.
- **So everyone should use a fresh wallet holding only what they trade with**, never a main wallet. The site
  warns when a wallet holds more than 5 SOL. Someone who got hold of a friend's license key cannot withdraw, but
  could place bad trades with it; `Max per buy` on the admin page caps what one buy can lose.

## Run it on your own computer

```bash
npm install
cp .env.example .env        # MASTER_KEY (npm run genkey) and ADMIN_PASSWORD; the rest at /admin
npm run dev                 # http://127.0.0.1:3000
npm test                    # 172 tests
npm run check:mainnet       # builds real buys/sells for real wallets on mainnet and simulates them (sends nothing)
npm run check:exactbuy      # a buy at 100 % slippage spends what was asked and no more, curve and PumpSwap (simulated)
# Live-test tooling (REAL transactions, small amounts; read the header of each before running):
#   scripts/live-leader.ts, scripts/live-executor-check.ts; read-only: scripts/check-side-pool.ts
npm run measure             # how many slots behind a copy would be, and how long building it takes
```

Without `RPC_URL` the site works but nothing is watched or traded.

## Layout

```
src/server.ts          the process: website, watcher, engine clock
src/watch/parse.ts     what a wallet did in a transaction (from balance changes)
src/watch/watcher.ts   follows copied wallets: websocket + polling, de-duplicated
src/engine/engine.ts   copies buys, runs the four sell options, one queue per position, retries
src/engine/rules.ts    when timed sells / stop loss levels / dead coin fire (pure logic)
src/engine/settings.ts a copy's settings and their validation
src/engine/executor.ts builds, simulates and (live) sends transactions; reads real fills back
src/venues/, src/tx/   pump.fun + PumpSwap transaction building (ported from Velo, official pump.fun SDKs)
src/store.ts           SQLite: accounts, encrypted wallets, copies, positions, fills, feed
src/http/app.ts        the JSON API (users and admin) and the static site
src/owner-settings.ts  what the owner saves on the admin page (encrypted, applied over the environment)
src/connections.ts     the Status page's live checks (RPC, stream, Sender, Jupiter)
src/export-connections.ts  one-off: reads out keys once saved on the admin page, for deploy/keys-to-env.sh
src/licenses.ts        license keys
src/venues/jupiter.ts  Jupiter route for every coin outside pump.fun / PumpSwap
deploy/                install.sh (one-command install), update.sh (automatic updates), set-keys.sh (Helius link + Jupiter key into .env)
public/                the website (no framework, no build step)
docs/                  design, plan, test record
```
