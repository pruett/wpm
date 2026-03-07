# Blockchain Node — Component Specification

## Overview

The blockchain node is the core process and single source of truth for the WPM system. It holds the chain in memory, persists it to disk, validates and processes all transactions, produces blocks via Proof of Authority, and maintains AMM pool state for all active markets.

## Block Structure

```typescript
interface Block {
  index: number;                // Sequential block number (0 = genesis)
  timestamp: number;            // Unix timestamp (ms) when block was produced
  transactions: Transaction[];  // Ordered list of transactions in this block
  previousHash: string;         // SHA-256 hash of the previous block
  hash: string;                 // SHA-256 hash of this block
  signature: string;            // PoA signer's RSA signature over the hash
}
```

### Genesis Block

- `index: 0`, no previous hash
- Contains a single `Distribute` transaction minting 10,000,000.00 WPM to the treasury wallet address
- Hard-coded — not produced dynamically

### Block Production

- **Consensus:** Proof of Authority — single static RSA key pair stored on the server
- **Trigger:** On-demand. A new block is produced when one or more transactions are in the mempool.
- **Polling interval:** Node checks the mempool every 1 second. If transactions are pending, it produces a block.
- **Block size limit:** 100 transactions per block. If the mempool has more, remaining transactions carry over to the next block.
- **Ordering:** Transactions within a block are ordered by arrival time in the mempool.

### Block Hash

SHA-256 of the concatenation: `index + timestamp + previousHash + JSON.stringify(transactions)`

### Block Validation

A block is valid if:
1. `index === previousBlock.index + 1`
2. `previousHash === previousBlock.hash`
3. `hash` matches the recomputed hash of the block's contents
4. `signature` is a valid RSA signature of `hash` by the PoA signer's public key
5. All transactions in the block are individually valid (see Transaction Validation)
6. No double-spends within the block (same input not consumed twice)

## Transaction Types

All transactions share a base structure:

```typescript
interface BaseTransaction {
  id: string;              // UUID v4
  type: TransactionType;   // Enum of all types
  timestamp: number;       // Unix timestamp (ms) of creation
  sender: string;          // Public key or system address of the sender
  signature: string;       // RSA signature over the transaction payload (excluding signature field)
}

type TransactionType =
  | "Transfer"
  | "Distribute"
  | "CreateMarket"
  | "PlaceBet"
  | "SellShares"
  | "ResolveMarket"
  | "SettlePayout"
  | "CancelMarket"
  | "Referral";
```

### Transfer

Move tokens between user wallets.

```typescript
interface TransferTransaction extends BaseTransaction {
  type: "Transfer";
  recipient: string;       // Recipient's public key
  amount: number;          // WPM amount (2 decimal precision)
}
```

**Validation:**
- Sender has sufficient balance (`balance >= amount`)
- `amount > 0`
- Sender !== recipient
- Valid signature from sender

### Distribute

Admin distributes tokens from treasury to a user. Distinct from Transfer for auditability.

```typescript
interface DistributeTransaction extends BaseTransaction {
  type: "Distribute";
  recipient: string;
  amount: number;
  reason: string;          // "signup_airdrop" | "referral_reward" | "manual"
}
```

**Validation:**
- Sender must be the treasury wallet address
- Treasury has sufficient balance
- `amount > 0`
- Valid signature from PoA signer (treasury key)

### CreateMarket

Oracle creates a new betting market.

```typescript
interface CreateMarketTransaction extends BaseTransaction {
  type: "CreateMarket";
  marketId: string;             // UUID v4
  sport: string;                // e.g. "NFL", "NBA"
  homeTeam: string;             // Team name
  awayTeam: string;             // Team name
  outcomeA: string;             // Label for outcome A (e.g. "Chiefs win")
  outcomeB: string;             // Label for outcome B (e.g. "Eagles win")
  eventStartTime: number;       // Unix timestamp — betting closes at this time
  seedAmount: number;           // WPM to seed each side of the AMM (default 1000)
  externalEventId: string;      // ESPN event ID for resolution lookup
}
```

**Validation:**
- Sender must be the oracle's public key
- `eventStartTime` is in the future
- `seedAmount > 0`
- Treasury has sufficient balance for `seedAmount` (full seed, both sides)
- `marketId` does not already exist
- Valid signature from oracle

**Side effects:**
- Deducts `seedAmount` from treasury balance
- Creates AMM pool: `sharesA = seedAmount / 2`, `sharesB = seedAmount / 2`, `k = sharesA * sharesB`
- Treasury receives LP position tracking (to reclaim at resolution)

### PlaceBet

User buys outcome shares from the AMM.

