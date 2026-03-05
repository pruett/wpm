# WPM Architecture

## Services

### Blockchain Node
The core process. Holds the chain in memory, persists it to an append-only log file on disk, validates transactions and blocks, produces new blocks via Proof of Authority, and manages the mempool of unconfirmed transactions. This is the source of truth for all token balances, transaction history, and on-chain state. Deployed on the same server as the API server but runs as a distinct process.

### API Server
HTTP interface that exposes the node's functionality to external clients (wallets, frontend, oracle). Deployed on the same server as the blockchain node but runs as a distinct process. Handles balance lookups, transaction submission, market creation, bet placement, and chain queries.

### Oracle Server
Separate process responsible for bridging real-world data onto the chain. Runs three sub-services:
- **Ingest** — polls external APIs (ESPN, Odds API, etc.) on a schedule to pull upcoming events and create bet markets on-chain.
- **Resolve** — monitors concluded events, fetches final results, validates them, and submits signed oracle reports to the node.
- **Adapters** — per-source modules that know how to query a specific external API and normalize its response into a standard format.

### Settlement Engine
Built into the blockchain node, not a standalone service. When an oracle report is accepted on-chain, this logic reads all bets for the resolved market, computes pari-mutuel payouts, and generates the escrow-to-winner transactions.

### Escrow System
Protocol-level mechanism within the node. When a user places a bet, their tokens are transferred to a market-specific escrow address and locked until the market resolves. Funds are released only by the settlement engine upon oracle resolution, or refunded if the event is cancelled.

### Web App
The user-facing application. Displays balances, transaction history, open bet markets, active bets, and resolved outcomes. Communicates with the node's API server over HTTP. Identity is key-based — users authenticate by signing a challenge with their private key. Keys are generated and stored in the browser with an export/backup flow so users can recover their wallet if they lose access.

### Admin Portal
Protected interface accessible only to the chain operator. Used for treasury management (distributing tokens to new users), managing oracle authority, and overseeing chain health. Authenticated separately from the standard wallet flow.

## Token Distribution
The genesis block mints the full token supply into a treasury wallet. New users receive tokens from the treasury via the admin portal. No tokens are created after genesis — the supply is fixed.
