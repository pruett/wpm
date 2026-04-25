# PRD: Settlement loop completion and integer-native AMM rewrite

## Problem Statement

Wampum's market lifecycle has two ends that don't meet cleanly. On one end, users place bets into an AMM-backed Market; on the other, the resolver reads Kalshi Settlements and flips Market status. Between those two ends, the code that actually pays out winners, refunds cancels, and updates ledgers has grown quietly and carries real correctness risks:

- The AMM operates on floating-point numbers and rounds at DB insert, accumulating drift that is indistinguishable from genuine insolvency at settlement time.
- The pool is not guaranteed to cover payouts when the initial probability is skewed — common case, since we seed from Kalshi midpoints — and the treasury silently absorbs the shortfall with no log.
- Position rows are asymmetrically mutated: zeroed on cancel, left intact on resolve, producing latent bugs in any query that treats share counts as a liveness signal.
- The settlement transaction log records only winners, making "what happened to this user in this market" impossible to answer from a single table scan.
- The ingestion path accepts any Kalshi market with positive bid and ask, even when the spread is so wide that the midpoint is a phantom price — creating mispriced pools that are themselves the root cause of the insolvency risk above.

As a developer, I need a single coherent settlement design — not a scatter of partial fixes — that closes all these gaps at once, because they are interlinked: the AMM rounding question bears on the solvency question, which bears on the log-signal question, which bears on the ingestion gate.

## Solution

Four changes, shipped together as one coherent design:

1. **Rewrite the AMM to operate on integers end-to-end**, with pool-favoring rounding. Eliminates drift by construction. Any settlement shortfall thereafter is a real skew event, not dust.
2. **Tighten ingestion** to reject Kalshi markets without a consolidated price. A confidence gate on bid-ask spread (and optional pair consistency) prevents the skewed-seed scenarios that cause solvency gaps in the first place.
3. **Formalise settlement semantics** with Resolution and Settlement fused in a single DB transaction, every holder getting one `SettlePayout` row (including zero-amount rows for losers), positions treated as an immutable ledger (no zeroing on resolve or cancel), and the treasury acting as an explicit, logged backstop via a new `TreasuryBackstop` transaction type.
4. **Cancel refunds remain `costBasis`-based**, gated on outstanding share holdings rather than on residual cost basis — fixing the edge case where a user who sold everything at a loss would currently still be refunded.

The result is a settlement loop a developer can reason about: `placeBet` and `sellShares` produce `SettlePayout`-ready state; `runKalshiResolve` maps Kalshi terminals to atomic Wampum settlements; every money-moving event is a row in `transactions`, every liveness question is `markets.status`, every holding question is `positions`.

## User Stories

