# motionlarp — copy club

A website where you and your friends each import a wallet, pick wallets to copy, and let the server copy their
pump.fun trades around the clock: your buy size, your minimum, your exits.

- **Copy any wallet, on any coin.** Paste its address. When it buys a coin for at least your minimum, you buy your
  amount: pump.fun and PumpSwap through the fast native route; every other launchpad and exchange (Raydium
  LaunchLab / Bonk, Meteora DBC, Raydium, Meteora, Orca, …) and coins paired with USDC, USD1 or anything else
  through Jupiter. You always pay and receive SOL. A wallet paying with USDC or another coin counts as a buy too,
  valued in SOL for your minimum.
- **Four sell options, mixed however you like.** Every % is a share of what you *still hold*.
  - **Sell when they sell**: the same share of your bag they sold of theirs, or everything.
  - **Timed sells**: e.g. 25 % after 3 s → 50 % after 6 s → 100 % after 9 s.
  - **Stop loss levels**: e.g. −30 % sell half, −60 % sell the rest. Each fires once.
  - **Dead coin**: no trades for N seconds → sell everything.
- **Sell now** button on every open position.
- **Test mode first.** Every copy starts in test mode: buys are checked against the real chain, fills come from
  real prices, nothing is sent. Switch a copy to Live once you trust it.
- A live feed of every buy, sell and skipped copy (with the reason), and a history with profit per trade.

The look is Miami at night: a lit marquee sign, neon glass, a skyline over the water. It works on a phone.

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

## Put it online (about 20 minutes)

You need: a small Linux server (2 GB RAM is plenty), a domain name, and a **paid Solana RPC** (Helius, QuickNode
or Triton). The free public RPC rate-limits within minutes of real use.

1. Point your domain (e.g. `copy.yourdomain.com`) at the server's IP (a DNS "A" record). Optional: a `CNAME`
   for `www` pointing to the domain, so `www.` forwards to it.
2. On the server, install Docker, then:
   ```bash
   git clone https://github.com/frieshimself-cpu/motionlarp && cd motionlarp
   cp .env.example .env
   ```
3. Edit `.env`:
   - `RPC_URL`: your Helius / QuickNode URL.
   - `MASTER_KEY`: run `openssl rand -hex 32` and paste the result. **Back it up somewhere safe.** Without it the
     stored wallet keys can never be read again.
   - `SIGNUP_CODE`: the invite code your friends type to sign up.
   - `DOMAIN`: your domain.
   - Leave `LIVE_TRADING=false` for now.
4. Start it:
   ```bash
   docker compose up -d --build
   ```
   Caddy fetches the HTTPS certificate by itself. Open `https://your-domain`, sign up, and send friends the link
   and the code.

Logs: `docker compose logs -f app`. Update: `git pull && docker compose up -d --build`.

## Going live

1. Run copies in test mode for a day and read the feed and history: are the right buys copied, and do the
   sells fire when they should?
2. Fund a **fresh** wallet with a little SOL, import it, set one copy to Live with a small buy (0.01–0.02 SOL).
3. Set `LIVE_TRADING=true` and `MAX_SOL_PER_BUY` (the most any single copy buy may spend) in `.env`, then
   `docker compose up -d`.
4. Watch the first live buys and sells on Solscan (the feed links each one).

Both switches are needed for a real trade: the server's `LIVE_TRADING=true` **and** the copy set to Live.

## Platform fee (your cut)

Set in `.env`:

- `FEE_BPS`: the fee in basis points. 100 = 1 % of every copy buy and every sell. 0 = off. The cap is 10 %.
- `FEE_WALLET`: the wallet that receives it. **It must already hold at least 0.001 SOL.** A small transfer into
  an empty wallet fails, and the trade fails with it, so the server refuses to start until it does.
- `FEE_EXEMPT_USERS`: usernames that pay nothing (yours, say), comma-separated.

The fee is a transfer inside the same transaction as the trade, after the swap: if the trade fails, no fee is
paid. Users see the fee on the site (a FEE pill, the copy editor, fees paid in their history), and their profit
figures include it. The incoming fees are visible on Solscan on `FEE_WALLET`. Checked on mainnet: real buys
and sells with the fee transfer included simulate cleanly.

## Safety, in plain words

- **Friends should use a fresh wallet** holding only what they copy with, never their main wallet. The server
  holds the key (encrypted). If the server were broken into while running, those wallets could be drained.
- Keys are encrypted with `MASTER_KEY` and tied to the account that imported them. They are never logged, never
  shown again, and never sent to the browser.
- A wallet can't be removed or swapped while it has open positions (the coins would be stranded).
- `MAX_SOL_PER_BUY` caps every buy. `FEE_RESERVE_SOL` keeps SOL back for fees.
- Any coin Jupiter can route is copied. A coin only seconds old on a non-pump.fun launchpad can take Jupiter
  ~10–15 s to pick up: the buy waits for it (up to ~15 s), so such copies land later. pump.fun coins don't wait.

## Run it on your own computer

```bash
npm install
cp .env.example .env        # put MASTER_KEY in (npm run genkey); RPC_URL optional
npm run dev                 # http://127.0.0.1:3000
npm test                    # 103 tests
npm run check:mainnet       # builds real buys/sells for real wallets on mainnet and simulates them (sends nothing)
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
src/http/app.ts        the JSON API and the static site
public/                the website (no framework, no build step)
docs/                  design, plan, test record
```
