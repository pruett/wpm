# Building a Self-Hosted Cryptocurrency for a Small Community

A first-principles guide to creating a private token, securing it, enabling peer-to-peer exchange, and powering oracle-based betting among friends.

---

## Table of Contents

1. [Core Infrastructure](#1-core-infrastructure)
2. [The Full User Journey](#2-the-full-user-journey)
3. [Authentication, Security & Supply Integrity](#3-authentication-security--supply-integrity)
4. [Oracle-Based Betting & Real-World Events](#4-oracle-based-betting--real-world-events)

---

## 1. Core Infrastructure

### 1.1 The Ledger (Blockchain)

At its most fundamental level, a cryptocurrency is a **shared ledger** — a list of records that everyone agrees is true. Instead of trusting a bank to maintain the list, every participant holds a copy and follows the same rules to decide what gets added.

**Block**: A container that holds a batch of transactions plus metadata:
- **Index** — the block's position in the chain (0, 1, 2, …)
- **Timestamp** — when the block was created
- **Transactions** — the list of value transfers included in this block
- **Previous Hash** — the cryptographic fingerprint of the block that came before it
- **Nonce** — a number used during mining (see below)
- **Hash** — a cryptographic fingerprint of *this* block's contents

Each block references the hash of its predecessor. This creates a chain: altering any historical block changes its hash, which breaks the link to the next block, which breaks the link after that, and so on. Tampering is therefore immediately detectable.

**Genesis Block**: The very first block in the chain. It has no predecessor, so its `previousHash` is typically set to a zeroed-out string. It often contains the initial token distribution (e.g., minting the total supply into a treasury wallet).

### 1.2 Transactions

A transaction is the atomic unit of value movement. It contains:

| Field | Purpose |
|---|---|
| `from` | The sender's public key (or address derived from it) |
| `to` | The recipient's public key / address |
| `amount` | How many tokens are being transferred |
| `timestamp` | When the transaction was created |
| `signature` | A digital signature proving the sender authorized this transfer |

Transactions are created by users, signed with their private keys, broadcast to the network, collected into blocks, and permanently recorded once a block is mined and accepted.

### 1.3 Cryptographic Hashing

A hash function (e.g., SHA-256) takes input of any size and produces a fixed-length output (256 bits). Key properties:

- **Deterministic** — same input always yields same output
- **Avalanche effect** — a tiny change in input completely changes the output
- **One-way** — you cannot reverse-engineer the input from the output
- **Collision-resistant** — it is computationally infeasible to find two inputs that produce the same output

Hashing is used to fingerprint blocks (linking them together), to derive wallet addresses from public keys, and to power the mining process.

### 1.4 Public-Key Cryptography (Asymmetric Keys)

Every user generates a **key pair**:

- **Private key** — a secret number known only to the owner. Used to *sign* transactions.
- **Public key** — derived from the private key, shared openly. Used by others to *verify* signatures.

The mathematical relationship between the two keys means:
1. A message signed with the private key can be verified by anyone with the public key.
2. The private key cannot be derived from the public key.

Common algorithms: RSA (larger keys, simpler mental model), Ed25519/ECDSA (smaller keys, faster, used by Bitcoin and Solana).

### 1.5 Mining / Consensus

Since there is no central authority, participants need a rule to agree on which blocks are valid. This is the **consensus mechanism**.

**Proof of Work (PoW)**: The miner must find a `nonce` such that when the block's contents are hashed, the resulting hash starts with a certain number of leading zeros (the "difficulty"). This requires brute-force trial and error — computationally expensive to find, trivially cheap to verify.

For a small friend group, PoW difficulty can be kept very low (a few leading zeros) so that blocks are mined in seconds rather than minutes.

**Alternative — Proof of Authority (PoA)**: Simpler for a trusted group. A designated set of nodes take turns producing blocks. No computational puzzle needed. Trust is placed in the identity of the block producers rather than in computational work.

**Longest Chain Rule**: When two valid chains diverge (e.g., two miners find a block at roughly the same time), nodes adopt the longest (most-work) chain. The shorter fork is discarded.

### 1.6 Peer-to-Peer Networking

Nodes communicate directly with each other — no central server routing messages. Each node:

1. **Maintains a list of peers** (other nodes it knows about)
2. **Broadcasts new transactions** so they reach all nodes
3. **Broadcasts newly mined blocks** so all nodes can update their chains
4. **Requests the full chain** from peers when joining or falling behind

Protocol options:
- **WebSockets** — persistent, bidirectional connections; good for real-time propagation
- **HTTP polling** — simpler but higher latency; each node periodically asks peers for updates
- **libp2p** — a full peer-to-peer networking stack (used by IPFS, Filecoin); more complex but battle-tested

For a small group, WebSocket connections between a handful of known nodes is the simplest and most effective approach.

### 1.7 Wallets

A wallet is not a container that "holds" tokens. It is a key pair plus software that:

1. Generates and stores the private/public key pair
2. Derives a human-friendly address from the public key
3. Queries the blockchain to compute the user's balance (sum of all incoming transactions minus all outgoing transactions)
4. Constructs, signs, and broadcasts transactions

Wallet implementations can range from a CLI tool to a mobile app to a browser extension.

### 1.8 REST API / Interface Layer

An HTTP server sitting alongside each node that exposes the blockchain's functionality to external applications (web dashboards, mobile apps, bots):

| Endpoint | Purpose |
|---|---|
| `GET /chain` | Return the full blockchain |
| `GET /balance/:address` | Return a wallet's balance |
| `POST /transaction` | Submit a new signed transaction |
| `GET /peers` | List connected peers |
| `POST /peers` | Register a new peer |
| `GET /mine` | Trigger mining of the next block |

---

## 2. The Full User Journey

### 2.1 Onboarding — Getting a Wallet

1. A new friend installs the wallet software (CLI, desktop app, or web app).
2. The software generates a fresh key pair locally on their device. The private key never leaves their machine.
3. The public key is hashed and encoded to produce a wallet **address** — a shorter, shareable identifier (e.g., `wpm_7f3a...b2c1`).
4. The user backs up their private key (or a mnemonic seed phrase that can regenerate it). If they lose this, they lose access to their tokens permanently — there is no "forgot password" flow in a decentralized system.

### 2.2 Acquiring Tokens — Initial Distribution

Since this is a private token among friends, you control the supply. Several approaches:

**Option A — Pre-mined Treasury**
The genesis block mints the entire token supply (e.g., 1,000,000 WPM) into a single treasury wallet controlled by the group's admin. The admin then sends an initial allocation to each friend (e.g., 10,000 WPM each).

**Option B — Mining Rewards**
Each mined block awards the miner a fixed number of newly created tokens (a "block reward"). Friends earn tokens by running a mining node. This distributes tokens organically over time.

**Option C — Faucet**
A simple web service that sends a small amount of tokens to any address that requests them — useful for testing or onboarding new members. Rate-limited to prevent abuse (e.g., one claim per address per day).

**Option D — Hybrid**
Pre-mine a portion for the treasury, allocate a portion as mining rewards, and run a faucet for newcomers.

### 2.3 Sending Tokens

1. Alice opens her wallet and enters Bob's address and the amount (e.g., 50 WPM).
2. The wallet software constructs a transaction object: `{ from: Alice's address, to: Bob's address, amount: 50, timestamp: now }`.
3. The wallet signs this transaction with Alice's private key, producing a digital signature that is appended to the transaction.
4. The signed transaction is broadcast to the network via the node's API (`POST /transaction`).
5. Every node that receives the transaction validates it:
   - Is the signature valid for Alice's public key? (Proves Alice authorized it)
   - Does Alice have >= 50 WPM in her balance? (Prevents overspending)
   - Has this exact transaction been seen before? (Prevents replay attacks)
6. Valid transactions enter the **mempool** (a waiting area of unconfirmed transactions).
7. When a miner produces the next block, they pull transactions from the mempool, include them in the block, and broadcast the block.
8. Once the block is accepted by the network, the transaction is **confirmed**. Bob's balance increases by 50 WPM; Alice's decreases by 50 WPM.

### 2.4 Receiving Tokens

Receiving is passive. Bob simply shares his address with Alice. Once Alice's transaction is mined into a block, Bob's wallet (which queries the chain) will reflect the new balance. No action is required from Bob beyond having a wallet address.

### 2.5 Viewing History & Balances

Balances are not stored as a single number anywhere. They are **computed** by scanning the entire chain:

```
balance(address) = sum(all transactions where `to` == address)
                 - sum(all transactions where `from` == address)
```

For performance, nodes often maintain a **UTXO set** (Unspent Transaction Output) or an **account balance map** that is updated incrementally as new blocks arrive, avoiding a full chain scan on every query.

---

## 3. Authentication, Security & Supply Integrity

### 3.1 User Authentication — There Are No Passwords

In a decentralized system, identity equals key ownership. You do not "log in." You prove you are you by signing a message with your private key.

- **To send tokens**: Sign the transaction. The network verifies the signature against your public key.
- **To prove identity** (e.g., to a dashboard): Sign a challenge message. The server verifies it against the claimed public key.

If someone steals your private key, they become you. There is no customer support to call. This is why key management (encrypted storage, hardware wallets, mnemonic backups) is critical — even among friends.

### 3.2 Preventing Faulty Transactions

Multiple layers of validation prevent bad transactions from entering the chain:

**Layer 1 — Signature Verification**
Every node independently verifies the cryptographic signature on each transaction. A transaction without a valid signature is rejected immediately. This prevents:
- Forged transactions (someone claiming to be Alice)
- Tampered transactions (someone changing the amount after Alice signed)

**Layer 2 — Balance Checking**
Before accepting a transaction into the mempool, nodes check that the sender's balance is sufficient. This prevents:
- Overspending (sending more tokens than you own)

**Layer 3 — Double-Spend Prevention**
Two mechanisms work together:
1. **Mempool deduplication** — if a node has already seen a transaction (same hash), it ignores duplicates.
2. **Block validation** — when a block is mined, the sequence of transactions within it is validated in order. If Alice has 100 WPM and two transactions each spend 80 WPM, only the first one passes validation; the second is rejected for insufficient funds.

**Layer 4 — Chain Integrity**
When a node receives a new block, it verifies:
- The block's hash matches its contents
- The `previousHash` matches the last block in the chain
- The proof-of-work (nonce) satisfies the difficulty requirement
- Every transaction in the block is individually valid

If any check fails, the block is rejected.

### 3.3 Securing the Token Supply

**Fixed Supply**: Define a maximum supply in the protocol rules (e.g., 1,000,000 WPM). Block rewards decrease over time (halving) or are set to zero after the supply cap is reached. Every node enforces this rule — a block that mints tokens beyond the cap is rejected by the network.

**No Unauthorized Minting**: Only two mechanisms can create tokens:
1. The genesis block (initial distribution)
2. Block rewards (if using mining)

Both are hardcoded into the protocol. There is no "mint" function that an admin can call arbitrarily — unless you deliberately design one, in which case it should be protected by multi-signature authorization (requiring M-of-N friends to co-sign).

**Auditability**: Because the chain is a complete, ordered history of every transaction since the beginning, anyone can independently verify the total supply at any time by summing all minting events and confirming no unauthorized creation occurred.

### 3.4 Network-Level Security

- **Peer whitelisting** — since this is a friend group, you can restrict which IP addresses / node IDs are allowed to connect
- **TLS encryption** — encrypt all peer-to-peer traffic to prevent eavesdropping
- **Rate limiting** — prevent any single node from flooding the network with transactions or blocks
- **Sybil resistance** — in a small trusted group, PoA (Proof of Authority) naturally prevents sybil attacks since only known identities can produce blocks

---

## 4. Oracle-Based Betting & Real-World Events

This is where things get interesting. You want token holders to be able to bet on real-world outcomes (sports games, elections, weather, personal challenges) and have the system automatically settle bets.

### 4.1 What is an Oracle?

A blockchain, by design, has no knowledge of the outside world. It can only process data that exists on-chain. An **oracle** is a service that brings external, real-world data *onto* the chain so that smart logic can act on it.

Examples:
- "Did the Lakers win last night?" → Oracle reports: Yes
- "What was the temperature in Austin at noon?" → Oracle reports: 97°F
- "Did Kevin run 5 miles today?" → Oracle reports: Yes (verified via Strava API)

The oracle is the bridge between the real world and the deterministic, isolated world of the blockchain.

### 4.2 The Betting Lifecycle

#### Step 1: Market Creation

Someone (the "market maker," which could be any friend or an automated system) creates a **bet market**:

```
{
  id: "bet_001",
  description: "Will the Cowboys beat the Eagles on Sunday?",
  options: ["Cowboys win", "Eagles win"],
  deadline: "2026-03-01T13:00:00Z",     // no more bets after kickoff
  resolution_deadline: "2026-03-02T06:00:00Z",  // oracle must report by this time
  oracle_source: "espn_nfl_scores",
  status: "open"
}
```

This market is recorded on-chain as a special transaction type (or stored in a sidecar database with a hash anchored on-chain for integrity).

#### Step 2: Placing Bets

Alice wants to bet 100 WPM on "Cowboys win." She creates a **bet transaction**:

```
{
  type: "bet",
  from: Alice's address,
  market_id: "bet_001",
  outcome: "Cowboys win",
  amount: 100,
  timestamp: now,
  signature: <Alice's signature>
}
```

When this transaction is processed:
1. 100 WPM is deducted from Alice's available balance
2. 100 WPM is locked in an **escrow address** tied to this market
3. Alice's bet is recorded

Bob bets 150 WPM on "Eagles win." Same process.

The escrow address is a special address whose funds can only be released by the settlement logic — no individual controls it. In a simple implementation, this can be a designated system address whose "spending" is governed by protocol rules rather than a private key.

#### Step 3: Deadline Enforcement

After the deadline passes, no more bet transactions are accepted for this market. Nodes enforce this by checking the timestamp of incoming bets against the market's deadline.

#### Step 4: Oracle Resolution

After the real-world event concludes, the oracle reports the outcome. This is the most critical and trust-sensitive part of the entire system.

#### Step 5: Settlement

Once the oracle's report is on-chain, the settlement logic executes:

1. Read the winning outcome from the oracle report
2. Calculate each winner's share of the total pot (proportional to their bet size)
3. Generate payout transactions from the escrow address to each winner
4. Mark the market as "resolved"

**Payout math** (pari-mutuel style):

```
Total pot:          250 WPM (Alice's 100 + Bob's 150)
Winning side:       "Cowboys win" (total wagered: 100 WPM by Alice)
Losing side:        "Eagles win" (total wagered: 150 WPM by Bob)

Alice's payout:     (100 / 100) * 250 = 250 WPM
Alice's profit:     250 - 100 = 150 WPM
Bob's loss:         150 WPM (his stake goes to the winners)
```

If multiple people bet on the winning side, the pot is split proportionally:

```
Total pot:          500 WPM
Winners (Cowboys):  Alice bet 100, Charlie bet 100 → total 200
Losers (Eagles):    Bob bet 200, Dave bet 100 → total 300

Alice's payout:     (100 / 200) * 500 = 250 WPM  → profit: 150
Charlie's payout:   (100 / 200) * 500 = 250 WPM  → profit: 150
```

Optionally, a small percentage (e.g., 2%) can be taken as a "house fee" and sent to the treasury to fund ongoing development or community activities.

### 4.3 Building the Oracle Server

The oracle is a separate server (or set of servers) responsible for fetching real-world data and submitting it to the blockchain. Here is how to build one:

#### Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌────────────┐
│  External     │────▶│   Oracle Server   │────▶│ Blockchain │
│  Data Sources │     │                  │     │   Node     │
│  (APIs)       │     │  1. Fetch data   │     │            │
│               │     │  2. Validate     │     │            │
│  - ESPN API   │     │  3. Sign report  │     │            │
│  - Weather API│     │  4. Submit tx    │     │            │
│  - Strava API │     │                  │     │            │
└──────────────┘     └──────────────────┘     └────────────┘
```

#### Oracle Server Components

**1. Data Fetchers (Adapters)**

Each data source gets its own adapter — a module that knows how to query a specific API and extract the relevant result.

```
ESPN Adapter:
  - Input: game_id
  - Action: GET https://api.espn.com/v1/scores/{game_id}
  - Output: { winner: "Cowboys", score: "27-24", final: true }

Weather Adapter:
  - Input: location, date, metric
  - Action: GET https://api.weather.gov/points/{lat},{lon}
  - Output: { temperature_f: 97, recorded_at: "2026-03-01T12:00:00Z" }

Strava Adapter:
  - Input: user_id, date, activity_type
  - Action: GET https://www.strava.com/api/v3/athlete/activities
  - Output: { distance_miles: 5.2, date: "2026-03-01" }
```

**2. Validation Engine**

Raw API responses must be validated before being treated as truth:

- **Status check**: Is the game actually over? Is the data marked as "final"? Don't report a halftime score as the result.
- **Cross-reference**: For high-stakes bets, query multiple independent sources and only report a result if they agree. If ESPN says Cowboys won but another source disagrees, flag it for manual review.
- **Staleness check**: Is the data fresh enough? Reject data older than a threshold.
- **Schema validation**: Does the API response match the expected format? APIs change without warning.

**3. Signing & Submission**

The oracle has its own key pair. When it determines an outcome:

1. Construct an **oracle report**:
   ```
   {
     type: "oracle_report",
     market_id: "bet_001",
     outcome: "Cowboys win",
     data_source: "espn_nfl_scores",
     raw_data_hash: SHA256(raw API response),
     timestamp: now,
     oracle_address: <oracle's public key>,
     signature: <oracle's signature>
   }
   ```
2. Submit this as a transaction to the blockchain node.
3. Nodes validate: Is this signed by a recognized oracle? Is the market awaiting resolution? If yes, record the report and trigger settlement.

**4. Scheduling**

The oracle server runs scheduled jobs:

- Poll for markets approaching their resolution deadline
- For each pending market, fetch the relevant data source
- If the data is available and final, submit the report
- If the data is not yet available, retry on an interval
- If the resolution deadline passes without data, flag for manual intervention

#### Trust Models for the Oracle

This is the hardest problem in oracle design. The oracle is a single point of trust — if it lies, bets are settled incorrectly. Several approaches mitigate this:

**Model A — Trusted Single Oracle (Simplest)**

One friend runs the oracle server. Everyone trusts them. This works fine for a small friend group where social accountability prevents cheating. If the oracle operator has a bet in a market, they should recuse themselves and let someone else verify.

**Model B — Multi-Oracle Consensus**

Multiple friends each run an oracle instance. A result is only accepted if M-of-N oracles agree (e.g., 3 out of 5). This prevents any single person from manipulating outcomes. Implementation:
- Each oracle submits its report independently
- The settlement logic waits until M reports agree on the same outcome
- Disagreeing oracles are flagged for review

**Model C — Optimistic Oracle with Dispute Window**

The oracle submits a result, but it doesn't become final for a dispute period (e.g., 24 hours). During this window, any participant can challenge the result by posting evidence. If challenged:
- A vote among token holders (or a designated panel) determines the true outcome
- The losing side of the dispute pays a penalty
- This creates economic incentives to report honestly and only dispute when genuinely wrong

**Model D — Commit-Reveal Scheme**

For subjective or friend-group-specific bets ("Who can do the most pushups?"), use a commit-reveal scheme:
1. All designated witnesses submit a *hashed* vote (commit phase) — they cannot see each other's votes
2. After all commits are in, witnesses reveal their actual votes
3. The majority vote wins
4. This prevents witnesses from copying each other's answers

### 4.4 Types of Bets

**Binary Bets**: Two outcomes. Cowboys win or Eagles win. Yes or No.

**Categorical Bets**: Multiple outcomes. Who wins the Super Bowl? Options: Team A, Team B, Team C, …

**Over/Under Bets**: Will the total score be over or under 45.5? The oracle reports the actual number; the settlement logic compares it to the threshold.

**Personal Challenge Bets**: "Kevin will run 100 miles this month." Resolved by querying a fitness API (Strava, Apple Health) or by friend-group attestation.

**Deadline Bets**: "Will the project be deployed by Friday?" Resolved by checking a CI/CD system, a GitHub API, or group attestation.

### 4.5 Smart Contract vs. Protocol-Level Bets

There are two ways to implement the betting logic:

**Protocol-Level (Simpler for custom chains)**
The betting rules are baked directly into the node software. The node recognizes special transaction types (`create_market`, `place_bet`, `oracle_report`) and has hardcoded logic for validation and settlement. This is simpler but less flexible — changing the rules requires updating all nodes.

**Smart Contract (More flexible)**
If your chain supports programmable logic (like Ethereum's EVM or Solana's programs), you deploy the betting logic as a smart contract. Anyone can create new types of markets without changing the base protocol. This is more complex to build but far more extensible.

For a friend-group chain, protocol-level is likely sufficient and far simpler to implement and reason about.

### 4.6 Edge Cases & Safeguards

**Event Cancelled**: If a game is postponed or cancelled, the oracle reports "cancelled" and all bets are refunded from escrow.

**Oracle Downtime**: If the oracle fails to report before the resolution deadline, bets are either refunded or the deadline is extended by governance vote.

**Tie / Push**: If the result matches neither option (e.g., a draw in a "who wins?" market), all bets are refunded.

**Insufficient Liquidity**: If only one side of a bet has participants, either refund everyone (no bet without a counterparty) or allow it with reduced payouts.

**Dispute Resolution**: A simple voting mechanism where friends can override an oracle result by majority vote — the social layer as the ultimate backstop.

### 4.7 Full Betting Flow — End to End

```
1.  Dave creates a market: "Lakers vs Celtics, March 5th"
2.  Market is recorded on-chain, status: OPEN
3.  Alice bets 200 WPM on Lakers → 200 WPM moves to escrow
4.  Bob bets 100 WPM on Celtics → 100 WPM moves to escrow
5.  Charlie bets 300 WPM on Lakers → 300 WPM moves to escrow
6.  Escrow balance: 600 WPM total
7.  March 5th, 7:00 PM — deadline passes, status: LOCKED (no more bets)
8.  March 5th, 10:30 PM — game ends, Lakers win 112-108
9.  Oracle server fetches ESPN scores, confirms "final"
10. Oracle submits signed report: outcome = "Lakers"
11. Report recorded on-chain, settlement executes:
      - Lakers bettors: Alice (200) + Charlie (300) = 500 WPM wagered
      - Total pot: 600 WPM
      - Alice's payout: (200/500) * 600 = 240 WPM (profit: 40)
      - Charlie's payout: (300/500) * 600 = 360 WPM (profit: 60)
      - Bob loses his 100 WPM
12. Payouts transferred from escrow to Alice and Charlie
13. Market status: RESOLVED
```

---

## Summary

| Component | What It Does | Key Technology |
|---|---|---|
| **Blockchain / Ledger** | Stores the immutable history of all transactions | Linked list of hashed blocks |
| **Transactions** | Represent value transfers between addresses | Signed data structures |
| **Cryptographic Hashing** | Fingerprints data; links blocks; powers mining | SHA-256 |
| **Public-Key Cryptography** | Proves identity; authorizes transactions | RSA / Ed25519 / ECDSA |
| **Consensus** | Agreement on which blocks are valid | Proof of Work or Proof of Authority |
| **P2P Network** | Propagates transactions and blocks to all nodes | WebSockets / libp2p |
| **Wallets** | Key management, balance queries, transaction creation | Key pair + blockchain query interface |
| **REST API** | Exposes chain data to apps and dashboards | HTTP server on each node |
| **Oracle Server** | Bridges real-world data onto the chain | API adapters + signing + scheduled jobs |
| **Betting Engine** | Market creation, escrow, settlement logic | Protocol-level transaction types |

The beauty of building this for a small group is that you get to learn every layer of the stack — cryptography, networking, consensus, economics — without needing to solve the hardest problems of public blockchains (massive scale, adversarial environments, regulatory compliance). The social trust among friends acts as a safety net while you build the technical trust layer underneath it.
