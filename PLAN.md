# Implementation Plan: API Server

> Source: `specs/api-server.md`
> Generated: 2026-03-07

> **Assumption:** The `@wpm/shared` package (types, crypto, AMM math) and `@wpm/node` package (blockchain node with internal HTTP API + SSE) are fully implemented. The API server builds on top of them.
> **Assumption:** `packages/api/` has a skeleton (package.json, tsconfig.json, Dockerfile) but no `src/` directory yet.
> **Runtime:** Bun — use `bun:sqlite` (built-in), Bun's native `fetch` (with `AbortSignal.timeout`), and `Bun.password` / `Bun.CryptoHasher` where applicable. No Node.js-specific APIs unless unavoidable.

---

## Phase 0 — Tracer Bullets

> Prove two critical seams: (1) authenticated HTTP request → node transaction round-trip, and (2) node SSE → client SSE relay.

### Tracer Bullet 1: Buy Shares End-to-End

- [x] Add Hono dependency to `packages/api/package.json`; run `bun install` (SQLite via `bun:sqlite` built-in — no external dependency needed)
- [x] Create `packages/api/src/index.ts` — Hono app, `GET /health` endpoint (proxy node health, augment with uptime + nodeReachable), serve with `Bun.serve()` on `API_PORT` env (default 3000)
- [x] Create `packages/api/src/node-client.ts` — typed HTTP client using Bun-native `fetch` with `AbortSignal.timeout(5000)`, wrapping all node internal endpoints (`GET /internal/health`, `GET /internal/balance/:addr`, `GET /internal/state`, `GET /internal/market/:id`, `GET /internal/shares/:addr`, `POST /internal/transaction`, `POST /internal/distribute`, `POST /internal/referral-reward`), return `NODE_UNAVAILABLE` error on failure
- [x] Create `packages/api/src/db/index.ts` — SQLite init using `bun:sqlite` `Database` class (WAL mode via `db.exec("PRAGMA journal_mode=WAL")`), `users` table only (id, name, email, wallet_address, wallet_private_key_enc, role, created_at)
- [x] Create `packages/api/src/crypto/wallet.ts` — `generateWalletKeyPair()` using `@wpm/shared` crypto, `encryptPrivateKey(key, secret)` / `decryptPrivateKey(enc, secret)` using AES-256-GCM via `Bun.CryptoHasher` for key derivation and `crypto` module for AES, keyed by `WALLET_ENCRYPTION_KEY` env var. **Note:** Audit `@wpm/shared/crypto` first — it currently uses `node:crypto` (`generateKeyPairSync`, `createSign`, `createVerify`, `createHash`). Evaluate migrating to Bun builtins where possible: `Bun.CryptoHasher` for SHA-256, Web Crypto API (`crypto.subtle`) for RSA sign/verify/keygen. If migration is feasible without breaking `@wpm/node`, update `@wpm/shared/crypto` in-place; otherwise wrap with Bun-native equivalents in the API layer only.
- [x] Create `packages/api/src/middleware/auth.ts` — `signJwt(payload)`, `verifyJwt(token)`, Hono middleware extracting Bearer token → decoded JWT on context (`c.set("user", ...)`)
- [x] Create `packages/api/src/errors.ts` — typed error helper (`apiError(code, status, message)`) and error catalog constants matching spec Section 7
- [x] Create `packages/api/src/routes/trading.ts` — `POST /markets/:marketId/buy` (happy path: extract wallet from JWT, decrypt private key, validate market open via node, construct `PlaceBet` tx, sign with `@wpm/shared` crypto, submit to node, return receipt)
- [x] Write `packages/api/tests/tracer-buy.test.ts` — integration test using `bun:test`: boot node, boot API, seed user row + encrypted key in SQLite, mint JWT, buy shares, verify response shape and node state updated

### Tracer Bullet 2: SSE Relay

- [x] Create `packages/api/src/sse/relay.ts` — on startup connect to node `GET /internal/events`, parse SSE stream, maintain `Map<userId, Response>` of connected clients, enforce 1 connection per user (close prior), 30s keepalive comments
- [x] Create `packages/api/src/routes/events.ts` — `GET /events/stream` with JWT auth via `?token=` query param, register client in relay, stream events
- [x] Write `packages/api/tests/tracer-sse.test.ts` — integration test using `bun:test`: boot node + API, connect SSE client, submit a PlaceBet tx, verify `trade:executed` event received by client

---

## Phase 1 — Auth & Identity

### SQLite Schema Completion