```typescript
interface PlaceBetTransaction extends BaseTransaction {
  type: "PlaceBet";
  marketId: string;
  outcome: "A" | "B";          // Which outcome to buy shares of
  amount: number;               // WPM to spend
}
```

**Validation:**
- Market exists and is open (current time < `eventStartTime`)
- Sender has sufficient balance
- `amount > 0`
- Valid signature from sender

**Side effects (constant product AMM):**
1. Apply 1% fee: `fee = amount * 0.01`, `netAmount = amount * 0.99`
2. Fee stays in the pool (added to both sides proportionally)
3. Mint new shares: `newShares = netAmount` (one of each outcome)
4. Add the shares of the OTHER outcome to the pool
5. Give the shares of the CHOSEN outcome to the user
6. Recalculate `k`

*Detailed AMM math in the AMM Pool State section below.*

### SellShares

User sells outcome shares back to the AMM.

```typescript
interface SellSharesTransaction extends BaseTransaction {
  type: "SellShares";
  marketId: string;
  outcome: "A" | "B";
  shareAmount: number;          // Number of shares to sell
}
```

**Validation:**
- Market exists and is open (current time < `eventStartTime`)
- Sender holds >= `shareAmount` shares of the specified outcome
- `shareAmount > 0`
- Valid signature from sender

**Side effects:**
1. Add user's shares back to the pool
2. Calculate WPM to return based on constant product formula
3. Apply 1% fee (deducted from WPM returned)
4. Transfer net WPM to user's balance
5. Recalculate `k`

### ResolveMarket

Oracle submits the final result for a completed event.

```typescript
interface ResolveMarketTransaction extends BaseTransaction {
  type: "ResolveMarket";
  marketId: string;
  winningOutcome: "A" | "B";
  finalScore: string;           // Human-readable, e.g. "Chiefs 27, Eagles 24"
}
```

**Validation:**
- Sender must be the oracle's public key
- Market exists and is not already resolved or cancelled
- `eventStartTime` has passed (game should have started)
- Valid signature from oracle

**Side effects:**
- Sets market status to `resolved`
- Triggers the Settlement Engine (see settlement-engine.md)

### SettlePayout

System-generated transaction distributing winnings after resolution.

```typescript
interface SettlePayoutTransaction extends BaseTransaction {
  type: "SettlePayout";
  marketId: string;
  recipient: string;
  amount: number;
  payoutType: "winnings" | "liquidity_return";
}
```

**Validation:**
- Sender must be the system address
- Market is in `resolved` or `cancelled` status
- Generated by settlement engine only (not user-submittable)

### CancelMarket

Cancel a market and trigger refunds.

```typescript
interface CancelMarketTransaction extends BaseTransaction {
  type: "CancelMarket";
  marketId: string;
  reason: string;               // Human-readable reason
}
```

**Validation:**
- Sender must be oracle or admin (PoA signer)
- Market exists and is not already resolved or cancelled
- Valid signature

**Side effects:**
- Sets market status to `cancelled`
- Triggers settlement engine in refund mode (see settlement-engine.md)

### Referral

System-generated reward when an invited user completes signup.

```typescript
interface ReferralTransaction extends BaseTransaction {
  type: "Referral";
  recipient: string;            // Inviter's public key
  amount: number;               // 5,000 WPM
  referredUser: string;         // New user's public key
  inviteCode: string;           // The code that was used
}
```

**Validation:**
- Sender must be system/treasury
- Treasury has sufficient balance
- Invite code is valid and was used by the referred user

## AMM Pool State

Each market maintains an AMM pool:

```typescript
interface AMMPool {
  marketId: string;
  sharesA: number;              // Outcome A shares in the pool
  sharesB: number;              // Outcome B shares in the pool
  k: number;                    // Invariant: sharesA * sharesB (recalculated after each trade)
}
```

### Price Calculation

The marginal price of each outcome:
```
priceA = sharesB / (sharesA + sharesB)
priceB = sharesA / (sharesA + sharesB)
```

Prices always sum to 1.00. A price of 0.65 means 65% implied probability.

### Payout Multiplier

```
multiplierA = 1 / priceA
multiplierB = 1 / priceB
```

Example: If priceA = 0.40, multiplierA = 2.50x (bet 10 WPM, get 25 WPM if A wins).

### Buy Calculation (PlaceBet)

When a user spends `amount` WPM to buy outcome A shares:

