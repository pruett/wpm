# API Server — Component Specification

## Overview

The API server is the HTTP interface between external clients (web app, admin portal) and the blockchain node. It handles authentication, request validation, transaction construction, and real-time event streaming. Runs as a separate Docker container from the node, communicates with the node over the Docker internal network.

## Base URL

```
https://api.wpm.example.com
```

Nginx routes external requests to this service. The API server itself listens on an internal port (e.g. `3000`).

## Authentication

### Passkey / WebAuthn

Used for standard user authentication.

#### Registration Flow

```
POST /auth/register
```

1. Client sends `{ inviteCode, name, email }`
2. Server validates invite code
3. Server generates WebAuthn registration challenge
4. Client creates passkey credential via browser WebAuthn API
5. Client sends credential back to server
6. Server stores credential, creates wallet (key pair generated server-side), links to user
7. Server processes signup:
   - `Distribute` transaction: 100,000 WPM to new user
   - `Referral` transaction: 5,000 WPM to inviter (if invite code has a referrer)
8. Returns `{ userId, walletAddress, token }` (JWT session token)

#### Login Flow

```
POST /auth/login
```

1. Server generates WebAuthn authentication challenge
2. Client signs challenge with passkey
3. Server verifies signature against stored credential
4. Returns `{ userId, walletAddress, token }`

#### Session

- JWT token with 7-day expiry
- Passed in `Authorization: Bearer <token>` header
- Contains: `userId`, `walletAddress`, `role` ("user" | "admin")

### Admin Authentication

Separate auth for admin portal. Can be a static API key or a dedicated admin passkey.

```
Authorization: Bearer <admin-token>
```

## Public Endpoints (Authenticated User)

### Wallet

```
GET /wallet/balance
→ { address: string, balance: number }

GET /wallet/transactions?limit=50&offset=0
→ { transactions: Transaction[], total: number }
```

### Markets

```
GET /markets
→ { markets: MarketWithOdds[] }
// Returns all open markets with current AMM prices

GET /markets/:marketId
→ { market: MarketWithOdds, pool: AMMPool, userPosition: UserPosition | null }

GET /markets/resolved?limit=20&offset=0
→ { markets: ResolvedMarket[] }
```

```typescript
interface MarketWithOdds {
  marketId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  outcomeA: string;
  outcomeB: string;
  eventStartTime: number;
  status: "open" | "resolved" | "cancelled";
  priceA: number; // Current probability (0-1)
  priceB: number; // Current probability (0-1)
  multiplierA: number; // Payout multiplier
  multiplierB: number; // Payout multiplier
  totalVolume: number; // Total WPM traded in this market
  poolSharesA: number;
  poolSharesB: number;
}

interface UserPosition {
  sharesA: number;
  sharesB: number;
  estimatedValueA: number; // sharesA * priceA
  estimatedValueB: number; // sharesB * priceB
}
```

### Trading

```
POST /markets/:marketId/buy
Body: { outcome: "A" | "B", amount: number }
→ { transaction: Transaction, sharesReceived: number, newPrice: number, effectivePrice: number }

POST /markets/:marketId/sell
Body: { outcome: "A" | "B", shareAmount: number }
→ { transaction: Transaction, wpmReceived: number, newPrice: number }
```

Before executing, the API should return a **preview** if requested:

```
POST /markets/:marketId/buy/preview
Body: { outcome: "A" | "B", amount: number }
→ { sharesReceived: number, effectivePrice: number, priceImpact: number, fee: number }
```

This lets the UI show slippage/impact before the user confirms.

### Transfer

```
POST /wallet/transfer
Body: { recipient: string, amount: number }
→ { transaction: Transaction }
```

### Leaderboard

```
GET /leaderboard/alltime
→ { rankings: LeaderboardEntry[] }

GET /leaderboard/weekly
→ { rankings: LeaderboardEntry[], weekStart: number, weekEnd: number }
```

```typescript
interface LeaderboardEntry {
  userId: string;
  name: string;
  walletAddress: string;
  totalWpm: number; // All-time: current balance + value of open positions
  weeklyPnl: number; // Weekly: net gain/loss this week
  rank: number;
}
```

### User