- [x] Add `webauthn_credentials` table to `packages/api/src/db/index.ts` (credential_id TEXT PK, user_id TEXT FK, public_key BLOB, counter INTEGER, created_at INTEGER)
- [x] Add `invite_codes` table (code TEXT PK, created_by TEXT, referrer TEXT nullable, max_uses INTEGER, use_count INTEGER, active INTEGER, created_at INTEGER)
- [x] Add `auth_challenges` table (id TEXT PK, challenge TEXT, type TEXT, user_data TEXT nullable, expires_at INTEGER, created_at INTEGER)
- [x] Create `packages/api/src/db/queries.ts` — prepared statement helpers using `bun:sqlite` `db.query().get()` / `.all()` / `.run()` API: `findUserByEmail`, `findUserById`, `findUserByWallet`, `insertUser`, `findCredentialById`, `insertCredential`, `updateCredentialCounter`, `findActiveInviteCode`, `incrementInviteCodeUse`, `insertChallenge`, `findChallenge`, `deleteChallenge`, `deleteExpiredChallenges`

### WebAuthn Registration (FR-1)

- [x] Add `@simplewebauthn/server` dependency to `packages/api/package.json`
- [x] Create `packages/api/src/routes/auth.ts` — `POST /auth/register/begin` (validate invite code active + has uses, validate email unique case-insensitive, validate name 1-50 chars, generate registration challenge, store in auth_challenges with 60s TTL, return WebAuthn options)
- [x] Implement `POST /auth/register/complete` (retrieve + validate challenge not expired, verify WebAuthn attestation, generate wallet keypair, encrypt private key, insert user + credential in single SQLite transaction, increment invite code use_count, call node `POST /internal/distribute` for 100,000 WPM airdrop, call `POST /internal/referral-reward` if invite code has referrer, issue access JWT + refresh cookie, delete challenge)
- [x] Write tests (`bun:test`): valid registration flow, duplicate email → `DUPLICATE_REGISTRATION` (409), invalid/exhausted invite code → `INVALID_INVITE_CODE` (400), expired challenge → `CHALLENGE_EXPIRED` (400), bad attestation → `WEBAUTHN_VERIFICATION_FAILED` (400)

### WebAuthn Login (FR-2)

- [x] Implement `POST /auth/login/begin` in `packages/api/src/routes/auth.ts` (generate authentication challenge, store in auth_challenges, return options with rpId)
- [x] Implement `POST /auth/login/complete` (retrieve challenge, look up credential by credentialId, verify assertion, update counter, issue access JWT + refresh cookie)
- [x] Write tests (`bun:test`): valid login, unknown credentialId → `UNAUTHORIZED` (401), replayed counter → `UNAUTHORIZED` (401)

### JWT & Refresh Tokens (FR-3)

- [x] Implement refresh token issuance in auth middleware — `httpOnly`, `Secure`, `SameSite=Strict` cookie named `wpm_refresh`, 7-day expiry, issued on login and registration
- [x] Implement `POST /auth/refresh` in `packages/api/src/routes/auth.ts` (read `wpm_refresh` cookie, validate signature + expiry + user exists, issue fresh 15-min access JWT, optionally rotate refresh cookie)
- [x] Write tests (`bun:test`): valid refresh → new JWT, expired cookie → 401, missing cookie → 401

### Admin Auth (FR-4)

- [x] Implement `POST /auth/admin/login` in `packages/api/src/routes/auth.ts` (constant-time compare via `crypto.timingSafeEqual` apiKey vs `ADMIN_API_KEY` env, issue JWT with `role: "admin"`, `sub: "admin"`, 24h expiry)
- [x] Create `packages/api/src/middleware/admin.ts` — middleware checking `role === "admin"` from JWT context, return `FORBIDDEN` (403) otherwise
- [x] Write tests (`bun:test`): correct key → admin JWT, wrong key → 403, user JWT on admin route → 403

---

## Phase 2 — Core User Endpoints

### Wallet Endpoints (FR-5)

- [x] Create `packages/api/src/routes/wallet.ts` — `GET /wallet/balance` (read wallet from JWT, proxy to node `GET /internal/balance/:addr`)
- [x] Implement `GET /wallet/transactions` (fetch node state, filter transactions where user is sender or recipient, sort timestamp desc, paginate with `limit` default 50 max 200 and `offset` default 0)
- [x] Write tests (`bun:test`): balance matches node, pagination respected, limit clamped to 200

### Market Endpoints (FR-6)

- [x] Create `packages/api/src/routes/markets.ts` — `GET /markets` (fetch node state, filter `status: "open"` markets, enrich each with `calculatePrices()` from `@wpm/shared`, compute multipliers as `1/price`, compute `totalVolume` by summing `PlaceBet` + `SellShares` amounts for market)
- [x] Implement `GET /markets/:marketId` (fetch `GET /internal/market/:id`, fetch user positions from `GET /internal/shares/:addr`, compute estimated values using current prices, return market + pool + userPosition or null)
- [x] Implement `GET /markets/:marketId/trades` (filter PlaceBet/SellShares txs by marketId from node state, join with SQLite users table for display names, sort desc, paginate limit default 20 max 100)
- [x] Implement `GET /markets/resolved` (filter resolved + cancelled markets from node state, paginate limit default 20 max 100)
- [x] Write tests (`bun:test`): prices sum to ~1.00, userPosition populated/null correctly, MARKET_NOT_FOUND (404), trades show user names

