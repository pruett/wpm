# API Server — Component Specification

> **System:** WPM (Wampum) Prediction Market Platform
> **Source:** [ARCHITECTURE.md](/ARCHITECTURE.md)
> **Status:** Draft
> **Last updated:** 2026-03-06

## 1. Overview

The API server is the HTTP interface between external clients (web app, admin portal) and the blockchain node. It is a stateless request handler that authenticates users via WebAuthn/passkeys, validates and translates client requests into blockchain transactions, queries on-chain state, and streams real-time updates over Server-Sent Events. It runs as its own Docker container (`wpm-api`) on the same host as the blockchain node, communicating over the Docker internal network.

The API server does not own chain state. It borrows all blockchain data (balances, markets, pools, share positions) from the node and owns only authentication-related data (user accounts, WebAuthn credentials, invite codes, JWT sessions).

## 2. Context

### System Context Diagram

```mermaid
graph LR
    WebApp[Web App / PWA] -->|HTTPS REST + SSE| API[API Server :3000]
    Admin[Admin Portal] -->|HTTPS REST| API
    Oracle[Oracle Server] -->|HTTP /oracle/*| API
    API -->|Internal HTTP + SSE| Node[Blockchain Node]
    API -->|Internal HTTP (trigger)| Oracle
    Nginx[Nginx Reverse Proxy] -->|proxy_pass| API
    WebApp -.->|TLS termination| Nginx
    Admin -.->|TLS termination| Nginx
```

### Assumptions

- The blockchain node is always reachable on the Docker internal network at a known hostname (`wpm-node`).
- The node's internal API (documented in the blockchain-node spec) is the sole interface for reading chain state and submitting transactions.
- Nginx handles TLS termination; the API server accepts plain HTTP internally.
- User count is small (friend group, tens of users). No horizontal scaling required at launch.
- Wallet key pairs are custodial — generated and stored server-side. The passkey proves identity; the server signs transactions on the user's behalf.
- A single API server instance handles all traffic. No load balancer between Nginx and the API server.
- Domain is TBD. `wpm.example.com` is used as a placeholder throughout this document.

### Constraints

- **Runtime:** Node.js with TypeScript (matches the rest of the monorepo).
- **Framework:** Hono, Fastify, or Express — lightweight HTTP framework. No heavy ORM.
- **Auth storage:** User accounts, WebAuthn credentials, and invite codes are stored in a local SQLite database inside the API container, persisted via Docker volume.
- **No direct chain mutation:** The API server never writes to `chain.jsonl`. All mutations go through the node's `POST /internal/transaction` endpoint.
- **Decimal precision:** All WPM amounts use 2-decimal precision. The API must reject or round amounts with more than 2 decimal places.

## 3. Functional Requirements

### FR-1: User Registration (WebAuthn)

**Description:** New users register with an invite code, personal details, and a passkey credential. The server creates a custodial wallet and triggers on-chain airdrop and referral transactions.

**Trigger:** `POST /auth/register/begin` followed by `POST /auth/register/complete`

**Step 1 — Begin Registration:**

```
POST /auth/register/begin
Content-Type: application/json

{
  "inviteCode": "ABC123",
  "name": "Kevin",
  "email": "kevin@example.com"
}
```

Response `200`:

```json
{
  "challengeId": "uuid",
  "publicKey": {
    "challenge": "base64url-encoded",
    "rp": { "name": "WPM", "id": "wpm.example.com" },
    "user": { "id": "base64url-user-id", "name": "kevin@example.com", "displayName": "Kevin" },
    "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }],
    "authenticatorSelection": { "residentKey": "required", "userVerification": "required" },
    "timeout": 60000
  }
}
```

**Processing (begin):**

1. Validate `inviteCode` exists, is active, and has remaining uses (`useCount < maxUses`).
2. Validate `email` is not already registered (case-insensitive).
3. Validate `name` is 1-50 characters, `email` is a valid format.
4. Generate a WebAuthn registration challenge with a 60-second TTL.
5. Store the challenge temporarily (in-memory or short-lived DB row), keyed by `challengeId`.

**Step 2 — Complete Registration:**

```
POST /auth/register/complete
Content-Type: application/json

{
  "challengeId": "uuid",
  "credential": { /* WebAuthn AuthenticatorAttestationResponse */ }
}
```

Response `201`:

```json
{
  "userId": "uuid",
  "walletAddress": "base64-public-key",
  "token": "jwt-token"
}
```

**Processing (complete):**

1. Retrieve and validate the challenge by `challengeId` (must exist, not expired).
2. Verify the WebAuthn attestation response against the stored challenge.
3. Generate an RSA key pair for the user's custodial wallet.
4. Store the user record: `{ userId, name, email, walletAddress, createdAt }`.
5. Store the WebAuthn credential: `{ credentialId, publicKey, userId, counter }`.
6. Store the wallet private key (encrypted at rest with a server-side secret).
7. Mark the invite code use: increment `useCount`; if `maxUses` reached, set `active = false`.
8. Call `POST /internal/distribute` on the node to airdrop 100,000 WPM to the new wallet. The node generates and signs the transaction internally.
9. If the invite code has a `referrer`, call `POST /internal/referral-reward` on the node to send 5,000 WPM to the referrer. The node generates and signs the transaction internally.
10. Issue a JWT session token (see FR-3).
11. Delete the consumed challenge.

**Acceptance Criteria:**

- [ ] Given a valid invite code and unique email, when registration completes, then a wallet is created and 100,000 WPM airdrop transaction is submitted to the node.
- [ ] Given an invite code with a referrer, when registration completes, then a 5,000 WPM referral transaction is also submitted.
- [ ] Given an already-used invite code (at max uses), when begin is called, then return `INVALID_INVITE_CODE` (400).
- [ ] Given a duplicate email, when begin is called, then return `DUPLICATE_REGISTRATION` (409).
- [ ] Given an expired or invalid challenge, when complete is called, then return `CHALLENGE_EXPIRED` (400).
- [ ] Given an invalid WebAuthn attestation, when complete is called, then return `WEBAUTHN_VERIFICATION_FAILED` (400).

---

### FR-2: User Login (WebAuthn)

**Description:** Existing users authenticate with their passkey.

**Trigger:** `POST /auth/login/begin` followed by `POST /auth/login/complete`

**Step 1 — Begin Login:**

```
POST /auth/login/begin
Content-Type: application/json

{}
```

Response `200`:

```json
{
  "challengeId": "uuid",
  "publicKey": {
    "challenge": "base64url-encoded",
    "rpId": "wpm.example.com",
    "userVerification": "required",
    "timeout": 60000
  }
}
```

**Step 2 — Complete Login:**

```
POST /auth/login/complete
Content-Type: application/json

{
  "challengeId": "uuid",
  "credential": { /* WebAuthn AuthenticatorAssertionResponse */ }
}
```

Response `200`:

```json
{
  "userId": "uuid",
  "walletAddress": "base64-public-key",
  "token": "jwt-token"
}
```

