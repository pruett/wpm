# PRD: Multi-Outcome Markets

## Problem Statement

Wampum today only ingests Kalshi events with exactly two nested markets. This works for sports — basketball, baseball, hockey, football — where there is one winner from two teams and the Kalshi Event maps cleanly to one Wampum **Market** with two outcomes named `A` and `B`. But the vast majority of *interesting* prediction markets are not binary in this sense:

- **Multi-outcome shows** — "Who will win Album of the Year?" has five nominees, each a separate winner candidate.
- **Large fields** — A PGA golf tournament has 50+ golfers, any of whom could win.
- **Elections / cultural contests** — "Who will win the Presidency?", "Best Picture", "Manager of the Year" — each has N candidates, exactly one of whom wins.

Kalshi already represents all of these uniformly: one Kalshi Event with N nested Kalshi Markets, each a YES/NO contract on one specific outcome (one nominee, one golfer, one candidate). Wampum's translator currently rejects all of them as `non_binary` because the internal model can only hold two outcomes per Market.

A secondary problem: the existing A/B vocabulary (`teamA`/`teamB`, `sharesA`/`sharesB`, `Outcome: 'A' | 'B'`) is leaking the binary assumption throughout the codebase. Schema columns, AMM types, position rows, transaction payloads, and UI components all encode "exactly two sides." Adding multi-outcome support by extending these everywhere produces a worse codebase than rethinking the shape.

## Solution

Mirror Kalshi's data model end-to-end. A real-world contest becomes a **Wampum Event** holding N independent binary **Markets** — each its own YES/NO contract with its own CPMM pool. This applies uniformly to *all* events, including formerly-binary sports: a basketball game is one Event with two Markets (`Lakers-WIN`, `Celtics-WIN`), not one Market with two outcomes `A`/`B`.

Users place buy orders on a specific Market's YES-side. To bet against a team or candidate, they buy YES on a sibling Market. There is no NO-side and no sell — every bet is a buy-YES on exactly one Market, committed until the parent Event terminally commits. This is a deliberate product stance: the simplicity downstream (monotonic cost basis, trivial refunds, one UI primitive per Market) is worth giving up the ability to exit a position.

From the user's perspective, after this change:

- Multi-outcome Kalshi Events appear in Wampum as a single Event card with N child Markets, each tradeable independently.
- Sports Events render with the same shape — one Event card with two child Markets — instead of an A/B contest.
- Every bet is a single action: pick a Market, buy YES, commit.
- Events resolve as a unit: when every child Kalshi Market has settled, the Event commits terminally and every winning holder is paid in one atomic transaction. A 48-hour Settlement Deadline bounds the wait; if a child Kalshi Market is still pending past the deadline, only that child is cancelled — siblings that settled cleanly still pay out.

## User Stories

### Betting on multi-outcome events

1. As a user betting on the Grammys, I want to see all five nominees for Album of the Year as separate Markets under one Event, so that I can bet on whichever nominee I think will win.

2. As a user betting on a PGA tournament, I want to bet on a specific golfer winning out of the full field, so that I can express my prediction even when there are 50+ competitors.

3. As a user, I want to bet against a team by buying YES on the opposing team's Market, so that I can express both sides of a contest with one consistent mechanic.

4. As a user, I want each child Market under an Event to display its own implied probability, so that I can compare prices across siblings at a glance.

5. As a user, I want each child Market under an Event to display its own multiplier (decimal odds), so that I can see the payout ratio per WPM staked.

6. As a user, I want to see whether the sum of YES-prices across an Event's Markets adds up to roughly 1.0, so that I know whether prices look internally consistent or whether arbitrage opportunities exist.

7. As a user, I want to bet on multiple sibling Markets within the same Event if I want diversification or if I think one outcome will lose, so that I'm not forced to pick a single winner.

### Trading model (buy-YES-only)

8. As a user about to place my first bet, I want a clear up-front explanation that there is no sell-back and no NO-side, so that I understand the commitment I'm making before I bet.

9. As a user, I want the betting UI to show exactly one action per Market — "buy YES" — so that the flow is unambiguous.

10. As a user, I want my cost basis on a Market to be exactly the WPM I put in, so that I can predict my refund amount if the Market cancels.

11. As a user, I want my position on a Market to be unaffected by my position on a sibling Market, so that buying YES on `Lakers-WIN` and YES on `Celtics-WIN` are tracked as two independent stakes.

