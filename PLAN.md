# Implementation Plan: Multi-Outcome Markets

> Source: `docs/prd/multi-outcome-markets.md`
> Generated: 2026-05-11

> **Assumption:** Schema migration is a full drop-and-recreate of `events`/`markets`/`amm_pools`/`positions`/`transactions` (PRD §Further Notes). `balances` and `treasury` preserved. No production users — destructive migration is acceptable.

> **Assumption:** `MAX_MARKETS_PER_EVENT = 30`, `MAX_SPREAD = 0.1`, `SETTLEMENT_DEADLINE = 48h` are baked-in constants for v1 (PRD §Further Notes).

---

## Phase 0 — Tracer Bullet(s)
> Two thinnest end-to-end slices, exercising the two distinct subsystems: (1) ingest → bet → resolve loop for a single 2-Market binary Event; (2) translator handling of an N>2 Kalshi Event.

### Slice 1: Binary Event end-to-end (ingest → bet YES → Event-commit)
- [x] Add new `events` table to `src/lib/db/schema/app.ts` with columns per PRD §Schema; keep old columns reachable temporarily for compile.
- [x] Reshape `markets` table in the schema: drop `sport`/`teamA`/`teamB`/`tickerA`/`tickerB`/`closesAt`/`resolvedOutcome`; add `eventId`/`name`/`ticker`/`resolvedAs`. Move `sport` to `events`.
- [x] Rename `ammPools.reserveA/B` → `reserveYes/No`; collapse `positions` to `(userId, marketId, shares, costBasis)`; drop `SellShares` from `transactionTypes`.
- [x] Regenerate single migration `src/lib/db/migrations/0000_*.sql` (full wipe of the 5 tables) and update `0000_snapshot.json`/`_journal.json`.
- [x] Rewrite `translateKalshiEvent` happy path: 2-Market Kalshi Event → `{ event: EventInsertRow, markets: [{market, seedAmount, initialProbabilityYes}, ...] }` discriminated union (no `non_binary` rejection).
- [x] Update `createMarket` (rename to `createEvent` in `data/events.ts`): insert one `events` row + N `markets` rows + N `ammPools` rows in a single DB transaction; per-Market `initializePool` seeding.
- [x] Rewrite `placeBet` in `data/trading.ts`: signature `(marketId, amount)` — buy YES only; reads pool with `reserveYes/No`, calls new `calculateBuy(pool, amount)` (YES-only), writes `positions.shares`.
- [x] Update `decideEventCommit(wampumEvent, kalshiResponse, now)` pure function in `lib/kalshi/resolve.ts`: returns `wait` or `commit` plan; happy path = all children terminal → resolve-per-`result`.
- [x] Wire resolver: select from `events WHERE status='open' AND closesAt < now`; per-series batch fetch; apply commit plan in one DB transaction per Event.
- [x] Adapt `computeSettlement` to operate over a commit plan + cross-child positions/pools → per-child payouts in one batch; rewire `resolveMarket`/`cancelMarket` into a single `commitEvent`.
- [x] Update `placeBet` server action (`src/actions/placeBet.ts`): drop `outcome` from Zod schema; delete `src/actions/sellShares.ts`.
- [x] Smoke test: spin up DB, ingest a 2-Market Kalshi fixture, place a YES buy on one child, force-commit the Event with both children settled, verify balance credit + Event/Market statuses + `SettlePayout` rows.

### Slice 2: Multi-outcome Kalshi Event ingest (N>2)
- [x] Author a new fixture `src/lib/kalshi/fixtures/multi-outcome-healthy.json` with 5 nested Kalshi Markets sharing one `expected_expiration_time`.
- [x] Translator path: iterate all `event.markets`, apply per-Market spread gate independently, build N `markets` rows under one `events` row.
- [x] All-or-nothing rejection: if any child fails spread gate, return `insufficient_confidence` with per-child reasons.
- [x] Wire ingest driver to handle N children: persist one Event + N Market rows + N pools atomically in a single `db.transaction`.
- [x] Smoke test: ingest 5-Market fixture, verify one `events` row and 5 `markets`/`amm_pools` rows are created with correct per-Market `initialProbabilityYes`.

---

## Phase 1 — Schema, Types, AMM Core