**Processing (complete):**

1. Retrieve the challenge by `challengeId`.
2. Look up the credential by `credentialId` from the assertion.
3. Verify the WebAuthn assertion against the stored public key.
4. Update the credential's `counter` (replay protection).
5. Issue a JWT session token.

**Acceptance Criteria:**

- [ ] Given valid passkey credentials, when login completes, then a JWT is returned with the correct `userId`, `walletAddress`, and `role`.
- [ ] Given an unknown credential ID, when complete is called, then return `UNAUTHORIZED` (401).
- [ ] Given a replayed assertion (counter not incremented), when complete is called, then return `UNAUTHORIZED` (401).

---

### FR-3: Session Management (JWT)

**Description:** Authenticated sessions are managed via stateless JWT tokens.

**Token Structure:**

```json
{
  "sub": "user-uuid",
  "wallet": "base64-public-key",
  "role": "user",
  "iat": 1700000000,
  "exp": 1700604800
}
```

| Field    | Type                  | Description                                               |
| -------- | --------------------- | --------------------------------------------------------- |
| `sub`    | string                | User ID (UUID)                                            |
| `wallet` | string                | Wallet public key (base64)                                |
| `role`   | `"user"` or `"admin"` | Authorization role                                        |
| `iat`    | number                | Issued-at timestamp (Unix seconds)                        |
| `exp`    | number                | Expiry timestamp (Unix seconds), 15 minutes from issuance |

**Rules:**

- Passed in `Authorization: Bearer <token>` header on all authenticated requests.
- Signed with HS256 using a server-side secret (`JWT_SECRET` env var).
- Access token: 15-minute expiry.
- Refresh token (`httpOnly` cookie): 7-day expiry.
- Admin JWT: 24-hour expiry (access token for admin role; no refresh token).
- Token is validated on every request by middleware before the route handler runs.

#### Refresh Token Mechanism

On successful login (or registration), the server issues both:

1. A short-lived **access JWT** (15-minute expiry) returned in the response body.
2. A long-lived **refresh token** set as an `httpOnly`, `Secure`, `SameSite=Strict` cookie named `wpm_refresh` with a 7-day expiry.

#### POST /auth/refresh

On page load (or when the access token expires), the web app calls this endpoint. No request body is needed — the refresh cookie is sent automatically by the browser.

**Processing:**

1. Read the `wpm_refresh` cookie from the request.
2. Validate the refresh token (signature, expiry, and that it maps to an active user in SQLite).
3. If valid, issue a new access JWT (15-minute expiry) and return it in the response body. Optionally rotate the refresh cookie (issue a new one with a fresh 7-day expiry).
4. If the cookie is missing, expired, or invalid, return `UNAUTHORIZED` (401). The client should prompt the user to re-authenticate with their passkey.

**Response `200`:**

```json
{
  "token": "new-jwt-token"
}
```

