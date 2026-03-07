# Implementation Plan: Blockchain Node

> Source: `specs/blockchain-node.md`
> Generated: 2026-03-06

> **Assumption:** `@wpm/shared` package provides shared types, crypto utilities, and AMM math consumed by `@wpm/node` (and later by other packages). Source files don't exist yet — we build them as needed.

---

## Phase 0 — Tracer Bullet

> Submit a Transfer transaction via HTTP, produce a block, and read it back — proving the full loop: HTTP API -> mempool -> block production -> JSONL persistence -> state query.

### Shared Types & Crypto (`@wpm/shared`)
- [x] Create `packages/shared/src/types/index.ts` — `Block`, `BaseTransaction`, `Transfer`, `Distribute`, `TransactionType` union, `ChainState` types
- [x] Create `packages/shared/src/crypto/index.ts` — RSA 2048 key generation, sign, verify, SHA-256 hash helpers using Node `crypto`
- [x] Create `packages/shared/src/index.ts` — re-export all subpaths

### Key Management & Genesis (`@wpm/node`)
- [x] Create `packages/node/src/keys.ts` — load or generate PoA key pair from disk, load oracle public key from env/file (FR-16)
- [x] Create `packages/node/src/state.ts` — `ChainState` class: balances map, committedTxIds set, chain array, treasury address getter
- [ ] Create `packages/node/src/genesis.ts` — produce genesis block with Distribute tx minting 10M WPM to treasury (FR-1)

### Persistence & Replay
- [ ] Create `packages/node/src/persistence.ts` — `appendBlock` (sync JSONL write), `replayChain` (read + validate line by line) (FR-2)

### Minimal Validation & Block Production
- [ ] Create `packages/node/src/validation.ts` — block hash/signature verification (FR-4), Transfer validation only (FR-5)
- [ ] Create `packages/node/src/mempool.ts` — FIFO queue with add/drain, duplicate and timestamp checks (FR-14, minimal)
- [ ] Create `packages/node/src/producer.ts` — 1s polling loop, take up to 100 txs, re-validate, produce + sign block, append to disk, update state (FR-3)

### HTTP API (Minimal)
- [ ] Create `packages/node/src/api.ts` — HTTP server on configurable port with: `POST /internal/transaction`, `GET /internal/health`, `GET /internal/balance/:address`, `GET /internal/block/:index`
- [ ] Create `packages/node/src/index.ts` — startup: load keys, replay or genesis, start producer loop, start HTTP server

### Tracer Bullet Test
- [ ] Create `packages/node/tests/tracer.test.ts` — integration test: boot node, submit Transfer, wait for block, verify balance change via API

---

## Phase 1 — Core Transaction Types

### Distribute Transaction (FR-6)
- [ ] Add `Distribute` type to shared types (if not already)
- [ ] Add Distribute validation to `validation.ts` — treasury sender, reason enum, balance check
- [ ] Add `POST /internal/distribute` endpoint that creates + signs Distribute tx with PoA key (FR-15)
- [ ] Test: distribute from treasury, verify recipient balance

### CreateMarket Transaction (FR-7)
- [ ] Add `Market`, `AMMPool`, `CreateMarket` types to `@wpm/shared`
- [ ] Create `packages/shared/src/amm/index.ts` — pool initialization math, price calculation (`priceA = sharesB / (sharesA + sharesB)`)
- [ ] Add markets map, pools map, externalEventIds map to `ChainState`
- [ ] Add CreateMarket validation to `validation.ts` — oracle sender, duplicate checks, field validation
- [ ] Add `GET /internal/market/:id` endpoint (FR-15)
- [ ] Test: create market, verify pool state and prices at 50/50

### PlaceBet Transaction (FR-8)
- [ ] Add `PlaceBet` type and AMM buy math to `@wpm/shared/amm` — two-step mint-then-swap, fee calculation
- [ ] Add sharePositions tracking to `ChainState` (address -> marketId -> outcome -> shares + costBasis)
- [ ] Add PlaceBet validation to `validation.ts` — market open, before eventStartTime, minimum bet, balance check
- [ ] Add `GET /internal/shares/:address` endpoint (FR-15)
- [ ] Test: place bet, verify shares received match worked example from spec (FR-8, Example 2)