12. As a user, I want to see my P&L per Market against the current AMM-quoted share value, so that I can track unrealized winnings before resolution.

13. As a user, I want to see my aggregate stake across all child Markets of an Event, so that I can understand my total exposure to that contest at the Event level.

### Resolution and settlement

14. As a user, I want my winnings paid out automatically when the Event resolves, so that I don't have to claim them manually.

15. As a user with positions across multiple child Markets, I want every payout to commit in the same DB transaction as the Event-commit, so that I see all my outcomes resolved at the same instant.

16. As a user holding YES-shares of a winning Market, I want to receive 1 WPM per share, so that the payout math matches my expectations.

17. As a user holding YES-shares of a losing Market, I want to see a `SettlePayout` row with `amount = 0` in my transaction history, so that I can confirm the Market resolved against me rather than wondering if it was missed.

18. As a user, I want to receive a full refund of my cost basis when a Market cancels (Kalshi voided the whole Event, Kalshi paid a scalar settlement, or the 48-hour Settlement Deadline elapsed with that child Kalshi Market still pending), so that I'm not penalized for outcomes outside my control.

19. As a user with a winning position on a cleanly-settled Market whose sibling hit the Settlement Deadline, I want my winnings paid in full while only the stragglers cancel, so that I'm not punished for someone else's lagging Market.

20. As a user, I want partially-resolved Event displays to be honest — showing some Markets as resolved YES, some as resolved NO, and some as cancelled — so that I can trust the UI rather than getting hidden uniformity.

### Operator and developer concerns

21. As an operator running the ingest cron, I want a Kalshi Event with all child Markets passing the per-Market confidence gate to ingest atomically as one Event plus N Markets, so that the Event is a single coherent unit in our database.

22. As an operator, I want a Kalshi Event with *any* child Market failing the per-Market spread gate to be rejected entirely and re-evaluated on the next cron tick, so that I never have a partially-represented Event with missing siblings.

23. As an operator, I want Kalshi Events with more than 30 nested Markets to be rejected as `too_many_markets`, so that a pathologically large field doesn't seed thousands of WPM into the treasury at once.

24. As an operator, I want the translator to reject Events where the nested Kalshi Markets disagree on `expected_expiration_time`, so that a Kalshi data anomaly doesn't propagate to a Wampum Event with ambiguous timing.

25. As an operator, I want each child Market's spread checked independently against the same per-Market threshold, so that the gate is uniformly applied regardless of Event size.

26. As an operator, I want the ingest summary to report counts of each skip reason (`non_binary` is gone; new reasons include `too_many_markets`, `inconsistent_close_times`, per-Market spread failures aggregated to Event), so that I can see why Kalshi data isn't becoming Wampum Events.

27. As an operator running the resolver cron, I want the resolver to select Events past `closesAt` with `status = 'open'`, batch their Kalshi Event tickers by series, and make one API call per series, so that polling is bounded.

28. As an operator, I want the resolver to leave an Event open if *any* child Kalshi Market has not yet reached terminal status and the Settlement Deadline has not elapsed, so that the Event commits as a unit in the happy case.

29. As an operator, I want the resolver to force-commit an Event terminally when the Settlement Deadline elapses — cleanly-settled children resolve on their actual `result`, unsettled children cancel as `kalshi_no_settlement` — so that user positions are never locked indefinitely.

30. As an operator, I want every Event-commit to be a single DB transaction touching all N child Markets, N pools, and per-holder `SettlePayout` rows across all children, so that an Event never appears in a partially-committed state.

31. As an operator, I want the treasury backstop to fire per-Market (not per-Event), so that a `TreasuryBackstop` count in the log remains a high-signal indicator of a specific Market's pool being under-collateralised.

32. As a developer changing the schema, I want the translator's output type to be derived from the drizzle row types for both `events` and `markets`, so that any schema change produces a TypeScript error in the translator rather than a runtime surprise.

33. As a developer, I want the translator to remain a pure function taking a Kalshi Event and returning a typed result, so that I can test it exhaustively without spinning up a database or mocking HTTP.

34. As a developer, I want the resolver's commit-decision logic extracted as a pure function (`decideEventCommit(wampumEvent, kalshiResponse, now)`), so that I can test all branches — happy path, partial settlement, deadline degradation, scalar, void — without DB writes.

35. As a developer, I want `lib/amm.ts` reduced to `initializePool`, `calculateBuy`, `calculatePrices`, and `calculateOdds` only, so that the trade-path code surface is minimal and matches the buy-YES-only product surface.