```
GET /user/profile
→ { userId, name, email, walletAddress, createdAt }

GET /user/positions
→ { positions: UserMarketPosition[] }
// All active share positions across open markets

GET /user/history
→ { bets: ResolvedBetResult[] }
// Historical bet outcomes
```

## Admin Endpoints

All require admin authentication.

```
POST /admin/distribute
Body: { recipient: string, amount: number, reason: string }
→ { transaction: Transaction }

POST /admin/invite-codes
Body: { count: number, maxUses: number, referrer?: string }
→ { codes: string[] }

GET /admin/invite-codes
→ { codes: InviteCode[] }

DELETE /admin/invite-codes/:code
→ { success: boolean }

POST /admin/markets/:marketId/cancel
Body: { reason: string }
→ { transaction: Transaction }

POST /admin/markets/:marketId/resolve
Body: { winningOutcome: "A" | "B", finalScore: string }
→ { transaction: Transaction }

POST /admin/markets/:marketId/pause
→ { success: boolean }

POST /admin/markets/:marketId/seed
Body: { amount: number }
→ { transaction: Transaction }

GET /admin/treasury
→ { balance: number, totalDistributed: number, totalSeeded: number, totalReclaimed: number }

GET /admin/users
→ { users: UserProfile[] }

GET /admin/health
→ { nodeStatus, chainHeight, mempoolSize, oracleLastRun, uptime }
```

## Real-Time Events (SSE)

```
GET /events/stream
```

Server-Sent Events stream. Client connects and receives events as they occur:

```typescript
// Event types pushed to clients:
interface SSEEvent {
  type:
    | "market_created"
    | "price_update"
    | "market_resolved"
    | "market_cancelled"
    | "bet_placed"
    | "new_block";
  data: object;
  timestamp: number;
}
```

### Price Updates

Sent whenever a `PlaceBet` or `SellShares` transaction is processed:

```json
{
  "type": "price_update",
  "data": {
    "marketId": "...",
    "priceA": 0.62,
    "priceB": 0.38,
    "multiplierA": 1.61,
    "multiplierB": 2.63,
    "totalVolume": 5230.0
  }
}
```

### Market Created

```json
{
  "type": "market_created",
  "data": {
    "marketId": "...",
    "sport": "NFL",
    "homeTeam": "Chiefs",
    "awayTeam": "Eagles",
    "eventStartTime": 1699999200000
  }
}
```

### Market Resolved

```json
{
  "type": "market_resolved",
  "data": {
    "marketId": "...",
    "winningOutcome": "A",
    "finalScore": "Chiefs 27, Eagles 24"
  }
}
```

## Error Handling

All errors return standard format:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient balance. Required: 500.00, available: 123.45"
  }
}
```

### Error Codes

| Code                      | HTTP Status | Meaning                        |
| ------------------------- | ----------- | ------------------------------ |
| `UNAUTHORIZED`            | 401         | Missing or invalid auth token  |
| `FORBIDDEN`               | 403         | Insufficient permissions       |
| `MARKET_NOT_FOUND`        | 404         | Market ID does not exist       |
| `MARKET_CLOSED`           | 400         | Betting window has closed      |
| `MARKET_ALREADY_RESOLVED` | 400         | Market already resolved        |
| `INSUFFICIENT_BALANCE`    | 400         | Not enough WPM                 |
| `INSUFFICIENT_SHARES`     | 400         | Not enough shares to sell      |
| `INVALID_AMOUNT`          | 400         | Amount <= 0 or invalid         |
| `INVALID_INVITE_CODE`     | 400         | Code expired, used, or invalid |
| `DUPLICATE_REGISTRATION`  | 409         | Email already registered       |
| `INTERNAL_ERROR`          | 500         | Unexpected server error        |

## Rate Limiting

- Public endpoints: 60 requests/minute per user
- Admin endpoints: 120 requests/minute
- SSE connections: 1 per user

## Verification Criteria

1. **All endpoints** validate auth before processing
2. **Trade preview** accurately reflects what the executed trade would produce
3. **SSE stream** delivers price updates within 1 second of block production
4. **Error responses** are consistent and include actionable error codes
5. **Leaderboard** calculations match on-chain state
6. **Invite code flow** correctly triggers airdrop and referral transactions
7. **Admin endpoints** reject non-admin tokens
