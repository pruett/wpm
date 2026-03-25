# Market Resolution & Settlement — Tracer Bullet #2

## Context

The first tracer bullet proved: create market → place bet → odds shift → SSE event. But users can bet and never win. This feature completes the core product loop by resolving markets and paying out winners. Without it, the platform has no economic cycle.

**Goal**: Oracle resolves a market → node settles all positions → winners credited, losers zeroed, treasury reclaims pool remainder → API surfaces resolved state → SSE pushes event.

## Design Decisions

**1. Separate tx types**: `ResolveMarket` (oracle assertion) and `SettlePayout` (accounting) are distinct on-chain transactions. Keeps the chain auditable — you can see resolution and each individual payout as separate entries.

**2. Single HTTP call triggers everything**: `POST /internal/resolve-market` generates one `ResolveMarket` tx + one `SettlePayout` per winning position + one `Distribute` to reclaim pool remainder. All enter the mempool together, land in the same block.

**3. SettlePayout is a system tx (no validation)**: Like `Distribute`, it early-returns in validation. The router is responsible for correctness. This avoids a timing problem — SettlePayout enters the mempool before ResolveMarket is applied, so we can't validate "market is resolved" at enqueue time. Within the block, `applyBlockPure` processes txs sequentially so ResolveMarket runs before SettlePayouts.

**4. Pool reclaim via existing `Distribute` tx**: No new type needed. Memo field documents it (`"pool_reclaim:{marketId}"`).

**5. Settlement math**: Winning shares pay 1.00 WPM each. `payout = position.shares`. Treasury reclaim = `pool.liquidity - sum(winning payouts)`. The CPMM invariant guarantees the pool is always solvent (pool.liquidity >= total winning shares outstanding).

## Implementation Slices (TDD: RED → GREEN per slice)

### Slice 1: ResolveMarket changes market status

The minimum viable path — resolve a market, see its status change.

**RED** — `packages/node/tests/node.test.ts`: New test. Setup: genesis, fund user, create market, place bet. Action: `POST /internal/resolve-market { id, result: "A" }`, produce block. Assert: `GET /internal/market/:id` returns `status: "resolved"`, `result: "A"`.

**GREEN** — changes:

| File                                 | Change                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/index.ts` | Add `ResolveMarket` variant to `Transaction` union: `{ type: "ResolveMarket"; marketId: string; result: "A" \| "B"; signature: string; timestamp: string; }`                            |
| `packages/node/src/validation.ts`    | Add `ResolveMarket` case: market must exist, status must be `"open"` (not already resolved/cancelled). System tx — no signature verification.                                           |
| `packages/node/src/chain-state.ts`   | Add `ResolveMarket` case in `applyBlockPure`: set `market.status = "resolved"`, `market.result = tx.result`                                                                             |
| `packages/node/src/router.ts`        | Add `ResolveMarketBody` schema (`{ id, result }`). Add `POST /internal/resolve-market` endpoint using `makeSystemTx`. For this slice: just adds the single ResolveMarket tx to mempool. |

### Slice 2: SettlePayout credits winners, treasury reclaims remainder

The payoff — winning users get WPM, treasury gets the rest.

**RED** — `packages/node/tests/node.test.ts`: Extend test or new test. Setup: genesis, fund user, create market (seed 1000), user bets 100 on A. Capture user balance and treasury balance before resolution. Action: resolve to A, produce block. Assert: user balance increased by `position.shares` WPM, treasury balance increased by pool remainder, market status resolved.

**GREEN** — changes:

| File                                 | Change                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/index.ts` | Add `SettlePayout` variant: `{ type: "SettlePayout"; marketId: string; to: string; shares: number; amount: number; signature: string; timestamp: string; }`                                                                                                                                                                                                            |
| `packages/node/src/validation.ts`    | Add `SettlePayout` case: early return (system tx, like `Distribute`)                                                                                                                                                                                                                                                                                                   |
| `packages/node/src/chain-state.ts`   | Add `SettlePayout` case in `applyBlockPure`: `balances[addressOf(tx.to)] += tx.amount`. Add `getPositionsByMarket(marketId)` to ChainState service interface — filters all positions by marketId.                                                                                                                                                                      |
| `packages/node/src/router.ts`        | Expand `POST /internal/resolve-market` handler: after creating ResolveMarket tx, read positions via `chainState.getPositionsByMarket(id)`, generate one SettlePayout per winning position (`amount = position.shares`), generate one Distribute to treasury for pool remainder (`pool.liquidity - sum(payouts)`, memo: `"pool_reclaim:{id}"`), add all txs to mempool. |

### Slice 3: Multi-user lifecycle with economic invariant

Proves the full loop with two users on opposite sides and total WPM conservation.

**RED** — `packages/node/tests/node.test.ts`: New test. Setup: fund user1 and user2, create market (seed 1000). user1 bets 100 on A, user2 bets 200 on B. Produce block. Resolve to A. Produce block. Assert: user1 balance = 100K - 100 + user1_shares_A (profit), user2 balance = 100K - 200 (total loss), treasury reclaimed remainder, **total WPM across all addresses = 10,000,000** (conservation invariant).

**GREEN** — No new production code. This test exercises Slice 1+2 code with richer scenarios. Requires adding `user2: generateKeyPair()` to `testKeys` in `packages/node/tests/helpers.ts`.