1. As a bettor, I want every WPM I win paid to my balance at the moment a market resolves, so that I never have to claim or wait for my winnings.
2. As a bettor, I want my cancelled-market refunds to reflect the net WPM I still had tied up in the market, so that cancellations return exactly what I had at stake and not more or less.
3. As a bettor who sold all my shares mid-market, I want cancel to not refund me anything, so that I cannot double-dip by selling on a favourable swing and then being made whole again on cancellation.
4. As a bettor who held only losing shares at resolution, I want my transaction history to show an explicit zero-payout row, so that my market timeline is legible end-to-end instead of going silent after my last bet.
5. As a bettor checking my positions in a resolved market, I want my position row to still reflect what I held at settlement, so that my history is preserved rather than erased.
6. As a bettor, I want the price I pay for a share to come from a market that has actually consolidated on a price, so that I am never trading against a phantom midpoint dragged between a 20¢ bid and an 80¢ ask.
7. As a developer, I want the AMM to operate on integers, so that rounding drift cannot accumulate and cannot be confused with real insolvency events at settlement.
8. As a developer, I want settlement math extracted from DB orchestration into a pure function, so that I can exhaustively test payout correctness without database fixtures.
9. As a developer, I want every settlement event — winners, losers, refunds, treasury backstops — to produce transaction rows, so that I can audit a market's lifecycle from the transactions table alone.
10. As a developer, I want "is this position live?" to be answered by `markets.status`, not by share counts, so that the liveness signal is never duplicated or drift between the two sources.
11. As a developer, I want a `TreasuryBackstop` transaction type that fires only on real AMM shortfalls, so that seeing one in the log is a meaningful signal that my ingestion gate let a bad market through.
12. As a developer, I want the AMM to round in the pool's favour on every trade, so that a trader can never extract value from rounding error and the pool's effective `k` only grows.
13. As a developer, I want the integer square root used by `calculateSell` to be deterministic and self-contained, so that my sell math is reproducible and has no external dependencies.
14. As an oracle operator, I want ingestion to reject Kalshi markets with wide bid-ask spreads, so that every Wampum Market we create has a seeded probability backed by real trading consensus.
15. As an oracle operator, I want ingestion to optionally check that both Kalshi Markets under one Kalshi Event agree on the implied probability, so that I am not seeding with data from an internally inconsistent order book.
16. As an oracle operator, I want to use the average of both Kalshi sides' implied probability for `initialProbabilityA`, so that my seed incorporates both sides of the event's pricing rather than arbitrarily trusting market A.
17. As an analyst, I want to query `SELECT * FROM transactions WHERE userId = ? AND marketId = ?` and see a complete user-timeline for that market, so that I never need to join against positions or balances to reconstruct what happened.
18. As an analyst, I want resolved and cancelled markets to retain position rows with original share counts and cost basis, so that I can answer post-hoc questions like "average cost basis on losing shares by sport" without replaying the transaction log.
19. As an analyst, I want treasury P&L to be computable by summing `Distribute`, `CreateMarket`, `TreasuryBackstop`, and resolution-remainder events, so that the treasury's ledger is complete and auditable.
20. As an auditor, I want settlement and resolution to commit atomically in a single DB transaction, so that a partial failure leaves the database in a consistent state — never "resolved but unpaid."
21. As a UI consumer, I want display prices to remain floats in [0, 1], so that existing components rendering prices, multipliers, and implied probabilities continue to work unchanged.
22. As a UI consumer, I want the `bettorCount` on a resolved market to reflect users who actually bet on that market, so that resolved markets don't show inflated or zero bettor counts due to position-row lifecycle bugs.
23. As a future maintainer, I want ADRs recording the integer-AMM decision and the positions-as-immutable-ledger decision, so that I don't "fix" something that was deliberate.
24. As a bettor, I want to be able to see on my profile which markets I've bet on regardless of their status, so that my betting history is complete across open, resolved, and cancelled markets.
25. As a developer writing downstream queries, I want the settlement math module to take positions and pool state as inputs and return payout intents, so that I can test settlement logic without any database at all.

## Implementation Decisions

### Modules and interfaces

- **`lib/amm` (rewritten, pure).** All functions take and return `bigint` for share counts, reserves, liquidity, WPM amounts, and `k`. `calculateBuy` returns `{ shares: bigint; newPool: AMMPool }` with `sharesA`/`sharesB`/`liquidity` as `bigint`. `calculateSell` same shape with `wpmReturned: bigint`. `initializePool` accepts `seedAmount: bigint` and a float `initialProbabilityA` (the one-shot conversion point), and returns an `AMMPool` with integer reserves. `calculatePrices` and `calculateOdds` continue to return floats derived from bigint reserves — these are display-only. A private `isqrt(x: bigint): bigint` implemented via Newton's method handles `calculateSell`'s square root.
- **Rounding direction.** Every integer division in the trade path uses ceiling-in-pool's-favour. `newTarget = ceil(k / newOther)` on buys; symmetric choice on sells. The post-trade product `newReserveA * newReserveB` is always `>= k_before`. Users may receive one integer unit less than the real-valued fair amount in edge cases; they never receive more.
- **`AMMPool` type.** Field types change to `bigint` for `sharesA`, `sharesB`, `k`, `liquidity`. `marketId` stays string.
- **`lib/kalshi/translator` (extended).** `midProbability` gains spread-threshold logic and a new `"spread_too_wide"` failure path. `translateKalshiEvent` gains `"insufficient_confidence"` as a `TranslationResult` kind, possibly wrapping reasons (`spread_a_too_wide`, `spread_b_too_wide`, `pair_inconsistent`). `initialProbabilityA` is computed as the average of `midProb_a` and `1 - midProb_b` when both pass the gate; if pair-consistency is enabled and the two disagree beyond threshold, the market is rejected.
- **`lib/settlement` (new, pure).** Extract the per-holder payout computation currently inlined in `resolveMarket` and `cancelMarket`. Input: `{ positions, outcome | "cancel_refund", wpmReserve, seedAmount }`. Output: `{ payouts: { userId, kind: "win" | "loss" | "refund" | "zero", amount: bigint }[], treasuryDelta: bigint, backstopAmount: bigint }`. Pure, synchronous, no I/O. Every caller of this module constructs DB writes from the output intents.
- **`data/markets` orchestrators (rewritten).** `resolveMarket` and `cancelMarket` become thin appliers: load market + pool + positions, call the settlement module, apply each intent (credit balance, write SettlePayout row), write `TreasuryBackstop` row if `backstopAmount > 0`, update pool and market status, write `ResolveMarket` / `CancelMarket` summary row — all inside one `db.transaction`. Position rows are not mutated.
- **`data/trading` callers.** `placeBet` and `sellShares` pass `bigint` into `lib/amm` and insert `bigint` directly (no `Math.round`). Balance and costBasis math stay `bigint`.
- **`data/markets.createMarket` seed split.** Consumes `seedAmount: bigint` and float `initialProbabilityA`; produces integer reserves through the pool initializer. This is the only rounding event in the Market's lifetime.