### SellShares Transaction (FR-9)
- [ ] Add `SellShares` type and AMM sell math to `@wpm/shared/amm` — constant product sell, fee, cost basis reduction
- [ ] Add SellShares validation to `validation.ts` — market open, before eventStartTime, minimum sell, sufficient shares
- [ ] Test: sell shares, verify WPM returned matches worked example (FR-9, Example 3)

---

## Phase 2 — Settlement & Resolution

### ResolveMarket & SettlePayout (FR-10, FR-12)
- [ ] Add `ResolveMarket`, `SettlePayout` types to shared
- [ ] Implement settlement engine in `packages/node/src/settlement.ts` — compute winner payouts (1.00 WPM per winning share), treasury remainder, generate SettlePayout txs
- [ ] Add ResolveMarket validation — oracle sender, market open, event started
- [ ] Wire settlement: ResolveMarket triggers inline SettlePayout generation in same block
- [ ] Reject SettlePayout if received via `POST /internal/transaction` (`SYSTEM_TX_ONLY`)
- [ ] Test: create market -> place bets -> resolve -> verify payouts sum to wpmLocked (conservation)

### CancelMarket (FR-11)
- [ ] Add `CancelMarket` type to shared
- [ ] Implement cancel settlement in `settlement.ts` — refund cost basis, treasury gets remainder
- [ ] Add CancelMarket validation — oracle or PoA sender, market open
- [ ] Test: create market -> place bets -> cancel -> verify refunds match cost basis, conservation holds

### Referral Transaction (FR-13)
- [ ] Add `Referral` type to shared, add `referredUsers` set to ChainState
- [ ] Add Referral validation — PoA sender, duplicate referral check, treasury balance
- [ ] Add `POST /internal/referral-reward` endpoint (FR-15)
- [ ] Reject Referral if received via `POST /internal/transaction` (`SYSTEM_TX_ONLY`)
- [ ] Test: submit referral reward, verify 5000 WPM transferred, duplicate rejected

---

## Phase 3 — Remaining API, SSE & Hardening

### Complete HTTP API (FR-15)
- [ ] Add `GET /internal/state` — full chain state snapshot
- [ ] Add `GET /internal/blocks?from=N&limit=M` — paginated block list (max 100)
- [ ] Add 404 handler for unknown routes, 500 error wrapper

### SSE Event Stream (FR-15)
- [ ] Create `packages/node/src/events.ts` — SSE event emitter: `block:new`, `market:created`, `market:resolved`, `market:cancelled`, `trade:executed`
- [ ] Add `GET /internal/events` SSE endpoint
- [ ] Wire events into block producer and settlement engine
- [ ] Test: connect SSE, submit transaction, verify event received

### Mempool Hardening (FR-14)
- [ ] Add mempool capacity limit (1000 pending txs, `MEMPOOL_FULL`)
- [ ] Add timestamp drift check (300,000ms window, `TIMESTAMP_OUT_OF_RANGE`)
- [ ] Ensure duplicate check covers both mempool and committedTxIds

### Invariant Checks
- [ ] Add post-block invariant assertions: INV-1 (total supply conservation), INV-3 (no negative balances), INV-4 (no negative shares), INV-5 (k only increases)
- [ ] Add INV-2 check (priceA + priceB = 1.00 within tolerance) after every trade
- [ ] Log warnings on invariant violations, halt on critical violations (INV-1)

### Structured Logging & Observability
- [ ] Create `packages/node/src/logger.ts` — structured JSON logger to stdout with levels (error, warn, info, debug)
- [ ] Add key metric counters: block height, mempool size, tx validated, block produced, AMM trades
- [ ] Instrument block production, transaction validation, and startup replay with timing logs