36. As a developer, I want the A/B vocabulary purged end-to-end — schema columns, AMM types, position fields, transaction payloads, server actions, UI components — so that a new reader of the codebase never has to reverse-engineer a retired model.

## Implementation Decisions

### Schema (single migration, full wipe of `events` / `markets` / `amm_pools` / `positions` / `transactions`)

- **New `events` table**: `id` (text PK, derived from Kalshi `event_ticker`), `sport`, `name`, `closesAt`, `status: 'open' | 'terminal'`, `createdAt`. Owns the canonical close time and the Event-level lifecycle status.
- **`markets` reshaped**: `id` (text PK, derived from each Kalshi Market's ticker), `eventId` (FK to `events.id`), `name` (= Kalshi `yes_sub_title`), `ticker`, `status: 'open' | 'resolved' | 'cancelled'`, `resolvedAs: 'yes' | 'no' | null`, `resolvedAt`, `createdAt`. Drops `sport`, `teamA/B`, `tickerA/B`, `closesAt`, `resolvedOutcome`.
- **`amm_pools` reshaped**: `reserveA/B` → `reserveYes/No`. Otherwise unchanged.
- **`positions` reshaped**: `(userId, marketId, sharesA, sharesB, costBasis)` → `(userId, marketId, shares, costBasis)`. Only YES-shares are user-held.
- **`transactions.type` enum**: drops `SellShares`. Otherwise unchanged.
- **Indexes**: `events (status, closesAt)` replaces today's `markets (status, closesAt)`; positions retain `(marketId)` index.

### Translator (`lib/kalshi/translator.ts`)

- Per-Event ingest with N children. Translator returns a discriminated union:
  - `ok` with `{ event: EventInsertRow, markets: Array<{ market: MarketInsertRow, seedAmount: bigint, initialProbabilityYes: number }> }`
  - `too_many_markets` (N > 30)
  - `unparseable_close_time` (any child's `expected_expiration_time` doesn't parse)
  - `inconsistent_close_times` (children disagree on `expected_expiration_time`)
  - `no_initial_price` (any child has no usable bid/ask)
  - `insufficient_confidence` with per-Market reasons (spread too wide on any child)
- **All-or-nothing**: if any child fails its gate, the Event is rejected entirely.
- **Per-Market spread gate only.** `pair_inconsistent` is dropped — it was a binary-only cross-check with no clean generalization to N.
- **Cap at 30 children**, returned as `too_many_markets` with the count.
- **`closesAt` source of truth**: `events.closesAt = markets[0].expected_expiration_time`; verify all siblings match exactly.

### Ingest driver (`lib/kalshi/ingest.ts`)

- Calls translator. On `ok`, persists `events` row + N `markets` rows + N `ammPools` rows in one DB transaction.
- AMM seeding (`initializePool`) is called per-Market with that child's `initialProbabilityYes` derived from Kalshi's bid/ask midpoint. Each Market's pool is independent.

### Resolver (`lib/kalshi/resolve.ts`)

- **Selection**: `events WHERE status = 'open' AND closesAt < now`.
- **Per-series batching**: group selected Events by Kalshi series, one `/events?event_tickers=...` call per series.
- **Pure decision function**: `decideEventCommit(wampumEvent, kalshiResponse, now)` returns one of:
  - `{ kind: 'wait' }` — at least one child Kalshi Market is non-terminal and the deadline has not elapsed.
  - `{ kind: 'commit', perChild: Array<{ marketId, outcome: 'resolved_yes' | 'resolved_no' | 'cancelled_voided' | 'cancelled_scalar' | 'cancelled_no_settlement' }> }`
- **Deadline degradation**: when `now >= closesAt + 48h` and at least one child is still non-terminal, the commit plan marks unsettled children as `cancelled_no_settlement` while cleanly-settled siblings resolve on their actual `result`.
- **Void semantics**: an Event where every child Kalshi Market settled `no` produces a commit plan with every child marked `cancelled_voided`.
- **Scalar semantics**: any child Kalshi Market with `result: 'scalar'` produces `cancelled_scalar` for that child only.

### Settlement (`lib/settlement.ts`)

- Adapts to Event-atomic commit. Takes a commit plan plus all positions across child Markets plus all pool states; produces:
  - Balance credits for each winning holder (1 WPM per YES-share on `resolved_yes` Markets, 0 on `resolved_no` Markets, `costBasis` on every cancelled-variant Market).
  - One `SettlePayout` transaction row per (holder, child Market) with non-zero shares at commit time.
  - One `ResolveMarket` transaction row per child Market in the commit.
  - `TreasuryBackstop` rows per child Market where `wpmReserve` is short of total winning payouts.
  - Final status updates: `events.status = 'terminal'`; per-child `markets.status` to `resolved` or `cancelled` with `resolvedAs` set on resolved children.
- All of the above written in one DB transaction.

### AMM (`lib/amm.ts`)

- Retains `initializePool`, `calculateBuy`, `calculatePrices`, `calculateOdds`.
- Drops `calculateSell` and `isqrt`.
- Type signatures and field names renamed A/B → Yes/No.
- Integer-rounding discipline preserved on the buy path (ADR-0005).

### Data layer

- New `data/events.ts`: Event reads (with child Markets, with pools).
- `data/markets.ts`: reads per-Market, no creation API (creation is via ingest only).
- `data/trading.ts`: `placeBet(marketId, amount)` — outcome parameter dropped. `sellShares` removed.
- `data/positions.ts`: collapsed shape; reads filter by `markets.status = 'open'` for live positions.

### Server actions

- `placeBet(marketId, amount)` — buy YES.
- `sellShares` — removed.
- Resolver action runs at Event granularity; no per-Market resolve action exposed externally.

### UI

- **Event detail page**: Renders parent Event header (name, sport, closesAt, status) plus N child Markets in a vertical list. Each child Market shows its name (the YES-side description), price/multiplier, and a single "buy YES" affordance.
- **Market list page** (homepage): Groups Markets by parent Event. A binary sports Event collapses to a card showing both child Markets side-by-side. A multi-outcome Event shows a card with a count and the top N children by liquidity/probability.
- **Position list**: One row per `(user, market)` with non-zero shares. Aggregate by Event for the per-Event "total stake" view.
- **No sell button anywhere.** No outcome toggle on the bet form — the chosen Market is the YES-side commitment.

## Testing Decisions

A good test verifies external behavior through the module's public interface, not implementation details. The existing project memory makes this explicit: tests should remain green across refactors that preserve behavior, and should fail when the spec changes.

### Modules with full test coverage

1. **Translator** (`lib/kalshi/translator.ts`). Prior art: existing `translator.test.ts`.
   - Happy path: a 2-Market Event ingests as one Event + 2 Markets with correct `initialProbabilityYes` per child.
   - Happy path: a 5-Market Event ingests as one Event + 5 Markets, all children consistent.
   - All-or-nothing rejection: if any one child has a wide spread, the entire Event returns `insufficient_confidence` with that child's reason.
   - All-or-nothing rejection: if any one child has no usable bid/ask, returns `no_initial_price`.
   - `too_many_markets`: N = 31 children → rejection with count.
   - `inconsistent_close_times`: children disagree on `expected_expiration_time` → rejection.
   - `pair_inconsistent` is no longer reachable — verify no rejection of an Event where children disagree on midpoint.
   - Output row shapes match the schema-derived insert types.

2. **Resolver decision core** (`lib/kalshi/resolve.ts`). Pure `decideEventCommit` function.
   - `wait` when any child is non-terminal and deadline not reached.
   - `commit` with all children resolved on their actual `result` when every child is terminal.
   - `commit` with `cancelled_no_settlement` for unsettled children when `now >= closesAt + 48h`, mixed with `resolved_yes`/`resolved_no` for cleanly-settled siblings.
   - `commit` with every child `cancelled_voided` when every child settled `no`.
   - `commit` with `cancelled_scalar` for an individual child whose Kalshi `result` is `scalar`, alongside normal resolution for siblings.
   - `commit` with mixed cancellation reasons (e.g., one `cancelled_scalar` + one `cancelled_no_settlement` + three `resolved_yes`/`resolved_no`).

3. **AMM** (`lib/amm.ts`). Prior art: existing `amm.test.ts`.
   - `initializePool` produces integer YES/NO reserves matching the requested `initialProbabilityYes` to within one unit, with `k = reserveYes * reserveNo`.
   - `calculateBuy` preserves or grows `k` across every trade (the pool-favoring rounding discipline from ADR-0005).
   - `calculateBuy` against a degenerate pool (one reserve at floor) does not under-pay or panic.
   - `calculatePrices` returns YES + NO = 1 within float tolerance for any pool.
   - Symmetry: buying YES of size `x` mirrors buying NO of size `x` against a symmetric pool.
   - No `calculateSell` export — its absence is verified by the type contract, not a runtime test.

4. **Settlement** (`lib/settlement.ts`). Prior art: existing `settlement.test.ts`.
   - Event-atomic commit: a commit plan with 5 children and 10 distinct holders across them produces exactly one `ResolveMarket` row per child (5 rows), one `SettlePayout` row per (holder, child-with-position), correct balance credits, and the right final statuses on Event and child Markets.
   - Winning holder on a `resolved_yes` child gets `amount = shares` WPM credited; their `SettlePayout` row reflects that.
   - Losing holder on a `resolved_no` child gets `amount = 0` `SettlePayout` row (present, not absent).
   - Holder of a `cancelled_*` child gets `amount = costBasis` refund.
   - Treasury backstop fires per-child: if one child's `wpmReserve` is less than the total winning payouts on that child, the gap is debited from treasury and a `TreasuryBackstop` row is written for that child specifically. A sibling child with healthy reserves does not trigger a backstop.
   - The whole commit is all-or-nothing at the DB level: a simulated failure mid-commit leaves no rows behind.

### Modules with integration-level coverage only

- **Ingest driver**, **server actions**, **data-layer reads**, **UI components**. Covered by a small number of end-to-end tests that exercise the full ingest → bet → resolve loop. Not test-driven in isolation; their correctness is established by the deep-module tests plus the integration smoke.

## Out of Scope

- **Sell-back to the pool.** No `sellShares` action, no `calculateSell` math, no transaction type. ADR-0007 makes this a deliberate product stance, not a future feature.
- **NO-side buys.** Users never directly buy NO-shares of a Market; they buy YES on a sibling Market instead. ADR-0007.
- **Limit orders.** CPMM only supports market orders. ADR-0003.
- **User-provided liquidity (LPs).** Pools are seeded once at Event creation; no add/remove liquidity. ADR-0003.
- **Dual-schema coexistence.** Existing A/B markets are wiped, not migrated. ADR-0006.
- **Partial-Event ingest with backfill.** If any child Kalshi Market fails the confidence gate, the entire Event is rejected; we do not ingest a subset and add the rest later. ADR-0001 / ADR-0006.
- **Blanket-cancel-on-deadline.** When the 48-hour Settlement Deadline elapses with stragglers, we degrade to per-Market — we do not cancel the whole Event. ADR-0008.
- **Indefinite waiting on stragglers.** ADR-0002's deadline invariant is preserved; no Event waits forever for a child Kalshi Market to settle. ADR-0008.
- **A multi-outcome AMM (LMSR or multi-asset CPMM).** Multi-outcome contests are represented as N independent binary CPMMs. ADR-0006.
- **Cross-sibling sum-to-1 enforcement.** Within a single binary Market, `priceYes + priceNo = 1` is AMM-enforced. Across sibling Markets of an Event, sum-to-1 is *not* enforced and drift is expected. ADR-0006.
- **Human-in-the-loop resolution.** Kalshi remains the sole resolution oracle. ADR-0002.

## Further Notes

- This refactor invalidates today's `events`/`markets`/`amm_pools`/`positions`/`transactions` rows. The migration is a full drop-and-recreate; user `balances` and `treasury` are preserved. This is acceptable because the project is at a learning/iteration stage with no production users at risk.
- Eight ADRs in `docs/adr/` describe the load-bearing decisions: 0001 (one-shot discovery, refreshed), 0002 (Kalshi as resolution oracle, refreshed), 0003 (CPMM, refreshed), 0004 (positions as immutable ledger, refreshed), 0005 (integer-native AMM, refreshed), 0006 (multi-outcome via grouped binaries, new), 0007 (buy-YES-only, new), 0008 (per-Event synchronized resolution, new). The PRD is descriptive of *what* changes; the ADRs are normative on *why*.
- `CONTEXT.md` has been rewritten to reflect the new vocabulary end-to-end. The A/B model is retired; `Outcome` as a domain noun is retired; `Sell` is retired as a capability.
- Two values are tunable but baked-in as constants for v1: `MAX_SPREAD = 0.1` per Market (unchanged), `MAX_MARKETS_PER_EVENT = 30`, `SETTLEMENT_DEADLINE = 48h` (unchanged). All three are candidates for revisit once real Events exercise them.
- Cron cadence remains load-bearing under the new model: an Event whose children's Kalshi quotes intermittently fail the spread gate may never ingest. The current 30-minute cadence (per ADR-0001) is preserved.