### Schema changes

- `transactionTypes` enum gains `"TreasuryBackstop"`. No migration beyond the enum expansion.
- No changes to column types — schema already uses `bigint`, but Drizzle's `mode: "number"` pattern means we read/write JS numbers. Change `mode: "number"` to `mode: "bigint"` for all money-and-share columns (`balances.amount`, `treasury.amount`, `ammPools.reserveA/reserveB/wpmReserve/seedAmount`, `positions.sharesA/sharesB/costBasis`, and `markets.closesAt` can stay `number` since it's a timestamp not money).
- Existing rows are already-integer under the hood; this is a type-only change at the Drizzle boundary.

### Transaction log completeness

- Every holder with `sharesA > 0 || sharesB > 0` at resolution time gets exactly one `SettlePayout` row, including losers (with `amount: 0`) and winners (with `amount: winningShares`). Cancel symmetry: every holder with outstanding shares gets one `SettlePayout` row with `amount: costBasis`.
- The refund gate in cancel changes from `costBasis > 0` to `sharesA > 0 || sharesB > 0`.
- `TreasuryBackstop` transaction written when and only when settlement draws from treasury to cover a shortfall; `amount` is the backstop draw, `marketId` attached, `userId` null.
- `ResolveMarket` and `CancelMarket` summary rows continue to exist alongside the per-user `SettlePayout` rows.

### Liveness signal

- `positions` table is treated as an immutable ledger. No `UPDATE` against it in `resolveMarket` or `cancelMarket`. Callers needing "live positions" filter on `markets.status = 'open'`.
- `getMarket`'s `bettorCount` computation is fixed to count positions where the market is open, not where share counts are non-zero. Equivalent fix applied anywhere else that conflates share counts with liveness.

### Ingestion confidence gate

- Spread threshold (initial value: 0.10, tunable). Applied to both Kalshi Markets in an Event.
- Pair-consistency threshold (initial value: 0.05) between `midProb_a` and `1 - midProb_b`. Markets exceeding this are rejected.
- `initialProbabilityA` is the average of `midProb_a` and `1 - midProb_b` when both pass.
- Volume gate deferred; revisit when real data shows whether spread alone is sufficient.

### Atomicity

- Resolution + Settlement commit in one `db.transaction`. No resolved-but-unpaid intermediate state.
- Cancellation + refunds commit in one `db.transaction`. No cancelled-but-unrefunded intermediate state.
- The settlement module is synchronous and called inside the transaction; it doesn't perform I/O itself.

### ADRs already written

- **ADR-0004 Positions as immutable ledger** — records the decision not to mutate position rows on resolve/cancel.
- **ADR-0005 Integer-native AMM** — records the decision to operate on `bigint` end-to-end with pool-favoring rounding.

## Testing Decisions

### Principle