### Schema migration
- [ ] Delete obsolete columns from `app.ts`: `markets.sport/teamA/teamB/tickerA/tickerB/closesAt/resolvedOutcome`, `ammPools.reserveA/B`, `positions.sharesA/B`.
- [ ] Add `events` table: `id`/`sport`/`name`/`closesAt` (bigint)/`status: 'open' | 'terminal'`/`createdAt`.
- [ ] Update `markets`: `eventId` FK, `name`, `ticker`, `status: 'open' | 'resolved' | 'cancelled'`, `resolvedAs: 'yes' | 'no' | null`, `resolvedAt`, `createdAt`.
- [ ] Add `eventRelations` and update `marketRelations` to one-to-many `event → markets`.
- [x] Replace `ix_markets_status_closes` with `ix_events_status_closes` on `(events.status, events.closesAt)`. Keep `ix_positions_market`.
- [x] Drop `SellShares` from `transactionTypes`.
- [ ] Regenerate migration SQL; verify `bun drizzle-kit generate` produces a clean single-file migration. Append `treasury` seed to the new migration via `src/lib/db/seeds/append-to-migrations.ts`.

### Type purges
- [ ] `src/lib/types.ts`: delete `SellShares` transaction variant; remove `"A" | "B"` from `PlaceBet`/`SettlePayout`/`ResolveMarket` payloads.
- [ ] Add `Event` domain type with `markets: Market[]`. Reshape `Market` to `{ id, eventId, name, status, resolvedAs }` (no `sport`/`outcomes`/`result`).
- [ ] Replace `AMMPool.sharesA/B` with `reserveYes/No`; update `SharePosition` to flat `{ userId, marketId, shares, costBasis }`.
- [ ] Update `MarketWithOdds` to single-side: `priceYes`/`multiplierYes` (no NO needed since `priceNo = 1 - priceYes`).
- [ ] Update `SPORTS` array stays on `Event`, not `Market`.

### AMM rewrite (`lib/amm.ts`)
- [x] Rename internal symbols: `sharesA/B` → `reserveYes/No`, `initialProbabilityA` → `initialProbabilityYes`.
- [ ] `initializePool(marketId, seedAmount, initialProbabilityYes)` returns `{ marketId, reserveYes, reserveNo, k, liquidity }`.
- [x] `calculateBuy(pool, amount)` — drop `outcome` param; always buys YES (NO is the retained side). Preserve ceil-div rounding (ADR-0005).
- [x] `calculatePrices(pool)` → `{ priceYes, priceNo }` where `priceYes + priceNo = 1`.
- [x] `calculateOdds(pool)` → `{ priceYes, priceNo, multiplierYes, multiplierNo }`.
- [x] Delete `calculateSell` and `isqrt`. Remove their exports from any consumer.

---

## Phase 2 — Translator & Ingest

### Translator (`lib/kalshi/translator.ts`)
- [ ] New return type: `{ kind: 'ok', value: { event, markets: TranslatedMarket[] } }` where `TranslatedMarket = { market, seedAmount, initialProbabilityYes }`.
- [ ] Drop `non_binary` and `pair_inconsistent` variants entirely.
- [x] Add `too_many_markets` variant: `{ kind: 'too_many_markets', count: number }` when `markets.length > 30`.
- [x] Add `inconsistent_close_times` variant when any child's `expected_expiration_time` differs from first.
- [ ] Per-Market spread gate: collect failing `{ ticker, reason }` per child; if any fail return `insufficient_confidence` with aggregated per-Market reasons. Aggregate `no_initial_price` if any child has no usable quote.
- [ ] Source `events.closesAt` from `markets[0].expected_expiration_time`; verify all siblings match exactly (else `inconsistent_close_times`).
- [ ] Derive `TranslatedEventRow` and `TranslatedMarketRow` from drizzle `$inferInsert`.
- [x] Delete `translateKalshiResolution` from this file — its replacement (`decideEventCommit`) lives in `resolve.ts`.

### Translator tests (`translator.test.ts`)
- [ ] Rewrite: 2-Market happy path → one Event + 2 Markets, both `initialProbabilityYes` correct.
- [x] Rewrite: 5-Market happy path → one Event + 5 Markets, all consistent.
- [ ] Rejection: any child wide spread → `insufficient_confidence` with that child's ticker in reasons.
- [ ] Rejection: any child missing bid/ask → `no_initial_price`.
- [ ] Rejection: 31 children → `too_many_markets` with count.
- [ ] Rejection: siblings disagree on `expected_expiration_time` → `inconsistent_close_times`.
- [ ] Verify `pair_inconsistent` is no longer reachable (children with disagreeing midpoints translate fine).
- [ ] Output row shapes match schema-derived insert types (compile-time check).
- [x] Remove fixtures `non-binary.json` and `pair-inconsistent.json`; add `multi-outcome-healthy.json` and `multi-outcome-wide-spread.json`.