**Response `401`:**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Refresh token expired or missing. Please re-authenticate."
  }
}
```

**Acceptance Criteria:**

- [ ] Given no `Authorization` header, when an authenticated endpoint is called, then return `UNAUTHORIZED` (401).
- [ ] Given an expired token, when an authenticated endpoint is called, then return `UNAUTHORIZED` (401).
- [ ] Given a token with an invalid signature, when an authenticated endpoint is called, then return `UNAUTHORIZED` (401).
- [ ] Given a valid token with `role: "user"`, when an admin endpoint is called, then return `FORBIDDEN` (403).
- [ ] Given a valid `wpm_refresh` cookie, when `POST /auth/refresh` is called, then a fresh access JWT is returned.
- [ ] Given an expired or missing `wpm_refresh` cookie, when `POST /auth/refresh` is called, then return `UNAUTHORIZED` (401).

---

### FR-4: Admin Authentication

**Description:** Admin access uses a static API key, separate from standard user passkeys.

**Mechanism:** A static API key is stored in the `ADMIN_API_KEY` environment variable. The admin enters this key on the admin login form in the web app. The API server validates it and returns a JWT with `role: "admin"`.

#### POST /auth/admin/login

**Request:**

```json
{
  "apiKey": "the-static-admin-key"
}
```

**Processing:**

1. Compare the provided `apiKey` against the `ADMIN_API_KEY` environment variable (constant-time comparison).
2. If matched, issue a JWT with `role: "admin"`, `sub: "admin"`, and a 24-hour expiry (no user-specific identity).
3. Return the JWT. All subsequent admin requests use this JWT in the `Authorization: Bearer <token>` header, identical to user auth flow.
4. If the key does not match, return `FORBIDDEN` (403).

**Response `200`:**

```json
{
  "token": "jwt-token",
  "role": "admin"
}
```

> **Note:** A dedicated admin passkey mechanism is out of scope for MVP. The static API key is sufficient for a small, trusted admin group.

**Acceptance Criteria:**

- [ ] Given the correct admin API key, when `/auth/admin/login` is called, then a JWT with `role: "admin"` is returned.
- [ ] Given an incorrect or missing key, when `/auth/admin/login` is called, then return `FORBIDDEN` (403).
- [ ] Given a valid admin JWT, when an admin endpoint is called, then the request succeeds.
- [ ] Given a user JWT, when an admin endpoint is called, then return `FORBIDDEN` (403).

---

### FR-5: Wallet Endpoints

**Description:** Users query their balance and transaction history.

#### GET /wallet/balance

**Input:** Authenticated user (wallet address from JWT).

**Processing:** Calls `GET /internal/balance/:addr` on the node.

**Response `200`:**

```json
{
  "address": "base64-public-key",
  "balance": 95432.5
}
```

#### GET /wallet/transactions

**Input:** Query params `limit` (default 50, max 200) and `offset` (default 0).

**Processing:** Calls `GET /internal/state` on the node, filters transactions involving the user's wallet address (as sender or recipient), sorts by timestamp descending, applies pagination.

**Response `200`:**

```json
{
  "transactions": [
    {
      "id": "uuid",
      "type": "PlaceBet",
      "timestamp": 1700000000000,
      "sender": "base64-key",
      "amount": 500.0,
      "marketId": "uuid",
      "outcome": "A"
    }
  ],
  "total": 147
}
```

**Acceptance Criteria:**

- [ ] Given a user with a known balance, when `/wallet/balance` is called, then the returned balance matches the node's state.
- [ ] Given `limit=10&offset=5`, when `/wallet/transactions` is called, then exactly up to 10 transactions are returned starting from the 6th.
- [ ] Given `limit=500`, when called, then limit is clamped to 200.

---

### FR-6: Market Endpoints

**Description:** Users browse markets, view details, and check resolved outcomes.

#### GET /markets

Returns all open markets with current AMM prices.

**Processing:** Calls `GET /internal/state` on the node, filters markets with `status: "open"`, enriches with pool pricing.

**Response `200`:**

```json
{
  "markets": [
    {
      "marketId": "uuid",
      "sport": "NFL",
      "homeTeam": "Chiefs",
      "awayTeam": "Eagles",
      "outcomeA": "Chiefs win",
      "outcomeB": "Eagles win",
      "eventStartTime": 1699999200000,
      "status": "open",
      "priceA": 0.62,
      "priceB": 0.38,
      "multiplierA": 1.61,
      "multiplierB": 2.63,
      "totalVolume": 5230.0,
      "poolSharesA": 620.0,
      "poolSharesB": 380.0
    }
  ]
}
```

> **Field naming:** The API response uses `homeTeam` and `awayTeam` fields, matching the blockchain node's on-chain data format. No field renaming is applied (i.e., these are NOT `teamA`/`teamB`).

> **Volume computation:** The `volume` field (shown as `totalVolume` in the response) is computed by the API server by summing the `amount` field of all `PlaceBet` and `SellShares` transactions for the market. It is not stored on-chain. The API server derives it from on-chain trade history on each request.

#### GET /markets/:marketId

Returns a single market with full pool details and the authenticated user's position (if any).

**Processing:**

1. Calls `GET /internal/market/:id` on the node.
2. Looks up user's share positions from the node state.
3. Calculates estimated position values using current prices.

**Response `200`:**

```json
{
  "market": {
    /* MarketWithOdds */
  },
  "pool": {
    "sharesA": 620.0,
    "sharesB": 380.0,
    "k": 235600.0
  },
  "userPosition": {
    "sharesA": 25.0,
    "sharesB": 0.0,
    "estimatedValueA": 15.5,
    "estimatedValueB": 0.0
  }
}
```

If the user holds no position, `userPosition` is `null`.

#### GET /markets/:marketId/trades

Returns recent trades on a market. Trades show user display names (not anonymous).

**Input:** Query params `limit` (default 20, max 100), `offset` (default 0).

**Processing:**

1. Fetch transactions for the market from node state (filter `PlaceBet` and `SellShares` by `marketId`).
2. Join with the `User` table in SQLite to resolve wallet addresses to display names.
3. Sort by timestamp descending, apply pagination.

**Response `200`:**

```json
{
  "trades": [
    {
      "transactionId": "uuid",
      "type": "PlaceBet",
      "userName": "Kevin",
      "outcome": "A",
      "amount": 500.0,
      "sharesTraded": 42.15,
      "timestamp": 1700000000000
    }
  ],
  "total": 87
}
```

> **Trade visibility:** Recent trades on markets display user names publicly. Trades are not anonymous — all participants in the friend group can see who bet on what.

#### GET /markets/resolved

Returns resolved and cancelled markets, paginated.

**Input:** Query params `limit` (default 20, max 100), `offset` (default 0).

**Response `200`:**

```json
{
  "markets": [
    {
      "marketId": "uuid",
      "sport": "NFL",
      "homeTeam": "Chiefs",
      "awayTeam": "Eagles",
      "outcomeA": "Chiefs win",
      "outcomeB": "Eagles win",
      "status": "resolved",
      "winningOutcome": "A",
      "finalScore": "Chiefs 27, Eagles 24",
      "resolvedAt": 1700010000000,
      "totalVolume": 15200.0
    }
  ],
  "total": 42
}
```

**Acceptance Criteria:**

- [ ] Given open markets exist, when `GET /markets` is called, then all open markets are returned with correct prices that sum to 1.00.
- [ ] Given a valid market ID, when `GET /markets/:marketId` is called by an authenticated user who holds shares, then `userPosition` is populated with accurate share counts and estimated values.
- [ ] Given an invalid market ID, when `GET /markets/:marketId` is called, then return `MARKET_NOT_FOUND` (404).

---

### FR-7: Trading Endpoints

**Description:** Users buy and sell outcome shares, with preview support.

#### POST /markets/:marketId/buy/preview

Calculates the result of a hypothetical trade without executing it.

**Request:**

```json
{
  "outcome": "A",
  "amount": 500.0
}
```

**Processing:**

1. Validate market exists, is open, and betting window has not closed.
2. Validate `amount > 0` and has at most 2 decimal places.
3. Read the current pool state from the node.
4. Run the AMM buy calculation (constant product) in read-only mode.
5. Return projected results.

**Response `200`:**

```json
{
  "sharesReceived": 42.15,
  "effectivePrice": 0.59,
  "priceImpact": 0.03,
  "fee": 5.0,
  "newPriceA": 0.65,
  "newPriceB": 0.35
}
```

| Field            | Description                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `sharesReceived` | Number of outcome shares the user would receive                    |
| `effectivePrice` | Average price per share for this trade (`amount / sharesReceived`) |
| `priceImpact`    | Absolute change in the outcome's price caused by this trade        |
| `fee`            | 1% fee amount in WPM                                               |
| `newPriceA`      | Pool price of outcome A after the trade                            |
| `newPriceB`      | Pool price of outcome B after the trade                            |

#### POST /markets/:marketId/buy

Executes a share purchase.

**Request:**

```json
{
  "outcome": "A",
  "amount": 500.0
}
```

**Processing:**

1. Validate market exists, is open, betting window not closed.
2. Validate `amount > 0`, at most 2 decimal places.
3. Validate user balance >= amount (check node).
4. Construct a `PlaceBet` transaction: `{ type: "PlaceBet", marketId, outcome, amount, sender: userWallet }`.
5. Sign the transaction with the user's custodial private key.
6. Submit to `POST /internal/transaction` on the node.
7. If the node rejects the transaction, return the appropriate error.
8. On success, return the transaction receipt and trade results.

**Response `201`:**

```json
{
  "transactionId": "uuid",
  "sharesReceived": 42.15,
  "effectivePrice": 0.59,
  "newPriceA": 0.65,
  "newPriceB": 0.35,
  "fee": 5.0
}
```

#### POST /markets/:marketId/sell/preview

Same pattern as buy preview but for selling shares.

**Request:**

```json
{
  "outcome": "A",
  "shareAmount": 20.0
}
```

**Response `200`:**

```json
{
  "wpmReceived": 11.8,
  "effectivePrice": 0.59,
  "priceImpact": 0.02,
  "fee": 0.12,
  "newPriceA": 0.57,
  "newPriceB": 0.43
}
```

#### POST /markets/:marketId/sell

Executes a share sale.

**Request:**

```json
{
  "outcome": "A",
  "shareAmount": 20.0
}
```

**Processing:**

1. Validate market exists, is open, betting window not closed.
2. Validate `shareAmount > 0`, at most 2 decimal places.
3. Validate user holds >= `shareAmount` shares of the specified outcome (check node).
4. Construct a `SellShares` transaction.
5. Sign with custodial key, submit to node.

**Response `201`:**

```json
{
  "transactionId": "uuid",
  "wpmReceived": 11.8,
  "effectivePrice": 0.59,
  "newPriceA": 0.57,
  "newPriceB": 0.43,
  "fee": 0.12
}
```

**Acceptance Criteria:**

- [ ] Given a valid buy request, when the trade executes, then `sharesReceived` is consistent with the AMM constant product formula.
- [ ] Given a buy preview followed by an immediate buy with the same parameters and no intervening trades, then the preview and actual results match exactly.
- [ ] Given `amount` with 3+ decimal places, when buy is called, then return `INVALID_AMOUNT` (400).
- [ ] Given a market whose `eventStartTime` has passed, when buy or sell is called, then return `MARKET_CLOSED` (400).
- [ ] Given insufficient balance, when buy is called, then return `INSUFFICIENT_BALANCE` (400).
- [ ] Given insufficient shares, when sell is called, then return `INSUFFICIENT_SHARES` (400).
- [ ] Given a market that is resolved or cancelled, when buy or sell is called, then return `MARKET_ALREADY_RESOLVED` (400).

---

### FR-8: Transfer Endpoint

**Description:** Users send WPM to another user's wallet.

```
POST /wallet/transfer
```

**Request:**

```json
{
  "recipient": "base64-public-key",
  "amount": 250.0
}
```

**Processing:**

1. Validate `amount > 0`, at most 2 decimal places.
2. Validate `recipient` is a known wallet address (exists on-chain).
3. Validate sender !== recipient.
4. Validate sender balance >= amount.
5. Construct a `Transfer` transaction, sign with custodial key, submit to node.

**Response `201`:**

```json
{
  "transactionId": "uuid",
  "sender": "base64-key",
  "recipient": "base64-key",
  "amount": 250.0
}
```

**Acceptance Criteria:**

- [ ] Given valid sender, recipient, and sufficient balance, when transfer is called, then a `Transfer` transaction is submitted and confirmed.
- [ ] Given sender === recipient, when transfer is called, then return `INVALID_TRANSFER` (400).
- [ ] Given an unknown recipient address, when transfer is called, then return `RECIPIENT_NOT_FOUND` (404).

---

### FR-9: User Profile and Positions

**Description:** Users view their profile, active positions, and betting history.

#### GET /user/profile

**Response `200`:**

```json
{
  "userId": "uuid",
  "name": "Kevin",
  "email": "kevin@example.com",
  "walletAddress": "base64-key",
  "createdAt": 1699900000000
}
```

#### GET /user/positions

Returns all active share positions across open markets.

**Response `200`:**

```json
{
  "positions": [
    {
      "marketId": "uuid",
      "sport": "NFL",
      "homeTeam": "Chiefs",
      "awayTeam": "Eagles",
      "eventStartTime": 1699999200000,
      "sharesA": 25.0,
      "sharesB": 0.0,
      "currentPriceA": 0.62,
      "currentPriceB": 0.38,
      "estimatedValueA": 15.5,
      "estimatedValueB": 0.0,
      "totalEstimatedValue": 15.5
    }
  ]
}
```

#### GET /user/history

Returns resolved bet outcomes for the authenticated user.

**Response `200`:**

```json
{
  "bets": [
    {
      "marketId": "uuid",
      "sport": "NFL",
      "homeTeam": "Chiefs",
      "awayTeam": "Eagles",
      "outcome": "A",
      "sharesHeld": 25.0,
      "winningOutcome": "A",
      "payout": 25.0,
      "profit": 9.5,
      "resolvedAt": 1700010000000
    }
  ]
}
```

**Acceptance Criteria:**

- [ ] Given a user with open positions, when `GET /user/positions` is called, then all positions across all open markets are returned with current valuations.
- [ ] Given a user with resolved bets, when `GET /user/history` is called, then each entry includes accurate payout and profit calculations.

---

### FR-10: Leaderboard

**Description:** Ranked listings of users by total WPM and weekly profit/loss.

#### GET /leaderboard/alltime

**Processing:**

1. For each user, calculate `totalWpm = balance + sum(estimatedValue of all open positions)`.
2. Sort descending by `totalWpm`.
3. Assign ranks (1-indexed, no ties — secondary sort by `walletAddress` for determinism).

**Response `200`:**

```json
{
  "rankings": [
    {
      "userId": "uuid",
      "name": "Kevin",
      "walletAddress": "base64-key",
      "totalWpm": 112500.0,
      "rank": 1
    }
  ]
}
```

#### GET /leaderboard/weekly

**Processing:**

1. Define the week as Monday 00:00 UTC to Sunday 23:59 UTC.
2. For each user, calculate `weeklyPnl = (current totalWpm) - (totalWpm at week start)`.
3. Week-start snapshot is derived by replaying the chain state up to the Monday boundary block.
4. Sort descending by `weeklyPnl`.

**Response `200`:**

```json
{
  "rankings": [
    {
      "userId": "uuid",
      "name": "Kevin",
      "walletAddress": "base64-key",
      "weeklyPnl": 3200.0,
      "rank": 1
    }
  ],
  "weekStart": 1699833600000,
  "weekEnd": 1700438399000
}
```

**Acceptance Criteria:**

- [ ] Given known balances and positions, when alltime leaderboard is called, then rankings match the expected order and values.
- [ ] Given the leaderboard is called multiple times with no intervening trades, then results are identical (deterministic).

---

### FR-11: SSE Event Stream

**Description:** Real-time push of blockchain events to connected clients.

```
GET /events/stream
Authorization: Bearer <token>
Accept: text/event-stream
```

**Processing:**

1. Validate JWT from `Authorization` header.
2. Enforce max 1 SSE connection per user. If a user opens a second connection, close the first.
3. Connect to the node's internal SSE stream (`SSE /internal/events`).
4. For each event received from the node, transform and forward to the client.
5. Send a `:keepalive` comment every 30 seconds to prevent proxy/client timeouts.

**Event Types:**

| Event Type           | Trigger                                    | Payload                                                               |
| -------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `market:created`     | `CreateMarket` tx processed                | `{ marketId, sport, homeTeam, awayTeam, eventStartTime }`             |
| `price:update`       | `PlaceBet` or `SellShares` tx processed    | `{ marketId, priceA, priceB, multiplierA, multiplierB, totalVolume }` |
| `market:resolved`    | `ResolveMarket` tx processed               | `{ marketId, winningOutcome, finalScore }`                            |
| `market:cancelled`   | `CancelMarket` tx processed                | `{ marketId, reason }`                                                |
| `balance:update`     | Any balance-changing transaction processed | `{ address: string, balance: number }`                                |
| `leaderboard:update` | After trades or settlements                | `{ rankings: LeaderboardEntry[] }`                                    |
| `payout:received`    | `SettlePayout` tx processed                | `{ address: string, marketId: string, amount: number }`               |
| `bet:placed`         | `PlaceBet` tx processed                    | `{ marketId, userId, userName, outcome, amount, sharesReceived }`     |
| `block:new`          | New block produced                         | `{ blockIndex, timestamp, transactionCount }`                         |

> **Note:** All SSE event types are defined in `@wpm/shared` and consumed by both the API server (producer) and web app (consumer).

**Wire Format (SSE):**

```
event: price:update
data: {"marketId":"uuid","priceA":0.62,"priceB":0.38,"multiplierA":1.61,"multiplierB":2.63,"totalVolume":5230.00}
id: block-42-tx-3

