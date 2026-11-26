# motionlarp — copy club

A website where you and your friends each import a wallet, pick wallets to copy, and let the server copy their
pump.fun trades around the clock: your buy size, your minimum, your exits.

- **Copy any wallet.** Paste its address. When it buys a pump.fun or PumpSwap coin for at least your minimum, you
  buy your amount.
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

## Put it online (about 20 minutes)

You need: a small Linux server (2 GB RAM is plenty), a domain name, and a **paid Solana RPC** (Helius, QuickNode
or Triton). The free public RPC rate-limits within minutes of real use.

1. Point your domain (e.g. `copy.yourdomain.com`) at the server's IP (a DNS "A" record).
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

## Safety, in plain words

- **Friends should use a fresh wallet** holding only what they copy with, never their main wallet. The server
  holds the key (encrypted). If the server were broken into while running, those wallets could be drained.
- Keys are encrypted with `MASTER_KEY` and tied to the account that imported them. They are never logged, never
  shown again, and never sent to the browser.
- A wallet can't be removed or swapped while it has open positions (the coins would be stranded).
- `MAX_SOL_PER_BUY` caps every buy. `FEE_RESERVE_SOL` keeps SOL back for fees.
- Only pump.fun bonding-curve and PumpSwap coins traded against SOL are copied. Anything else is skipped with a
  reason in the feed.

## Run it on your own computer

```bash
npm install
cp .env.example .env        # put MASTER_KEY in (npm run genkey); RPC_URL optional
npm run dev                 # http://127.0.0.1:3000
npm test                    # 80 tests
npm run check:mainnet       # builds real buys/sells for real wallets on mainnet and simulates them (sends nothing)
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