### Ingest driver (`lib/kalshi/ingest.ts`)
- [ ] Update `SkipReasonKind` union: remove `non_binary`; add `too_many_markets`, `inconsistent_close_times`. Keep `unparseable_close_time`, `no_initial_price`, `insufficient_confidence`, `already_exists`.
- [ ] Call new `createEvent({ event, markets })` from `data/events.ts`; one DB transaction per Event.
- [x] Update summary structure to reflect Event-level counters (`createdEvents` / `createdMarkets`).

---

## Phase 3 — Resolver & Settlement

### Resolver decision core (`lib/kalshi/resolve.ts`)
- [ ] Extract pure `decideEventCommit(wampumEvent, kalshiResponse, now)` returning `{ kind: 'wait' } | { kind: 'commit', perChild: ChildOutcome[] }`.
- [ ] `ChildOutcome` = `{ marketId, outcome: 'resolved_yes' | 'resolved_no' | 'cancelled_voided' | 'cancelled_scalar' | 'cancelled_no_settlement' }`.
- [ ] Happy path: every child terminal → map each child's Kalshi `result` to `resolved_yes`/`resolved_no`/`cancelled_scalar`.
- [x] Void semantics: all children settled `no` → all `cancelled_voided`.
- [x] Deadline degradation: `now >= closesAt + 48h` AND any non-terminal child → unsettled children get `cancelled_no_settlement`, cleanly-settled siblings resolve on their `result`.
- [ ] Wait: at least one non-terminal child AND deadline not reached → `{ kind: 'wait' }`.

### Resolver driver
- [ ] Selection: `events WHERE status='open' AND closesAt < now`.
- [ ] Group selected Events by Kalshi series. One bulk call per series via `getEvents({ event_tickers: [...] })` — if SDK lacks bulk param, keep concurrent per-ticker fan-out and document the limitation.
- [ ] Per Event: call `decideEventCommit`; on `commit`, pass plan + cross-child positions + cross-child pools to `commitEvent` in `data/events.ts`.
- [ ] Drop `dispatch` switch in favor of plan-driven `commitEvent`.
- [ ] Summary counters: per-Event statuses (`waited`/`committed`) plus per-child outcome counts (`resolved_yes`/`resolved_no`/`cancelled_*`).

### Resolver decision tests
- [x] `wait` when any child non-terminal and deadline not reached.
- [x] `commit` with all children `resolved_yes`/`resolved_no` when every child terminal.
- [x] `commit` with mixed `cancelled_no_settlement` + `resolved_*` past the deadline.
- [x] `commit` with all `cancelled_voided` when every child settled `no`.
- [x] `commit` with `cancelled_scalar` on a single child alongside normally-resolved siblings.
- [x] `commit` with mixed (`cancelled_scalar` + `cancelled_no_settlement` + 3 `resolved_yes`/`resolved_no`).

### Settlement (`lib/settlement.ts`)
- [ ] `computeSettlement` takes commit plan + per-child positions + per-child pools → returns per-child payouts list, per-child backstop deltas, and final statuses.
- [ ] Per child: `resolved_yes` → 1 WPM per share for YES-holders, 0 for losers (still emit `SettlePayout` row with `amount=0`).
- [ ] Per child: `resolved_no` → all holders `amount=0` (emit row).
- [ ] Per child: `cancelled_*` → refund `costBasis` per holder.
- [ ] Per-child `TreasuryBackstop` row when `wpmReserve < totalWinningPayouts` for that child only.
- [ ] One `ResolveMarket` row per child (regardless of outcome variant — including cancellations? clarify in PRD: PRD §Settlement says "one ResolveMarket per child Market in the commit").
- [ ] Final status updates: `events.status='terminal'`; per-child `markets.status='resolved'|'cancelled'` with `resolvedAs` set on resolved children, `resolvedAt=now`.

### Settlement tests (`settlement.test.ts`)
- [ ] Event-atomic commit: 5 children × 10 holders → 5 `ResolveMarket` rows + one `SettlePayout` per (holder, child-with-position) + correct credits + correct statuses.
- [ ] Winner on `resolved_yes`: `amount = shares` WPM.
- [ ] Loser on `resolved_no`: `amount = 0` `SettlePayout` row present.
- [ ] Holder on `cancelled_*`: `amount = costBasis` refund.
- [ ] Per-child treasury backstop fires only on under-collateralised child; sibling with healthy reserves does not trigger.
- [ ] Simulated mid-commit failure leaves no rows behind (DB transaction rollback).

### AMM tests (`amm.test.ts`)
- [ ] Adapt existing tests to `reserveYes/No` naming; drop `outcome` param from `calculateBuy` cases.
- [ ] `initializePool` produces integer YES/NO reserves matching `initialProbabilityYes` to within one unit.
- [ ] `calculateBuy` preserves/grows `k` across every trade.
- [ ] `calculateBuy` against degenerate pool (one reserve at floor) does not under-pay/panic.
- [ ] `calculatePrices` returns `priceYes + priceNo = 1` within float tolerance.
- [x] Remove `calculateSell` and `isqrt` test cases (their absence is the type contract).