```

The `id` field enables `Last-Event-ID` reconnection. On reconnect, the server replays missed events from the referenced block onward.

**Acceptance Criteria:**

- [ ] Given a connected SSE client, when a `PlaceBet` transaction is included in a new block, then a `price:update` event is delivered within 2 seconds.
- [ ] Given a user with an existing SSE connection, when they open a second, then the first connection is closed with a final event `{ type: "disconnected", reason: "new_connection" }`.
- [ ] Given a client disconnect and reconnect with `Last-Event-ID`, then missed events are replayed.
- [ ] Given no events for 30 seconds, then a keepalive comment is sent to keep the connection alive.

---

### FR-12: Admin — Token Distribution

```
POST /admin/distribute
```

**Request:**

```json
{
  "recipient": "base64-public-key",
  "amount": 10000.0,
  "reason": "manual"
}
```

**Processing:**

1. Validate admin auth.
2. Validate `recipient` exists on-chain.
3. Validate `amount > 0`, at most 2 decimal places.
4. Validate `reason` is one of: `"signup_airdrop"`, `"referral_reward"`, `"manual"`.
5. Call `POST /internal/distribute` on the node with `{ recipient, amount, reason }`. The node generates and signs the `Distribute` transaction internally.

**Response `201`:**

```json
{
  "transactionId": "uuid",
  "recipient": "base64-key",
  "amount": 10000.0,
  "reason": "manual"
}
```

**Acceptance Criteria:**

- [ ] Given a valid admin request, when distribute is called, then treasury balance decreases by `amount` and recipient balance increases by `amount`.
- [ ] Given insufficient treasury balance, when distribute is called, then return `INSUFFICIENT_BALANCE` (400).

---

### FR-13: Admin — Invite Code Management

#### POST /admin/invite-codes

**Request:**

```json
{
  "count": 5,
  "maxUses": 1,
  "referrer": "base64-public-key"
}
```

**Processing:**

1. Generate `count` unique invite codes (8-character alphanumeric, uppercase).
2. Store each with `maxUses`, `useCount: 0`, `active: true`, and optional `referrer`.
3. `referrer` is optional — if provided, must be a valid wallet address.

**Response `201`:**

```json
{
  "codes": ["ABC12345", "DEF67890", "GHI11223", "JKL44556", "MNO77889"]
}
```

#### GET /admin/invite-codes

**Response `200`:**

```json
{
  "codes": [
    {
      "code": "ABC12345",
      "createdBy": "admin",
      "referrer": "base64-key",
      "maxUses": 1,
      "useCount": 0,
      "active": true,
      "createdAt": 1699900000000
    }
  ]
}
```

#### DELETE /admin/invite-codes/:code

Deactivates the invite code (sets `active: false`). Does not delete the record.

**Response `200`:**

```json
{
  "success": true
}
```

**Acceptance Criteria:**

- [ ] Given `count: 5`, when invite codes are created, then exactly 5 unique codes are returned and stored.
- [ ] Given a deactivated code, when a user attempts registration with it, then return `INVALID_INVITE_CODE` (400).

---

### FR-14: Admin — Market Operations

#### POST /admin/markets/:marketId/cancel

**Request:**

```json
{
  "reason": "Game postponed due to weather"
}
```

**Processing:** Call `POST /internal/transaction` on the node with the cancel request. The node generates and signs the `CancelMarket` transaction internally.

**Response `201`:**

```json
{
  "transactionId": "uuid",
  "marketId": "uuid",
  "reason": "Game postponed due to weather"
}
```

#### POST /admin/markets/:marketId/resolve

Manual resolution override (bypasses oracle).

**Request:**

```json
{
  "winningOutcome": "A",
  "finalScore": "Chiefs 27, Eagles 24"
}
```

**Processing:** Call `POST /internal/transaction` on the node with the resolve request. The node generates and signs the `ResolveMarket` transaction internally.

**Response `201`:**

```json
{
  "transactionId": "uuid",
  "marketId": "uuid",
  "winningOutcome": "A",
  "finalScore": "Chiefs 27, Eagles 24"
}
```

#### POST /admin/markets/:marketId/seed

Override the seed amount for a market. Only valid before any bets are placed.

**Request:**

```json
{
  "amount": 2000.0
}
```

**Processing:** If the market already has trades beyond the initial seed, reject with `MARKET_HAS_TRADES` (400). Otherwise, cancel the existing market and recreate with the new seed amount.

**Acceptance Criteria:**

- [ ] Given a valid cancel request, when cancel is called, then the market transitions to `cancelled` and settlement engine triggers refunds.
- [ ] Given a market with existing trades, when seed override is attempted, then return `MARKET_HAS_TRADES` (400).

---

### FR-15: Admin — System Monitoring

#### GET /admin/treasury

**Response `200`:**

```json
{
  "balance": 9450000.0,
  "totalDistributed": 500000.0,
  "totalSeeded": 45000.0,
  "totalReclaimed": 5000.0
}
```

**Processing:** Derive all values from on-chain transaction history. `totalDistributed` sums all `Distribute` amounts. `totalSeeded` sums all `CreateMarket` seed amounts. `totalReclaimed` sums all `SettlePayout` transactions with `payoutType: "liquidity_return"` back to treasury.

#### GET /admin/users

**Response `200`:**

```json
{
  "users": [
    {
      "userId": "uuid",
      "name": "Kevin",
      "email": "kevin@example.com",
      "walletAddress": "base64-key",
      "balance": 98500.0,
      "createdAt": 1699900000000
    }
  ]
}
```

#### GET /admin/health

**Response `200`:**

```json
{
  "nodeStatus": "healthy",
  "chainHeight": 142,
  "mempoolSize": 0,
  "oracleLastRun": 1700000000000,
  "uptime": 86400,
  "apiVersion": "1.0.0",
  "connectedSSEClients": 3
}
```

**Processing:** Calls `GET /internal/health` on the node, augments with API-level metrics (uptime, SSE client count, API version).

**Acceptance Criteria:**

- [ ] Given a healthy node, when `/admin/health` is called, then `nodeStatus` is `"healthy"` and `chainHeight` matches the node's actual block count.
- [ ] Given treasury transactions on-chain, when `/admin/treasury` is called, then all aggregate values are consistent with the transaction history.

---

### FR-16: Admin — Oracle Triggers

**Description:** The API server exposes admin endpoints to manually trigger oracle operations. These endpoints forward requests to the oracle's internal HTTP API. The oracle (`wpm-oracle:3001`) is the single source of truth for ESPN data parsing and market creation/resolution logic — the API server does not duplicate any of that logic.

#### POST /admin/oracle/ingest

Triggers the oracle to fetch and ingest the latest sports data (e.g., upcoming games from ESPN).

**Processing:**

1. Validate admin auth (JWT with `role: "admin"`).
2. Forward the request to `POST http://wpm-oracle:3001/trigger/ingest` on the Docker internal network.
3. Return the oracle's response to the admin client.

