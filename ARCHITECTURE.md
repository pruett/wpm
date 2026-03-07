# WPM (Wampum) Architecture

A prediction market platform built on a custom blockchain for a small friend group. Sports betting with AMM-driven price discovery.

## Token Economics

- **Symbol:** WPM (Wampum)
- **Total supply:** 10,000,000 WPM (fixed, minted at genesis)
- **Decimals:** 2 (smallest unit: 0.01 WPM)
- **Signup airdrop:** 100,000 WPM per new user
- **Referral reward:** 5,000 WPM to the inviter when their invite code is used
- **Market seed:** 1,000 WPM per market from treasury (admin-overridable)

## Market Model

- **Type:** Automated Market Maker (AMM), constant product (x * y = k)
- **Outcomes:** Binary only (Team A vs Team B)
- **One market per game** (moneyline — who wins)
- **Trading:** Users can buy and sell outcome shares before betting closes
- **Share pricing:** Shares trade between 0.00 and 1.00 WPM; price = implied probability
- **Fee:** 1% per trade, returned to the pool (offsets treasury liquidity risk)
- **Liquidity seeding:** Treasury mints equal shares for both outcomes at market creation
- **Unused markets:** If zero bets placed, treasury reclaims full seed at resolution
- **Display:** UI shows both probability (%) and payout multiplier (x)
- **Betting close:** At game start time (from ESPN data)
- **Settlement edge cases:** Ties, OT rule changes, postponements → market cancelled, full refund of each user's net cost basis, treasury reclaims seed

## Transaction Types

| Type | Submitter | Purpose |
|------|-----------|---------|
| `Transfer` | Any wallet | Send tokens between wallets |
| `Distribute` | Node/system | Admin grants tokens to a user (node signs on behalf of treasury) |
| `CreateMarket` | Oracle | Open a new binary betting market |
| `PlaceBet` | Any wallet | Buy outcome shares from the AMM |
| `SellShares` | Any wallet | Sell outcome shares back to the AMM |
| `ResolveMarket` | Oracle | Submit final result for a market |
| `SettlePayout` | Node/system | Distribute winnings after resolution |
| `CancelMarket` | Oracle or Admin | Cancel a market and refund all bets |
| `Referral` | System | Reward inviter when invited user signs up |

## Services

### Blockchain Node
The core process. Holds the chain in memory, persists it to an append-only JSONL file on disk (`chain.jsonl`), replays on startup to rebuild state. Validates transactions and blocks, produces new blocks via Proof of Authority (single signer, static key on server), and manages the mempool. Blocks are produced on-demand when transactions are pending (no empty blocks). Timestamps are wall-clock based for market deadlines. This is the source of truth for all token balances, transaction history, share ownership, and AMM pool state.

### Settlement Engine
Built into the blockchain node, not a standalone service. When an oracle resolution is accepted on-chain, this logic reads all share positions for the resolved market, computes payouts (winning shares pay 1.00 WPM each, losing shares pay 0.00), generates payout transactions, and returns remaining liquidity to treasury.

### Escrow / AMM Pool
Protocol-level mechanism within the node. Each market has its own AMM pool holding outcome shares. When a user buys shares, their WPM enters the pool; when they sell, WPM exits. The constant product formula ensures the pool is always solvent. Funds are locked in the pool until resolution or cancellation.

### API Server
HTTP interface that exposes the node's functionality to external clients (web app, admin portal) and the oracle server. Deployed on the same server as the blockchain node but runs as a distinct Docker container. Handles balance lookups, transaction submission, market queries, share pricing, user management, and SSE streams for real-time updates. Does not hold any signing keys — all system transactions (distribute, referral) are generated and signed by the node itself via internal endpoints.

### Oracle Server
Separate process responsible for bridging real-world sports data onto the chain. Uses ESPN's API as the sole data source (free, no API key required). Runs two jobs on a fixed, publicly known schedule:

- **Ingest** — Runs once daily at 6:00 AM ET. Fetches upcoming games and creates fully-seeded markets on-chain.
- **Resolve** — Runs every 30 minutes from 12:00 PM to 1:00 AM ET. Checks completed games, fetches final scores, and submits resolution transactions.
- **Adapters** — Per-sport modules that know how to query ESPN and normalize responses. NFL at launch; architecture supports adding NBA, NHL, MLB, golf, tennis via new adapters.

### Web App
User-facing Progressive Web App (PWA). Mobile-first responsive design. Displays:
- Live markets with real-time odds (probability % and payout multiplier)
- User's active bets and share positions
- Leaderboard: all-time total WPM and weekly profit/loss
- Recent activity feed
- Wallet balance and transaction history

Real-time updates via Server-Sent Events (SSE). Authentication via WebAuthn/passkeys. Wallet keys are custodial (stored server-side, passkey proves identity). User onboarding: invite code → name + email → passkey registration → 100,000 WPM airdrop.

### Admin Portal
Full administrative interface for the chain operator. Capabilities:
- Distribute tokens to users
- Override market seed amounts
- Cancel or manually resolve markets
- Generate and manage invite codes
- View system health, chain state, and oracle status
- User management

Authenticated separately from standard user passkey flow.

## Deployment

- **Host:** Hetzner VPS
- **Orchestration:** Docker Compose
- **Containers:** `wpm-node`, `wpm-api`, `wpm-oracle`, `wpm-web`, `nginx`
- **Networking:** Nginx reverse proxy handles TLS termination and routing. Inter-service communication over Docker internal network via HTTP.
- **Persistence:** JSONL chain file stored on a Docker volume
- **CI/CD:** GitHub Actions → build, test, push images to GitHub Container Registry → SSH deploy to VPS (`docker compose pull && up -d`)
