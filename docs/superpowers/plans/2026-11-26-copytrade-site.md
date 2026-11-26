# motionlarp copytrade site — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a website where each friend imports a wallet key and copies chosen wallets' pump.fun / PumpSwap trades
with a custom buy size, a minimum leader buy, and four sell options.

**Architecture:** one Node 22 TypeScript process: `node:http` API + static site, a leader watcher (websocket +
poller over standard Solana RPC), a copy engine with a pure sell-rules core, Velo's venue code for building
transactions, SQLite through `node:sqlite`.

**Tech stack:** Node ≥ 22.13, TypeScript strict, `@solana/web3.js` v1, `@pump-fun/pump-sdk` 4, `@pump-fun/pump-swap-sdk`
2, `@solana/spl-token`, `bs58`, `bn.js`, `dotenv`, vitest. No frontend framework: one HTML page, CSS, vanilla JS.

**Spec:** `docs/superpowers/specs/2026-11-26-copytrade-site-design.md`

## Global constraints

- Nothing is sent on-chain unless `LIVE_TRADING=true` **and** the copy's mode is `live`. The gate lives in `src/tx/send.ts` only.
- `MAX_SOL_PER_BUY` (env, default `0.05`) caps every buy.
- Secret keys: encrypted at rest (AES-256-GCM, `MASTER_KEY`), decrypted only in memory to sign, never logged
  (Velo's redactor), never returned by the API.
- Every sell % is a share of the tokens held at that moment; the last stage of 100 % empties the position.
- Velo is not modified; ported files carry a `// ported from velo/<path>` header.

## Review focus

1. Leader sells while one of our sells is in flight → sells serialize; the second sells P % of what is left.
2. Server restarts with open positions → timers rebuilt from `opened_at`; overdue timed sells fire at once.
3. A leader transaction that is not pump.fun / PumpSwap (Jupiter route, transfer) → no copy, no crash.
4. The same leader signature arriving from both the socket and the poller → handled once.
5. A copy whose wallet has too little SOL → skipped with a reason in the feed, no transaction built.

---

### Task 1: Scaffold + port Velo's trading code
**Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `.npmrc`, `.env.example`, `.gitignore`;
port `src/config.ts` (rewritten for this app), `src/log.ts`, `src/chain/connection.ts`, `src/venues/{sdk,types,pumpfun,pumpswap,pf}.ts`
(drop the prepare-cache dependency from `pf.ts`), `src/tx/{build,send,confirm}.ts`, `src/wallets.ts`.
- [ ] `npm install`, `npm run typecheck` passes. Test `tests/redact.test.ts`: a 64-byte base58 key in any field is redacted.

### Task 2: Leader trade parser
**Files:** `src/watch/parse.ts`, `tests/parse.test.ts`, `tests/fixtures/tx/*.json` (real mainnet `getTransaction` results).
**Produces:** `parseLeaderTrades(tx: ParsedLikeTx, leader: string): LeaderTrade[]` where
`LeaderTrade = { signature, leader, mint, side: 'buy'|'sell', solLamports: bigint, tokenAmount: bigint, tokensBefore: bigint, tokensAfter: bigint, venue: 'pumpfun'|'pumpswap', slot, blockTime }`.
- [ ] Tests on fixtures: a pump.fun curve buy (side buy, sol ≈ leader SOL drop − fee), a curve sell (soldShare = sold/before), a PumpSwap trade, a failed tx (→ []), a non-pump tx (→ []).

### Task 3: Sell rules (pure)
**Files:** `src/engine/rules.ts`, `src/engine/settings.ts`, `tests/rules.test.ts`, `tests/settings.test.ts`.
**Produces:** `CopySettings` (buySol, minLeaderBuySol, slippagePct, priorityFeeSol, mode, sell: { mirror: { enabled, mode: 'same'|'all' }, timed: {afterSec, percent}[], stopLoss: {lossPct, percent}[], deadCoin: { enabled, idleSec } }),
`validateSettings(input: unknown): CopySettings` (throws `SettingsError` with a readable message),
`dueSells(pos: PositionView, now: number): SellOrder[]` with `SellOrder = { reason: 'timed'|'stop_loss'|'dead_coin'|'mirror'|'manual', percent, stage? }`.
- [ ] Tests: 25/50/100 at 3 s intervals fire in order once each; stop loss −30 % fires once at −31 %; dead coin after idleSec of unchanged quote; validation rejects percent ≤ 0 or > 100, negative times, buySol ≤ 0.

### Task 4: Store
**Files:** `src/store.ts`, `tests/store.test.ts`. Tables: users, sessions, wallets (enc key), copies (settings JSON),
positions (copy_id, mint, tokens, cost_lamports, opened_at, fired stages JSON, status, realized_lamports, mode), fills,
events (feed). Money is INTEGER lamports / token base units.

### Task 5: Copy engine
**Files:** `src/engine/engine.ts`, `src/engine/executor.ts`, `tests/engine.test.ts`.
**Produces:** `Engine.onLeaderTrade(t: LeaderTrade)`, `Engine.tick(now)`, `Engine.sellNow(userId, positionId)`, `Engine.restore()`;
`Executor { buy(req): Promise<Fill>; sell(req): Promise<Fill>; quoteSell(mint, tokens): Promise<{ lamports: bigint }>; solBalance(pubkey) }`.
- [ ] Tests with a fake executor + fake clock: min leader buy skip; already-holding skip; low-SOL skip; mirror same-share; mirror all; serialized sells; restore fires overdue timed sell; duplicate signature handled once.

### Task 6: Watcher
**Files:** `src/watch/watcher.ts`. Websocket `onLogs(leader)` + poller `getSignaturesForAddress` every `POLL_MS`; LRU of seen signatures; `getTransaction` with retries; emits `LeaderTrade`s to the engine; resubscribes when the leader set changes.

### Task 7: Auth, crypto, API
**Files:** `src/crypto.ts`, `src/auth.ts`, `src/http/*.ts`, `src/server.ts`, `tests/api.test.ts`.
Routes: `POST /api/signup|login|logout`, `GET /api/me`, `POST|DELETE /api/wallet`, `GET|POST /api/copies`, `PUT|DELETE /api/copies/:id`,
`GET /api/state` (wallet balance, copies, open positions, feed), `GET /api/history`, `POST /api/positions/:id/sell`.
- [ ] Tests: sign-up needs the code; wrong password 401; wallet key never in any response; another user's copy 404; delete wallet refused with open positions.

### Task 8: Website
**Files:** `public/index.html`, `public/app.css`, `public/app.js`. Login/sign-up, wallet card, copies list + editor with the sell-option builder, positions with live P/L and Sell now, activity feed, history. Phone-friendly.

### Task 9: Mainnet check, deploy, docs
**Files:** `scripts/check-mainnet.ts`, `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `README.md`.
- [ ] `npm run check:mainnet`: finds a recent pump.fun trade, parses it, builds our buy and sell for the trader's wallet, simulates both (sigVerify off) without error.