**Response `200`:**

```json
{
  "success": true,
  "marketsCreated": 3,
  "gamesIngested": 12
}
```

#### POST /admin/oracle/resolve

Triggers the oracle to check for completed games and resolve the corresponding markets.

**Processing:**

1. Validate admin auth (JWT with `role: "admin"`).
2. Forward the request to `POST http://wpm-oracle:3001/trigger/resolve` on the Docker internal network.
3. Return the oracle's response to the admin client.

**Response `200`:**

```json
{
  "success": true,
  "marketsResolved": 2
}
```

**Acceptance Criteria:**

- [ ] Given a valid admin JWT, when `POST /admin/oracle/ingest` is called, then the request is forwarded to the oracle and the oracle's response is returned.
- [ ] Given a valid admin JWT, when `POST /admin/oracle/resolve` is called, then the request is forwarded to the oracle and the oracle's response is returned.
- [ ] Given the oracle is unreachable, when either endpoint is called, then return `NODE_UNAVAILABLE` (503) with a message indicating the oracle is down.

## 4. Non-Functional Requirements

### NFR-1: Performance

| Metric                      | Target                            |
| --------------------------- | --------------------------------- |
| REST endpoint latency (p50) | < 50ms                            |
| REST endpoint latency (p99) | < 500ms                           |
| SSE event delivery latency  | < 2 seconds from block production |
| Trade preview latency       | < 100ms                           |
| Concurrent SSE connections  | At least 50                       |
| Max request body size       | 64 KB                             |