Also test edge cases in this slice:

- **No bets placed**: Create market, resolve immediately → treasury reclaims full seed (pool.liquidity = seedAmount, 0 payouts)
- **Double resolution rejected**: Resolve market, try again → 400 error with `MARKET_NOT_OPEN` code

### Slice 4: Event bus + API enrichment for resolved markets

**RED** — Two tests:

1. `packages/node/tests/node.test.ts`: Subscribe to EventBus before resolution. Resolve market. Assert `market:resolved` event received with marketId and result.
2. `packages/api/tests/api.test.ts`: Mock NodeClient returns a resolved market. `GET /api/markets` → assert enrichment shows `status: "resolved"`, `result: "A"`, terminal prices (`priceA: 1.0, priceB: 0.0`).

**GREEN** — changes:

| File                                 | Change                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/index.ts` | Add `MarketResolvedEvent` type: `{ type: "market:resolved"; marketId: string; result: "A" \| "B" }`. Add `NodeEvent = TradeExecutedEvent \| MarketResolvedEvent` union.                                                                              |
| `packages/node/src/event-bus.ts`     | Widen PubSub generic from `TradeExecutedEvent` to `NodeEvent`. Update publish/subscribe types.                                                                                                                                                       |
| `packages/node/src/producer.ts`      | After processing `ResolveMarket` tx: publish `{ type: "market:resolved", marketId, result }`.                                                                                                                                                        |
| `packages/api/src/router.ts`         | In `/api/markets` enrichment: if `market.status === "resolved"`, set prices to terminal values (winning = 1.0, losing = 0.0) instead of computing from stale pool. In `/events/stream`: handle `market:resolved` events (pass through or transform). |
| `packages/api/src/node-client.ts`    | Update `eventStream` type to `Stream<NodeEvent>`.                                                                                                                                                                                                    |
| `packages/api/tests/api.test.ts`     | Add resolved market to mock, verify enrichment.                                                                                                                                                                                                      |

### Slice 5: Oracle submits resolution

**RED** — Can be verified manually or with a lightweight test. The oracle calls `POST /internal/resolve-market` — same endpoint tested in slices 1-3.

**GREEN** — `packages/oracle/src/index.ts`: After market creation, instead of `Effect.never`, add a resolution path. For the tracer bullet: hardcoded resolution after market creation (simulating a game finishing). In production this will be ESPN-driven, but the interface is the same HTTP call.

## Files Modified (complete list)

| File                                 | Slices     |
| ------------------------------------ | ---------- |
| `packages/shared/src/types/index.ts` | 1, 2, 4    |
| `packages/node/src/chain-state.ts`   | 1, 2       |
| `packages/node/src/validation.ts`    | 1, 2       |
| `packages/node/src/router.ts`        | 1, 2       |
| `packages/node/src/producer.ts`      | 4          |
| `packages/node/src/event-bus.ts`     | 4          |
| `packages/node/tests/node.test.ts`   | 1, 2, 3, 4 |
| `packages/node/tests/helpers.ts`     | 3          |
| `packages/api/src/router.ts`         | 4          |
| `packages/api/src/node-client.ts`    | 4          |
| `packages/api/tests/api.test.ts`     | 4          |
| `packages/oracle/src/index.ts`       | 5          |

## Reusable Patterns & Functions

- `makeSystemTx()` in `packages/node/src/router.ts:25` — reuse for ResolveMarket and SettlePayout tx creation
- `addressOf()` from `@wpm/shared` — convert public keys to addresses for balance lookups
- `initializePool()` / `calculateBuy()` from `packages/shared/src/amm/index.ts` — existing AMM, `pool.liquidity` tracks total WPM in pool (line 32: `liquidity: pool.liquidity + amount`)
- `serveNodeForTest` / `produceBlock` / `testKeys` from `packages/node/tests/helpers.ts` — test infrastructure
- `ValidationError` from `packages/node/src/errors.ts` — existing error type for validation failures
- Existing stateful mock pattern in `packages/api/tests/api.test.ts:12` — extend for resolved market state

## Testing Strategy

**Philosophy**: Integration tests through public HTTP interfaces. Tests should read like specifications. No mocking of node internals — tests hit the real chain-state, real mempool, real block producer.

**TDD discipline**: Vertical slices only. Write ONE test, make it pass, move to next. Never batch tests ahead of implementation.

**Test shape**: Every node test follows the same pattern:

```
yield* serveNodeForTest          // genesis block
// ... setup (fund, create market, place bets)
// ... action (resolve)
yield* produceBlock              // apply pending txs
// ... assert via HTTP GET endpoints
```

**Key assertions per slice**:

1. Market status transition: `status === "resolved"`, `result === "A"`
2. Balance accounting: user balance increased by `position.shares`, treasury reclaimed `pool.liquidity - totalPayouts`
3. Economic invariant: `sum(all balances) === 10,000,000` — WPM is never created or destroyed
4. Edge cases: no-bet market reclaims full seed, double-resolve rejected
5. Events: `market:resolved` event published with correct payload
6. API enrichment: resolved markets show terminal prices (1.0/0.0)

## Verification

After all slices, run full test suite:

```bash
bun run test
```

All packages should pass: shared (AMM invariants), node (resolution + settlement integration), api (enrichment + SSE), oracle, web.