Tests verify behaviour through public interfaces. We do not assert on intermediate state that isn't part of the contract (e.g., we do not assert that a specific row was updated in a specific order; we assert that balances, positions, and transactions end up in the correct state after the public call returns). This follows the project's existing testing philosophy captured in user memory.

### Modules to test

- **`lib/amm` (unit).** Exhaustive tests of `initializePool`, `calculateBuy`, `calculateSell` for: preservation of `k >= k_before`, monotonicity (buying A raises priceA), symmetry (buy then sell returns ≤ original WPM, never >), rounding direction (trader is always rounded against), extreme probabilities (p = 0.01, 0.99), large trade sizes relative to liquidity, `isqrt` correctness for a range of bigints including edge values (0, 1, very large). Prior art: the existing `kalshi.contract.test.ts` pattern for pure-function fixture tests.
- **`lib/kalshi/translator` (unit).** Extend existing `translator.test.ts`: add fixtures for wide-spread markets, pair-inconsistent markets, and valid-skewed markets to confirm the gate rejects the first two and accepts the third. Verify `initialProbabilityA` is the average of both sides' implied probability. Prior art: the entire existing translator test file.
- **`lib/settlement` (unit).** The highest-leverage tests in the project. Given hand-constructed position lists + pool state + outcome, assert the returned `payouts`, `treasuryDelta`, and `backstopAmount` match expectations for: winner-only markets, loser-only markets, mixed, zero-position markets, cancels with and without prior sells, markets where `sum(winningShares) > wpmReserve` (backstop case), markets where `sum(winningShares) == wpmReserve` exactly, markets where the only holders sold out.
- **`data/markets` (integration).** In-memory or test-database-backed tests of `resolveMarket` and `cancelMarket` end-to-end: assert balance deltas, transaction rows (types, amounts, one-per-holder completeness), market status, pool state, position rows (unchanged). Assert atomicity: if anything throws, no partial writes. Integration with a real DB, following any existing `data/` testing patterns.

### Not tested at the unit level

- Drizzle ORM internals, Kalshi API fetch behaviour, Next.js cache invalidation. These are either framework behaviour or I/O boundaries; they're covered implicitly by integration tests or handled at a separate layer.

## Out of Scope

- Changing the AMM formula (LMSR, LS-LMSR, or any non-CPMM variant). ADR-0003 commits to CPMM; this PRD only fixes its numerical implementation.
- Sub-WPM precision (scaling the atomic unit to millionths). The schema already stores `bigint`; if we ever need finer precision later we can rescale without changing algorithms.
- Real-money integration or KYC gates at settlement. Payouts are internal balance credits.
- A user-initiated "claim" flow. Payouts are pushed, never pulled.
- Retroactive reprocessing of already-resolved markets. This PRD changes forward behaviour; existing resolved/cancelled markets keep their existing (asymmetric) state.
- Refactoring the oracle heartbeat / cron scheduling. The existing `runKalshiResolve` entry point stays; only the functions it calls change.
- Changes to the UI beyond the `bettorCount` fix. Price/multiplier display continues to consume floats.
- Tightening the ingestion volume gate. Deferred until real data justifies it.

## Further Notes

- The AMM rewrite, the settlement module extraction, and the transaction-log completeness changes are tightly coupled — they should ship together or not at all. Splitting them risks a mixed-mode production where some markets use integer AMM and some float, which would make the `TreasuryBackstop` signal useless.
- The ingestion confidence gate is independently deployable and could ship first as a low-risk, high-value change. However, its *value as a mitigation for the solvency gap* is only realised alongside the rest — before the AMM rewrite, the treasury still silently absorbs shortfalls; after, shortfalls become observable.
- Thresholds (spread, pair consistency) are initial guesses. Expect to tune once real Kalshi data is flowing through the new gate. The gate is designed to be an easy-to-adjust constant, not structural.
- Migration concern: because we're flipping `bigint (mode: "number")` to `bigint (mode: "bigint")` at the Drizzle boundary, every call site that arithmetic's on these fields must become `bigint`-aware. This is a mechanical but wide change; a type error will surface each affected line.
- The CONTEXT.md glossary has been updated throughout this design conversation and remains the canonical reference for domain language during implementation.