### NFR-2: Reliability

| Attribute         | Target                                                                         |
| ----------------- | ------------------------------------------------------------------------------ |
| Availability      | 99.5% (allows ~3.6 hours downtime/month for a friends-group app)               |
| Startup time      | < 5 seconds (stateless; waits for node health check)                           |
| Graceful shutdown | Drain SSE connections, finish in-flight requests (10s timeout)                 |
| Recovery strategy | Restart container; no persistent state beyond SQLite (which recovers from WAL) |

### NFR-3: Security

| Concern          | Approach                                                                              |
| ---------------- | ------------------------------------------------------------------------------------- |
| Transport        | TLS terminated at Nginx; internal traffic is plain HTTP on Docker network             |
| Authentication   | WebAuthn (passkeys) for users; static API key for admin                               |
| Authorization    | Role-based: `user` and `admin` roles in JWT                                           |
| Custodial keys   | RSA private keys encrypted at rest using AES-256 with `WALLET_ENCRYPTION_KEY` env var |
| Input validation | All inputs validated and sanitized before processing; reject unknown fields           |
| CORS             | Allow only the web app origin (`https://wpm.example.com`)                             |
| Rate limiting    | Per-user, enforced at the API layer (see NFR-4)                                       |
| Audit logging    | All admin actions logged with timestamp, admin identity, and action details           |

### NFR-4: Rate Limiting

| Scope                           | Limit        | Window   | Key               |
| ------------------------------- | ------------ | -------- | ----------------- |
| Authenticated user endpoints    | 60 requests  | 1 minute | `userId` from JWT |
| Admin endpoints                 | 120 requests | 1 minute | IP address        |
| SSE connections                 | 1 concurrent | N/A      | `userId` from JWT |
| Auth endpoints (begin/complete) | 10 requests  | 1 minute | IP address        |

When a rate limit is exceeded, return:

```
HTTP 429 Too Many Requests
Retry-After: <seconds until reset>

{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Try again in 45 seconds."
  }
}
```

## 5. Interface Definitions

### Inbound Interfaces

#### Client HTTP API — REST over HTTPS

- **Source:** Web App (PWA), Admin Portal
- **Protocol:** HTTPS (TLS terminated at Nginx)
- **Format:** JSON request/response bodies
- **Content-Type:** `application/json`
- **Authentication:** Bearer JWT (users) or Bearer API key (admin)

#### Client SSE — Server-Sent Events over HTTPS

- **Source:** Web App (PWA)
- **Protocol:** HTTPS (TLS terminated at Nginx)
- **Format:** `text/event-stream`
- **Authentication:** Bearer JWT in query param (`?token=<jwt>`) since EventSource API does not support custom headers

### Outbound Interfaces

#### Node Internal API — REST over HTTP

- **Destination:** Blockchain Node (`wpm-node:4000`)
- **Protocol:** HTTP (Docker internal network)
- **Endpoints consumed:**

| Node Endpoint                    | API Server Usage                                                             |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `POST /internal/transaction`     | Submit signed user transactions (PlaceBet, SellShares, Transfer)             |
| `POST /internal/distribute`      | Request a Distribute transaction (signup airdrop, manual admin distribution) |
| `POST /internal/referral-reward` | Request a referral reward transaction                                        |
| `GET /internal/state`            | Full state snapshot for leaderboard, history, positions                      |
| `GET /internal/market/:id`       | Single market + pool state                                                   |
| `GET /internal/balance/:addr`    | User balance lookup                                                          |
| `GET /internal/health`           | Health check passthrough                                                     |
| `SSE /internal/events`           | Subscribe to block/transaction events for SSE relay                          |

- **Delivery guarantee:** Best-effort. If the node is unreachable, the API returns `NODE_UNAVAILABLE` (503) to the client.
- **Timeout:** 5-second timeout on all node HTTP calls. SSE connection has no timeout but reconnects automatically on drop.

#### Oracle Internal API — REST over HTTP

- **Destination:** Oracle Server (`wpm-oracle:3001`)
- **Protocol:** HTTP (Docker internal network)
- **Endpoints consumed:**

| Oracle Endpoint         | API Server Usage                                                                |
| ----------------------- | ------------------------------------------------------------------------------- |
| `POST /trigger/ingest`  | Admin-triggered data ingestion (forwarded from `POST /admin/oracle/ingest`)     |
| `POST /trigger/resolve` | Admin-triggered market resolution (forwarded from `POST /admin/oracle/resolve`) |

- **Delivery guarantee:** Best-effort. If the oracle is unreachable, the API returns `NODE_UNAVAILABLE` (503) to the admin client.
- **Timeout:** 30-second timeout (ingestion/resolution may take longer than standard requests).

### Inbound Oracle Interface

#### Oracle HTTP API — `/oracle/*` namespace

- **Source:** Oracle Server (`wpm-oracle:3001`)
- **Protocol:** HTTP (Docker internal network only — not exposed through Nginx)
- **Format:** JSON request/response bodies