### Trading Endpoints — Remaining (FR-7)

- [x] Implement `POST /markets/:marketId/buy/preview` in `packages/api/src/routes/trading.ts` (read-only AMM `calculateBuy` from `@wpm/shared`, return sharesReceived, effectivePrice, priceImpact, fee, newPriceA, newPriceB)
- [x] Implement `POST /markets/:marketId/sell/preview` (read-only `calculateSell`, return wpmReceived, effectivePrice, priceImpact, fee, newPrices)
- [x] Implement `POST /markets/:marketId/sell` (validate user holds sufficient shares via node, construct `SellShares` tx, sign with custodial key, submit to node)
- [x] Create `packages/api/src/validation.ts` — shared helpers: `validateAmount(n)` (>0, ≤2 decimal places), `validateOutcome(o)` ("A" or "B"), `validateMarketTradeable(market)` (exists, open, eventStartTime > now)
- [x] Write tests (`bun:test`): preview matches actual trade with no intervening trades, 3+ decimal places → `INVALID_AMOUNT` (400), market past eventStartTime → `MARKET_CLOSED` (400), insufficient balance → `INSUFFICIENT_BALANCE` (400), insufficient shares → `INSUFFICIENT_SHARES` (400), resolved market → `MARKET_ALREADY_RESOLVED` (400)

### Transfer Endpoint (FR-8)

- [x] Implement `POST /wallet/transfer` in `packages/api/src/routes/wallet.ts` (validate amount, validate recipient exists on-chain, validate sender ≠ recipient, construct `Transfer` tx, sign with custodial key, submit to node)
- [x] Write tests (`bun:test`): valid transfer succeeds, self-transfer → `INVALID_TRANSFER` (400), unknown recipient → `RECIPIENT_NOT_FOUND` (404)

### User Profile & Positions (FR-9)

- [x] Create `packages/api/src/routes/user.ts` — `GET /user/profile` (read from SQLite users table, return userId, name, email, walletAddress, createdAt)
- [x] Implement `GET /user/positions` (fetch share positions from node `GET /internal/shares/:addr`, fetch open markets from node state, join to compute current prices and estimated values per position)
- [x] Implement `GET /user/history` (filter resolved markets where user had shares, compute payout from SettlePayout txs for user, compute profit as payout minus cost basis)
- [x] Write tests (`bun:test`): profile fields correct, positions include current valuations, history includes accurate payout/profit

### Leaderboard (FR-10)

- [x] Create `packages/api/src/routes/leaderboard.ts` — `GET /leaderboard/alltime` (for each user in SQLite: fetch balance + sum estimated position values from node, sort desc by totalWpm, tiebreak by walletAddress, assign 1-indexed ranks)
- [x] Implement `GET /leaderboard/weekly` (define week as Mon 00:00 UTC → Sun 23:59 UTC, calculate weeklyPnl = current totalWpm − totalWpm at week-start derived from chain replay to Monday boundary block, sort desc)
- [x] Write tests (`bun:test`): rankings deterministic, weekly window boundaries correct

---

## Phase 3 — Admin Endpoints

### Token Distribution (FR-12)

- [x] Create `packages/api/src/routes/admin.ts` — `POST /admin/distribute` (admin auth, validate recipient exists on-chain, validate amount > 0 with ≤2 decimals, validate reason in `["signup_airdrop", "referral_reward", "manual"]`, call node `POST /internal/distribute`)
- [x] Write test (`bun:test`): treasury decreases, recipient increases, invalid reason rejected

### Invite Code Management (FR-13)

- [x] Implement `POST /admin/invite-codes` in `packages/api/src/routes/admin.ts` (generate `count` unique 8-char uppercase alphanumeric codes, store each with maxUses, use_count=0, active=1, optional referrer validated as existing wallet)
- [x] Implement `GET /admin/invite-codes` (list all codes with full metadata)
- [x] Implement `DELETE /admin/invite-codes/:code` (set active=0, keep record)
- [x] Write tests (`bun:test`): correct count generated, codes are unique 8-char, deactivated code rejects registration

### Market Operations (FR-14)