---

## Phase 4 — Data Layer & Server Actions

### Data layer
- [ ] Create `src/data/events.ts`: `getEvent(id)` (with child markets + pools), `getEvents()` (homepage list), `createEvent({event, markets})`, `commitEvent(plan)`.
- [ ] Reshape `src/data/markets.ts`: `getMarket(id)` reads market + parent Event + pool; remove `createMarket`/`resolveMarket`/`cancelMarket` (moved to `events.ts`).
- [x] `src/data/trading.ts`: `placeBet({marketId, amount})` — outcome dropped; reads `reserveYes/No`; writes flat `positions.shares`. Delete `sellShares` function entirely.
- [ ] `src/data/positions.ts`: collapse `getPositions` to one row per `(user, market)` with non-zero shares; filter to `markets.status = 'open'` for live positions.
- [ ] `getBetHistory`: replace `sharesA`/`sharesB`/`outcomes`/`resolvedOutcome` with `shares`/`marketName`/`resolvedAs`; join through `events` for `closesAt`/`sport`.
- [ ] Update cache tags: `tags.event(id)` alongside `tags.market(id)`; revalidate both on bet placement and Event commit.

### Server actions
- [ ] `src/actions/placeBet.ts`: drop `outcome` from Zod schema; revalidate market + event + viewer tags.
- [ ] Delete `src/actions/sellShares.ts`.
- [ ] No new resolver action exposed externally (cron stays the entry point).

---

## Phase 5 — UI

### Event detail page
- [ ] Rename `src/app/(app)/market/[id]/page.tsx` → `event/[id]/page.tsx`. Update parallel intercepting route `(.)market/[id]` → `(.)event/[id]`.
- [ ] Render parent Event header (name, sport, closesAt, status) + N child Markets in a vertical list.
- [ ] Each child Market row shows YES-side name (`yes_sub_title`), price/multiplier, and a single "Buy YES" affordance.
- [ ] Drop outcome toggle in bet form; bet form takes only `marketId` + `amount`.

### Market list / homepage
- [ ] Update `src/components/market-list.tsx` to group `MarketWithOdds[]` by `eventId`. Render one card per Event.
- [ ] Binary Event card: two child Markets side-by-side.
- [ ] Multi-outcome Event card: top N children by liquidity/probability with overflow count.

### Bet controls / drawer
- [ ] `src/components/bet-controls.tsx`: remove A/B toggle; single "Buy YES" button per Market.
- [ ] `src/components/market-drawer.tsx`: render child Markets list with per-Market buy affordances.
- [ ] `src/components/market-card.tsx`, `market-detail.tsx`, `market-item.tsx`, `live-odds.tsx`: purge `priceA/B`/`multiplierA/B`/`teamA/B`/`outcome` and rewire to `priceYes`/`multiplierYes`/`name`.

### Position list / portfolio
- [ ] `src/components/portfolio.tsx`: one row per `(user, market)` with non-zero shares.
- [ ] Add Event aggregation view: group child rows under a parent Event header showing total stake.

### Bets history page
- [ ] `src/app/(app)/bets/page.tsx`: render flat list per Market with `marketName`, `resolvedAs`, `shares`, `costBasis`, `settledAmount`.
- [ ] No "sell" button anywhere — verify no UI affordance survives the refactor.

---

## Phase 6 — Cleanup & Integration

### Documentation
- [ ] Update `CONTEXT.md` to reflect new vocabulary (Event/Market/YES-only).
- [ ] Confirm ADRs 0006/0007/0008 are committed (already in worktree as untracked files per `git status`).

### Integration test
- [ ] Update `tests/integration/bet-and-resolve.test.ts` to: ingest a 2-Market fixture → place YES bet → Event-commit at deadline → verify balance, payout rows, Event/Market statuses.
- [ ] Add second integration scenario: 3-Market multi-outcome Event with one `cancelled_scalar` child and two normally-resolved children.

### E2E
- [ ] Spot-check `tests/e2e/signup-airdrop.spec.ts` for stale market/A-B references; update fixtures only if needed.

### Fixture & dead-code purge
- [ ] Delete `src/lib/kalshi/fixtures/non-binary.json` and `pair-inconsistent.json`.
- [ ] Grep codebase for residual `teamA`/`teamB`/`sharesA`/`sharesB`/`outcome: "A"`/`"A" | "B"`/`SellShares`/`calculateSell`/`isqrt` and eliminate every match.
- [ ] Re-run `bun typecheck` and `bun test` until clean.