| Endpoint              | Method | Description                                                                                                                                                                                                                  |
| --------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/oracle/transaction` | POST   | Receives signed oracle transactions (`CreateMarket`, `ResolveMarket`, `CancelMarket`). The API server validates the oracle signature and forwards the transaction to the node via `POST /internal/transaction`.              |
| `/oracle/markets`     | GET    | Returns market data for oracle deduplication and resolution. Proxies to the node's market query endpoints. Query params: `?status=open` (for the resolve job), `?status=open,resolved,cancelled` (for ingest deduplication). |

> **Network isolation:** These endpoints are accessible only within the Docker internal network. Nginx does not expose the `/oracle/*` namespace to external clients.

## 6. Data Model

### Owned Entities (SQLite)

SQLite is the sole data store for all API-server-owned data: user accounts, WebAuthn credentials, invite codes, and auth challenges. The database file is persisted via a Docker volume and uses WAL mode for concurrent read access. No external database (Postgres, Redis, etc.) is required.

#### User

| Field                  | Type    | Constraints              | Description                       |
| ---------------------- | ------- | ------------------------ | --------------------------------- |
| id                     | TEXT    | PK, UUID v4              | User identifier                   |
| name                   | TEXT    | NOT NULL, 1-50 chars     | Display name                      |
| email                  | TEXT    | UNIQUE, NOT NULL         | Email address (lowercase)         |
| wallet_address         | TEXT    | UNIQUE, NOT NULL         | Base64-encoded RSA public key     |
| wallet_private_key_enc | BLOB    | NOT NULL                 | AES-256 encrypted RSA private key |
| role                   | TEXT    | NOT NULL, DEFAULT 'user' | `"user"` or `"admin"`             |
| created_at             | INTEGER | NOT NULL                 | Unix timestamp (ms)               |

#### WebAuthnCredential

| Field         | Type    | Constraints             | Description                            |
| ------------- | ------- | ----------------------- | -------------------------------------- |
| credential_id | TEXT    | PK                      | Base64url-encoded credential ID        |
| user_id       | TEXT    | FK -> User.id, NOT NULL | Owning user                            |
| public_key    | BLOB    | NOT NULL                | COSE public key                        |
| counter       | INTEGER | NOT NULL, DEFAULT 0     | Signature counter for replay detection |
| created_at    | INTEGER | NOT NULL                | Unix timestamp (ms)                    |

#### InviteCode

| Field      | Type    | Constraints         | Description                    |
| ---------- | ------- | ------------------- | ------------------------------ |
| code       | TEXT    | PK, 8 chars         | The invite code                |
| created_by | TEXT    | NOT NULL            | Admin identifier               |
| referrer   | TEXT    | NULLABLE            | Wallet address of the referrer |
| max_uses   | INTEGER | NOT NULL, DEFAULT 1 | Maximum redemptions allowed    |
| use_count  | INTEGER | NOT NULL, DEFAULT 0 | Current redemption count       |
| active     | INTEGER | NOT NULL, DEFAULT 1 | 1 = active, 0 = deactivated    |
| created_at | INTEGER | NOT NULL            | Unix timestamp (ms)            |

#### AuthChallenge

| Field      | Type    | Constraints | Description                                                  |
| ---------- | ------- | ----------- | ------------------------------------------------------------ |
| id         | TEXT    | PK, UUID v4 | Challenge identifier                                         |
| challenge  | TEXT    | NOT NULL    | Base64url-encoded challenge bytes                            |
| type       | TEXT    | NOT NULL    | `"registration"` or `"login"`                                |
| user_data  | TEXT    | NULLABLE    | JSON blob with registration fields (name, email, inviteCode) |
| expires_at | INTEGER | NOT NULL    | Unix timestamp (ms), 60s from creation                       |
| created_at | INTEGER | NOT NULL    | Unix timestamp (ms)                                          |

### Data Ownership

- **Owns:** User, WebAuthnCredential, InviteCode, AuthChallenge
- **Reads (from node):** Balances, Markets, AMM Pools, Share Positions, Transactions, Blocks

## 7. Error Handling

### Error Response Format

All errors follow a consistent envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description with context."
  }
}
```

### Error Catalog

| Code                           | HTTP Status | Trigger                                                   | Recovery                          |
| ------------------------------ | ----------- | --------------------------------------------------------- | --------------------------------- |
| `UNAUTHORIZED`                 | 401         | Missing, expired, or invalid JWT/credential               | Re-authenticate                   |
| `FORBIDDEN`                    | 403         | User role lacks permission for the endpoint               | Use correct credentials           |
| `MARKET_NOT_FOUND`             | 404         | Market ID does not exist on-chain                         | Verify market ID                  |
| `RECIPIENT_NOT_FOUND`          | 404         | Transfer recipient address unknown                        | Verify address                    |
| `MARKET_CLOSED`                | 400         | Betting window has passed (`eventStartTime` reached)      | No action; market is closed       |
| `MARKET_ALREADY_RESOLVED`      | 400         | Market is resolved or cancelled                           | No action                         |
| `MARKET_HAS_TRADES`            | 400         | Seed override attempted on market with trades             | Cannot override                   |
| `INSUFFICIENT_BALANCE`         | 400         | Not enough WPM for the operation                          | Reduce amount or acquire more WPM |
| `INSUFFICIENT_SHARES`          | 400         | Not enough shares to sell                                 | Reduce share amount               |
| `INVALID_AMOUNT`               | 400         | Amount <= 0, not a number, or > 2 decimal places          | Fix the amount                    |
| `INVALID_OUTCOME`              | 400         | Outcome is not `"A"` or `"B"`                             | Use `"A"` or `"B"`                |
| `INVALID_INVITE_CODE`          | 400         | Code expired, deactivated, fully used, or nonexistent     | Use a valid code                  |
| `DUPLICATE_REGISTRATION`       | 409         | Email already registered                                  | Login instead                     |
| `CHALLENGE_EXPIRED`            | 400         | WebAuthn challenge timed out (>60s)                       | Restart auth flow                 |
| `WEBAUTHN_VERIFICATION_FAILED` | 400         | Attestation or assertion verification failed              | Retry with correct passkey        |
| `INVALID_TRANSFER`             | 400         | Sender === recipient or other transfer validation failure | Fix request                       |
| `RATE_LIMITED`                 | 429         | Too many requests in the window                           | Wait and retry                    |
| `NODE_UNAVAILABLE`             | 503         | Blockchain node is unreachable                            | Retry after delay                 |
| `INTERNAL_ERROR`               | 500         | Unexpected server error                                   | Report to admin                   |

### Node Communication Failures

| Scenario                                 | Detection                     | Response                                                           | Recovery                                                         |
| ---------------------------------------- | ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Node unreachable (connection refused)    | HTTP client timeout (5s)      | `NODE_UNAVAILABLE` (503)                                           | Client retries; API reconnects automatically                     |
| Node returns error on transaction submit | Node responds with error JSON | Forward the node's error code as a 400-series API error            | Client fixes request                                             |
| SSE connection to node drops             | EventSource `error` event     | Automatic reconnect with exponential backoff (1s, 2s, 4s, max 30s) | Transparent to clients; replay missed events via `Last-Event-ID` |
| Node returns inconsistent state          | N/A (trusted internal)        | No validation; node is source of truth                             | N/A                                                              |

### Idempotency

- **Transaction submission:** Each transaction has a UUID `id`. If the same UUID is submitted twice, the node's mempool rejects the duplicate. The API does not perform additional deduplication.
- **Registration:** The email uniqueness constraint prevents duplicate registrations. If the `complete` step fails after wallet creation but before the airdrop transaction, the user record is rolled back (SQLite transaction).
- **Invite code redemption:** The `useCount` increment and user creation happen in the same SQLite transaction, preventing double-use.

## 8. Observability

### Metrics

| Metric                         | Type      | Description                               | Alert Threshold                      |
| ------------------------------ | --------- | ----------------------------------------- | ------------------------------------ |
| `api_request_duration_ms`      | histogram | Latency per endpoint                      | p99 > 1s for 5 min                   |
| `api_request_count`            | counter   | Request count by endpoint and status code | 5xx rate > 5% for 2 min              |
| `api_sse_connections`          | gauge     | Current SSE connection count              | > 100 (unexpected for small group)   |
| `api_node_request_duration_ms` | histogram | Latency of calls to the blockchain node   | p99 > 2s for 5 min                   |
| `api_node_errors`              | counter   | Failed requests to the blockchain node    | > 10 in 1 min                        |
| `api_auth_failures`            | counter   | Failed authentication attempts            | > 20 in 5 min (possible brute force) |
| `api_rate_limit_hits`          | counter   | Rate limit rejections                     | Informational                        |

### Logging

- **Format:** Structured JSON, one line per log entry.
- **Fields:** `timestamp`, `level`, `requestId`, `userId`, `method`, `path`, `statusCode`, `durationMs`, `error` (if applicable).
- **Levels:**
  - `ERROR` — Unhandled exceptions, node communication failures.
  - `WARN` — Rate limit hits, auth failures, invalid input rejections.
  - `INFO` — Successful transactions, user registrations, admin actions.
  - `DEBUG` — Full request/response bodies (disabled in production).
- **Sensitive data:** Never log private keys, JWT tokens, or full WebAuthn credentials. Log credential IDs and wallet addresses only.

### Health Check

```
GET /health
```

Unauthenticated. Used by Docker and Nginx for liveness probing.

**Response `200`:**

```json
{
  "status": "healthy",
  "uptime": 86400,
  "nodeReachable": true
}
```

**Response `503`** (if node is unreachable):

```json
{
  "status": "degraded",
  "uptime": 86400,
  "nodeReachable": false
}
```

## 9. Validation and Acceptance Criteria

### Critical Path Tests

These scenarios must pass for the API server to be considered functional:

1. **Full registration flow:** Begin registration with valid invite code, complete with WebAuthn attestation, receive JWT, verify airdrop transaction appears on-chain.
2. **Login and session:** Login with passkey, receive JWT, use JWT to call authenticated endpoints.
3. **Buy shares:** Authenticated user buys outcome shares on an open market, receives correct share count, price updates reflect the trade.
4. **Sell shares:** Authenticated user sells shares, receives correct WPM amount, price updates reflect the sale.
5. **Trade preview accuracy:** Preview result matches actual trade result when no intervening trades occur.
6. **SSE delivery:** Connected client receives `price:update` event within 2 seconds of a trade being included in a block.
7. **Admin distribute:** Admin distributes tokens, treasury balance decreases, recipient balance increases.
8. **Rate limiting:** Exceeding the rate limit returns 429 with `Retry-After` header.
9. **Node down:** When the node is unreachable, all state-dependent endpoints return `NODE_UNAVAILABLE` (503); the health endpoint returns `"degraded"`.

### Integration Checkpoints

- [ ] API server starts and passes health check within 5 seconds.
- [ ] API server connects to the node's internal SSE stream on startup.
- [ ] Nginx successfully proxies requests to the API server.
- [ ] WebAuthn registration works end-to-end from the web app.
- [ ] A trade submitted via the API appears in the next block on the node.
- [ ] SSE events are received by the web app through Nginx (proxy buffering disabled).
- [ ] Admin endpoints are inaccessible with a standard user JWT.

### Rollout Strategy

1. Deploy the API server container via `docker compose up -d wpm-api`.
2. Verify health check: `curl http://localhost:3000/health`.
3. Verify Nginx routing: `curl https://wpm.example.com/api/health`.
4. Run the registration smoke test with a test invite code.
5. Monitor logs for errors during the first 30 minutes.

## 10. Open Questions

| #   | Question                                                                                                                                              | Impact                                                                                                            | Owner   | Resolution                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~Should the API server cache node state (balances, markets) with a short TTL, or always query the node live?~~                                       | Latency vs. staleness tradeoff. Caching improves p50 but may show stale prices.                                   | Backend | **Resolved:** Query the node live for MVP. User count is small enough that caching is unnecessary. Revisit if latency becomes an issue. |
| 2   | ~~Should WebAuthn allow multiple passkeys per user (e.g., phone + laptop)?~~                                                                          | **Resolved:** Single passkey per user for MVP. Multi-device passkey management is deferred to a future iteration. | Product | Single passkey per user.                                                                                                                |
| 3   | ~~Should the weekly leaderboard snapshot be precomputed and cached, or calculated on the fly?~~                                                       | Performance at scale (though user count is small).                                                                | Backend | **Resolved:** Calculate on the fly for MVP. User count is small (tens of users). Precomputed snapshots can be added later if needed.    |
| 4   | What is the admin API key rotation strategy?                                                                                                          | Security hygiene for long-lived secrets.                                                                          | Ops     | Still open. For MVP, manual rotation via environment variable update and container restart.                                             |
| 5   | ~~Should the SSE stream require auth via query param token, or should we use a ticket-based approach (short-lived ticket exchanged for SSE access)?~~ | Security — query param tokens may appear in logs.                                                                 | Backend | **Resolved:** Use query param token for MVP (simpler). Nginx should be configured to not log query parameters on the SSE endpoint.      |

## Appendix

### Glossary

| Term                        | Definition                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| **AMM**                     | Automated Market Maker — algorithmic pricing mechanism using the constant product formula     |
| **Custodial wallet**        | Wallet whose private key is stored and managed by the server, not the end user                |
| **Passkey**                 | WebAuthn credential stored on the user's device (phone, laptop); used to prove identity       |
| **PoA**                     | Proof of Authority — single trusted signer produces all blocks                                |
| **SSE**                     | Server-Sent Events — unidirectional push from server to client over HTTP                      |
| **Treasury**                | System wallet holding undistributed WPM supply                                                |
| **Slippage / Price impact** | The difference between the expected price and the actual price of a trade due to AMM dynamics |

### References

- [ARCHITECTURE.md](/ARCHITECTURE.md) — System-level architecture document
- [Blockchain Node Spec](/specs/blockchain-node.md) — Node internal API and transaction types
- [Settlement Engine Spec](/specs/settlement-engine.md) — Payout and refund logic