```
fee = amount * 0.01
netAmount = amount - fee

// Mint netAmount new shares of each outcome
newSharesA = sharesA + netAmount
newSharesB = sharesB + netAmount

// User receives outcome A shares; pool keeps outcome B
// Use constant product to determine how many A shares leave the pool
// Pool must maintain: newSharesA_after * newSharesB_after = newSharesA * newSharesB
sharesAToUser = newSharesA - (newSharesA * newSharesB) / newSharesB
// Simplified: sharesAToUser ≈ netAmount * sharesA / sharesB (for small trades)

// Update pool
pool.sharesA = newSharesA - sharesAToUser
pool.sharesB = newSharesB
pool.k = pool.sharesA * pool.sharesB

// Fee is distributed: add fee/2 shares to each side (grows k, benefits LPs)
pool.sharesA += fee / 2
pool.sharesB += fee / 2
pool.k = pool.sharesA * pool.sharesB
```

### Sell Calculation (SellShares)

When a user sells `shareAmount` of outcome A shares back to the pool:

```
// Add shares back to pool
newSharesA = sharesA + shareAmount

// Calculate how many B shares leave the pool to maintain ratio
sharesToRemove = sharesB - (sharesA * sharesB) / newSharesA
wpmToReturn = sharesToRemove

// Apply fee
fee = wpmToReturn * 0.01
netReturn = wpmToReturn - fee

// Update pool
pool.sharesA = newSharesA
pool.sharesB = sharesB - sharesToRemove + fee  // fee stays in pool
pool.k = pool.sharesA * pool.sharesB
```

## In-Memory State

The node maintains the following state, rebuilt from JSONL on startup:

```typescript
interface ChainState {
  chain: Block[];                           // Full block history
  balances: Map<string, number>;            // address → WPM balance
  sharePositions: Map<string, Map<string, { A: number; B: number }>>;
                                            // address → marketId → share counts
  markets: Map<string, Market>;             // marketId → market state
  pools: Map<string, AMMPool>;             // marketId → AMM pool state
  mempool: Transaction[];                   // Pending transactions
  inviteCodes: Map<string, InviteCode>;     // code → invite code state
}

interface Market {
  marketId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  outcomeA: string;
  outcomeB: string;
  eventStartTime: number;
  seedAmount: number;
  externalEventId: string;
  status: "open" | "resolved" | "cancelled";
  winningOutcome?: "A" | "B";
  finalScore?: string;
  createdAt: number;
  resolvedAt?: number;
}

interface InviteCode {
  code: string;
  createdBy: string;            // Admin who created it
  usedBy?: string;              // Public key of user who redeemed it
  referrer?: string;            // Public key of user who gets referral reward
  maxUses: number;
  useCount: number;
  active: boolean;
}
```

## Persistence

### Format

Append-only JSONL file (`chain.jsonl`). Each line is one JSON-serialized block.

### Write

After a new block is produced, it is appended as a single line to `chain.jsonl`.

### Startup Replay

On startup:
1. Read `chain.jsonl` line by line
2. Deserialize each block
3. Validate each block against the previous
4. Replay all transactions to rebuild `ChainState`
5. Node is ready to accept new transactions

### Backup

The JSONL file is the complete system backup. Copy it to restore the full chain.

## Mempool

- Transactions are submitted via the API server
- Node validates the transaction before accepting it into the mempool
- Invalid transactions are rejected immediately with an error
- Mempool is ordered by arrival time (FIFO)
- Duplicate transaction IDs are rejected
- Mempool is not persisted — lost on restart (clients can resubmit)

## Key Management

### PoA Signer Key

- RSA key pair generated once at system initialization
- Stored on disk in the node's data directory
- Used to sign every block
- Also serves as the treasury wallet key

### Oracle Key

- Separate RSA key pair for the oracle process
- Public key registered with the node as an authorized oracle
- Only transactions signed by this key are accepted for `CreateMarket`, `ResolveMarket`

## Network Interface

The node exposes an internal HTTP API consumed by the API server. It does NOT accept external traffic directly.

```
POST /internal/transaction    — Submit a validated transaction to the mempool
GET  /internal/state          — Full chain state snapshot
GET  /internal/block/:index   — Get a specific block
GET  /internal/market/:id     — Get market + pool state
GET  /internal/balance/:addr  — Get balance for an address
GET  /internal/health         — Node health check
SSE  /internal/events         — Stream of new blocks and state changes
```

## Verification Criteria

1. **Genesis block** is produced correctly with 10,000,000 WPM to treasury
2. **Blocks** are produced only when mempool is non-empty
3. **All transaction types** validate correctly and reject invalid inputs
4. **AMM math** is correct — prices sum to 1.00, constant product holds, no negative balances
5. **Betting closes** at `eventStartTime` — transactions after cutoff are rejected
6. **JSONL replay** reconstructs identical state from a fresh read of the log file
7. **Double-spend prevention** — same tokens cannot be spent twice within or across blocks
8. **Share tracking** — user share balances are accurate after buys and sells