- [ ] Implement `POST /admin/markets/:marketId/cancel` in `packages/api/src/routes/admin.ts` (construct `CancelMarket` tx signed by PoA/admin authority, submit to node)
- [ ] Implement `POST /admin/markets/:marketId/resolve` (construct `ResolveMarket` tx, submit to node)
- [ ] Implement `POST /admin/markets/:marketId/seed` (check market has no PlaceBet/SellShares trades, if so reject with `MARKET_HAS_TRADES` (400), otherwise cancel existing + recreate with new seed amount)
- [ ] Write tests (`bun:test`): cancel succeeds, resolve succeeds, seed override rejected when trades exist

### System Monitoring (FR-15)

- [ ] Implement `GET /admin/treasury` in `packages/api/src/routes/admin.ts` (derive from node state: balance from treasury address, totalDistributed = sum of Distribute amounts, totalSeeded = sum of CreateMarket seedAmounts, totalReclaimed = sum of SettlePayout with `payoutType: "liquidity_return"` to treasury)
- [ ] Implement `GET /admin/users` (join SQLite users with node balances)
- [ ] Implement `GET /admin/health` (proxy node `GET /internal/health`, augment with API uptime, apiVersion from package.json, connectedSSEClients count from relay)
- [ ] Write tests (`bun:test`): treasury aggregates consistent with chain, health reflects node status

### Oracle Triggers (FR-16)

- [ ] Implement `POST /admin/oracle/ingest` in `packages/api/src/routes/admin.ts` (proxy to `http://wpm-oracle:3001/trigger/ingest` via `fetch` with `AbortSignal.timeout(30_000)`)
- [ ] Implement `POST /admin/oracle/resolve` (proxy to `http://wpm-oracle:3001/trigger/resolve` via `fetch` with `AbortSignal.timeout(30_000)`)
- [ ] Write tests (`bun:test`): successful forward, oracle unreachable → `NODE_UNAVAILABLE` (503)

---

## Phase 4 — Oracle Inbound Interface

### Oracle Transaction Relay

- [ ] Create `packages/api/src/routes/oracle.ts` — `POST /oracle/transaction` (validate oracle signature against `ORACLE_PUBLIC_KEY` loaded from env/file, forward valid signed tx to node `POST /internal/transaction`)
- [ ] Implement `GET /oracle/markets` (proxy to node state, filter by `?status=` query param supporting comma-separated values like `open,resolved,cancelled`)
- [ ] Write tests (`bun:test`): valid oracle signature → forwarded, invalid signature → rejected, status filter works

---

## Phase 5 — Cross-Cutting Concerns

### SSE Event Transformation

- [ ] Enrich `packages/api/src/sse/relay.ts` with event-type mapping: node `trade:executed` → client `price:update` + `bet:placed` + `balance:update`, node `market:created` → client `market:created`, node `market:resolved` → client `market:resolved` + `payout:received` + `balance:update` + `leaderboard:update`, node `block:new` → client `block:new`
- [ ] Add volume computation to `price:update` events (sum PlaceBet + SellShares amounts for market)
- [ ] Implement `Last-Event-ID` reconnection — on client reconnect, replay missed events from the referenced block index onward via node `GET /internal/blocks?from=N`
- [ ] Write tests (`bun:test`): each event type transforms correctly, reconnection replays missed events

### Rate Limiting (NFR-4)

- [ ] Create `packages/api/src/middleware/rate-limit.ts` — in-memory sliding window rate limiter
- [ ] Apply per scope: 60/min user endpoints (key: userId), 120/min admin endpoints (key: IP), 10/min auth endpoints (key: IP), 1 concurrent SSE per user
- [ ] Return HTTP 429 with `Retry-After` header and `{ error: { code: "RATE_LIMITED", message } }` body
- [ ] Write tests (`bun:test`): within limit → succeeds, exceeding limit → 429 with Retry-After

### Input Validation & CORS

- [ ] Add CORS middleware to Hono app (allow `CORS_ORIGIN` env, default `https://wpm.example.com`)
- [ ] Add request body size limit of 64 KB
- [ ] Add `X-Request-Id` generation middleware (`crypto.randomUUID()` per request, set on context for logging)
- [ ] Reject unknown/extra fields on all request bodies (strict schema validation)

### Structured Logging

- [ ] Create `packages/api/src/logger.ts` — structured JSON logger using `Bun.write(Bun.stdout, ...)` for zero-copy output: timestamp, level, requestId, userId, method, path, statusCode, durationMs, error
- [ ] Add request/response logging middleware (log on completion with duration)
- [ ] Audit log all admin actions (timestamp, admin identity, action, details)
- [ ] Never log private keys, JWT tokens, or full WebAuthn credentials

### Graceful Shutdown

- [ ] Handle SIGTERM/SIGINT in `packages/api/src/index.ts`: call `server.stop()` on the `Bun.serve()` instance to drain in-flight requests, close SSE relay (disconnect all clients), close `bun:sqlite` Database, exit
