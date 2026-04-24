# PRD: Kalshi → Wampum Resolution Pipeline

## Problem Statement

Wampum can ingest binary-moneyline Kalshi Events into internal Markets and accept bets against them, but it cannot *finish* a Market. After a game ends, every open Market we've created sits in `status = 'open'` indefinitely — `closesAt` has passed, trading is refused at the data layer, but no code path exists to read Kalshi's settled result and transition the Market to `resolved` or `cancelled`. Users whose positions would have paid out see their winning shares stranded; users whose teams lost see the market unresolved and their capital locked. The persistence functions `resolveMarket(marketId, outcome)` and `cancelMarket(marketId, reason)` exist and are correct, but they have no caller.

Three specific gaps compound this:

1. **No Kalshi-side reader for settlement data.** The existing `KalshiMarketSchema` captures fields useful at ingest time (`yes_bid_dollars`, `expected_expiration_time`) but omits any settlement-time fields. There is no translator that reads a settled Kalshi Event and emits a domain-shaped decision. There is no orchestrator that decides *which* Markets to ask Kalshi about or *when*.

2. **No strategy for "Kalshi never settled this."** Real-world events are cancelled, postponed indefinitely, or simply orphaned by Kalshi. Without a bounded retry policy, a Wampum Market with an orphaned upstream would remain `open` forever, with user WPM locked in positions that can never resolve or refund.

3. **A latent schema/code disagreement about lifecycle.** The `markets.status` enum declares a `"closed"` value that no code path ever writes, and nothing reads it as distinct from `"open"`. Trading checks `status = 'open' AND Date.now() < closesAt`. Until this is resolved, any new resolution code either ignores the enum value (perpetuating the lie) or introduces a close-sweep job to justify it (code added to match a doc rather than a need). The resolution pipeline forces a decision on which reading is authoritative.

A secondary problem: the existing `oracle_heartbeats` table has a `"resolve"` slot wired into the data-layer read and write functions, but no code ever calls `recordHeartbeat`. This is dead scaffolding from an earlier abandoned attempt and has been misleading maintainers about what observability actually exists.

## Solution

Build a resolution pipeline that mirrors the architectural shape of the ingestion pipeline — three layers with explicit boundaries, typed skip reasons, and Kalshi knowledge confined to a single contract layer. Commit to **Kalshi as the sole resolution oracle** (extending the one-shot-discovery stance from ADR-0001 to the terminal moment), and adopt a bounded **Settlement Deadline** so Markets can never become permanently locked.

From the developer's perspective, after this change:

- Every Wampum Market past `closesAt` gets resolved or cancelled within 30 minutes of Kalshi posting a settlement, without human intervention.
- Kalshi is consulted exactly twice per Market over its lifetime: once at creation (pricing seed, per ADR-0001) and once after close (winning outcome). Never more.
- A pure translator function owns the mapping from Kalshi Settlement shape → Wampum Resolution decision, tested exhaustively against fixture JSON with no I/O.
- An orchestrator function owns the "what do I ask Kalshi about?" selection, the 48h deadline policy, and the dispatch to `resolveMarket` / `cancelMarket`.
- The `markets.status` enum is brought in line with how it's actually used (`open → resolved | cancelled`, no `closed`).
- The dead `oracle_heartbeats` write path stays dead; cron response JSON is the observability surface, matching ingest.

From the user's perspective:

- After their team wins, their winning shares convert to WPM in their balance within at most 30 minutes of Kalshi posting the settlement.
- If Kalshi voids the event, their cost basis is refunded automatically.
- If Kalshi never settles (48h past close), their cost basis is refunded rather than locked indefinitely.

## User Stories

1. As a player holding winning shares in a resolved Kalshi Event, I want my payout credited to my WPM balance within 30 minutes of Kalshi posting the settlement, so that I can see my earnings and use them to bet on the next game.

2. As a player holding shares in a Kalshi Event that got voided (e.g. weather cancellation), I want my cost basis refunded automatically, so that I don't have to chase support for a manual refund.

3. As a player holding shares in a Kalshi Event that Kalshi has failed to settle 48 hours after close, I want my cost basis refunded automatically, so that my capital is never locked indefinitely by an upstream failure.

4. As a player, I want Wampum's resolution decisions to match Kalshi's settlement decisions with no human-in-the-loop step, so that my payouts are timely and predictable.

5. As a developer modifying Kalshi's payload schema, I want the Zod schema to remain the single source of truth for both ingest-time and settlement-time fields, so that one file captures everything we accept from the upstream API.

6. As a developer writing resolution translator logic, I want a pure function that takes a parsed Kalshi Event and returns a typed decision, so that every settlement case — winner on A, winner on B, both-no void, still-pending, ambiguous, missing — can be tested exhaustively against fixture JSON with no database or network dependency.

7. As a developer, I want the translator to return a discriminated union of domain-shaped outcomes, so that the orchestrator's dispatch is exhaustive at the type level and adding a new variant produces compile-time errors at every call site.

8. As a developer reading the translator, I want no `Date.now()` or wall-clock reference inside it, so that its tests are deterministic and its behavior is a pure function of the Kalshi payload.

9. As a developer, I want the 48-hour Settlement Deadline policy enforced in the orchestrator rather than the translator, so that changing the deadline value (including to a per-sport value in the future) is a business-logic change in a business-logic module.

10. As a developer, I want the orchestrator to be Wampum-driven — selecting Markets to resolve from our own database rather than enumerating Kalshi's settled events — so that the set of work is explicit, bounded, and trivially integrates deadline enforcement.

11. As a developer, I want the orchestrator to batch its Kalshi calls by series using the existing `/events?event_tickers=...` filter, so that resolving N Markets across 4 series costs 4 HTTP requests rather than N.

12. As a developer, I want `resolveMarket` and `cancelMarket` to remain untouched by this work, so that their existing contracts and idempotency guarantees are unchanged and persistence tests don't need revisiting.

13. As an operator running the resolution cron, I want the endpoint to return a summary reporting how many Markets were considered, how many resolved, how many cancelled (split by reason), and how many skipped (split by translator-level reason), so that I can distinguish "Kalshi hasn't settled yet" from "Kalshi returned something we couldn't interpret."

14. As an operator investigating a cancellation, I want `kalshi_voided` and `kalshi_no_settlement` recorded as distinct `reason` strings in the `CancelMarket` transaction payload, so that grepping the transaction log tells me why any given Market died.

15. As an operator, I want the resolution cron to run every 30 minutes (same cadence as ingest), so that user-visible lag between Kalshi settlement and Wampum payout is bounded at 30 minutes without running more often than Kalshi themselves post settlements.

16. As an operator, I want the resolution endpoint to use the same bearer-token auth pattern as the ingest cron, so that Vercel's scheduled-job invocation is the only authorized caller.

17. As an operator, I want re-running the resolution cron immediately after a successful run to produce no duplicate resolutions, payouts, or cancellations, so that retries and overlapping runs are safe. The existing `resolveMarket` and `cancelMarket` already return `already_resolved` / `already_cancelled` states; the orchestrator's summary surfaces these as no-ops rather than errors.

18. As an operator, I want Markets whose Kalshi Event is reported as settled with both nested markets `result = "no"` to be treated as voided (cancelled with reason `kalshi_voided`) rather than left pending, so that Kalshi's documented void convention is honored immediately rather than caught 48 hours later by the deadline sweep.

19. As an operator, I want a Kalshi response that returns zero events for a requested ticker (event deleted / unknown upstream) classified as a typed `kalshi_event_missing` skip rather than an exception, so that one broken ticker doesn't abort the cron run for the other Markets.

20. As an operator, I want the resolution orchestrator's failures to be surfaced as a non-200 response with an error message, mirroring the ingest route's behavior, so that Vercel's cron log reflects run health.

21. As a developer maintaining the schema, I want the `"closed"` value removed from the `markets.status` enum so that the enum reflects the actually-used lifecycle (`open → resolved | cancelled`) and new readers aren't misled into thinking there's an intermediate state.

22. As a developer extending Kalshi's `KalshiMarketSchema`, I want the `result` field to be `z.enum(["yes","no",""])` with `optional()` and `.default("")` applied, so that pre-settlement responses (where Kalshi may omit the field) continue to parse cleanly and the empty string is the sentinel for "not yet settled."

23. As a developer maintaining the contract test, I want the existing live-Kalshi schema assertion extended to verify the `result` field's presence-or-absence shape, so that upstream changes to this field would be caught by CI the same way ingest-time field changes are.

24. As a future maintainer reading the codebase, I want the decision to use Kalshi as the sole resolution oracle (including the rejection of human-in-the-loop, the both-no void convention, the 48h deadline, and the rejection of a stored `closed` state) recorded in an ADR, so that the code's intent is discoverable without reverse engineering.

25. As a future maintainer, I want the CONTEXT.md vocabulary extended with **Kalshi Settlement**, **Settlement Deadline**, and the clarified definitions of **Resolution** and **Cancellation**, so that the Kalshi-vs-Wampum "settlement" language collision is preempted and the cancellation triggers are explicit.

26. As a future maintainer, I want the dead `oracle_heartbeats` write path (defined in `data/oracle.ts` but never called) left intentionally unwired by this work, so that this PRD's scope stays focused on the resolution pipeline and doesn't accrete an observability-scaffolding subproject.

27. As a developer, I want the Kalshi-side drive rejected in favor of Wampum-side drive, so that no `unknown_market` skip case is structurally possible — we never ask about events we don't own.

28. As a developer, I want the resolution translator co-located with the ingest translator in the same `translator.ts` file, so that shared helpers (e.g. a Kalshi-status terminality predicate) have a natural home and the two functions' symmetry is visible at the module level.

## Implementation Decisions

### Architectural shape: three layers, mirroring ingestion

- **API contract layer** (existing `index.ts`) gains one field on `KalshiMarketSchema`: `result: z.enum(["yes","no",""]).optional().default("")`. No other schema changes. No new endpoint wrapper — the existing `/events` endpoint with `with_nested_markets=true` serves both ingest and resolution reads.
- **Translator layer** (existing `translator.ts`) gains a second exported pure function, `translateKalshiResolution`, that takes a parsed `KalshiEvent` and returns a discriminated-union `ResolutionTranslation` result. No I/O, no clock, no business policy. Shared helpers (e.g. a Kalshi-status terminality predicate) live alongside the existing `translateKalshiEvent`.
- **Orchestration layer** (new `resolve.ts`) owns: selecting past-close Markets from Wampum's DB, grouping their Kalshi tickers by series, making one `/events?series_ticker=X&event_tickers=T1,T2,...&with_nested_markets=true` call per series, zipping Kalshi's response back to our rows by event ticker, calling the translator, escalating `not_settled_yet` to `stale_unresolvable` past the 48-hour deadline, dispatching to `resolveMarket` / `cancelMarket`, and aggregating a summary.

The two existing persistence functions are deep modules whose interfaces are unchanged. They are the only database writers in this flow.

### Translator output taxonomy

`translateKalshiResolution` returns one of six discriminated variants:

- `resolved_a` — market A settled `yes`, market B settled `no`, both in a terminal Kalshi status.
- `resolved_b` — market B settled `yes`, market A settled `no`, both in a terminal Kalshi status.
- `voided` — both markets settled `no` in a terminal Kalshi status (Kalshi's convention for void).
- `not_settled_yet` — at least one market is not yet in a terminal Kalshi status.
- `ambiguous` — both markets are terminal but the results don't fit the above patterns (e.g. both `yes`, or one terminal with a malformed result). Should be structurally impossible for a binary-moneyline event; surfaced as a loud skip rather than silently swallowed.
- `kalshi_event_missing` — Kalshi returned no event matching our requested ticker (event deleted / unknown upstream).

The orchestrator adds a seventh effective outcome, `stale_unresolvable`, by escalating any `not_settled_yet` whose Market's `closesAt` is more than 48 hours in the past. This does not appear in the translator's union.

### Kalshi-status terminality

"Terminal" means the market has a readable result. The predicate treats `settled`, `finalized`, and `determined` as equivalent-for-our-purposes (Kalshi has shifted terminology over time). Any other status — `initialized`, `active`, `closed`, or an unknown string — is non-terminal. The predicate is a helper, not a public export.

### Void is inferred from both-NO, not signalled explicitly

Kalshi has no dedicated `voided` market status. Their void convention is both nested markets settling with `result = "no"`. The translator maps this directly to the `voided` variant. The alternative — waiting for an explicit signal that doesn't exist — would route legitimate voids through the 48-hour deadline path and delay refunds by two days.

### Settlement Deadline policy

48 hours past a Market's `closesAt` without a Kalshi Settlement → the orchestrator calls `cancelMarket(marketId, "kalshi_no_settlement")`. The policy intentionally trades two failure modes against each other: mis-cancelling a slow-to-settle legitimate market vs. leaving user positions locked indefinitely. We accept the former to eliminate the latter. The 48h constant lives in the orchestrator module. It is not per-sport in this pass but is structurally easy to make per-sport later.

### Cancel reason strings

- `kalshi_voided` — translator returned `voided`.
- `kalshi_no_settlement` — orchestrator escalated `not_settled_yet` past the Settlement Deadline.

Both strings land in the `CancelMarket` transaction payload's `reason` field via the existing `cancelMarket(marketId, reason)` parameter. No schema change to the transactions table.

### Orchestrator selection query

The orchestrator's DB query for work is `SELECT * FROM markets WHERE status = 'open' AND closesAt < now()`. The existing `ix_markets_status_closes` composite index serves this query. Rows are grouped in memory by `sport` (which maps to a Kalshi series ticker), then each group is fetched from Kalshi in a single batched call.

### Kalshi HTTP shape

One request per Kalshi series per cron run. URL pattern: `${KALSHI_BASE_URL}/events?series_ticker={SERIES}&event_tickers={T1,T2,...}&with_nested_markets=true`. If Kalshi's list endpoint silently ignores the `event_tickers` filter and returns more than requested, the orchestrator's by-ticker zip is defensive and filters to the requested set. If the endpoint rejects the param with a 400, we fall back to N single-event fetches using `${KALSHI_BASE_URL}/events/{event_ticker}?with_nested_markets=true` with a bounded Promise.all concurrency cap; this fallback is the implementation's responsibility to verify against live Kalshi before merging.

### Summary shape

```
SeriesResolveSummary {
  considered: number,              // past-close Wampum Markets in this series
  resolved: number,                // resolved_a + resolved_b, confirmed by resolveMarket
  cancelled: number,               // voided + stale_unresolvable, confirmed by cancelMarket
  skipped: Record<SkipReason, number>,
  // SkipReason: not_settled_yet | ambiguous | kalshi_event_missing | already_resolved | already_cancelled
}

KalshiResolveSummary {
  bySeries: Record<string, SeriesResolveSummary>,
  totals: { considered, resolved, cancelled, skipped: Record<SkipReason, number> },
}
```

`already_resolved` and `already_cancelled` counters sit at the orchestrator level, tracking idempotent no-ops from the persistence layer (Markets that are already in a terminal state when the cron runs — safe and expected during overlapping runs, but visible in the summary for diagnosis).

### Schema changes

- Drop `"closed"` from the `markets.status` enum via a drizzle migration. No data migration required: no row has ever been written with this value.
- No other schema changes. No new tables. No changes to `transactions`, `amm_pools`, `positions`, `balances`, `treasury`, or `oracle_heartbeats`.

### API / integration contract

- Existing Kalshi endpoint reused. No new endpoint wrappers.
- Existing `KalshiEventsResponse` Zod type reused as the orchestrator's parsed response.
- Existing bearer-token auth pattern (`CRON_SECRET` env var) reused at the new cron route.

### Observability

- Cron response JSON is the observability surface. No heartbeat writes.
- The existing `oracle_heartbeats` write path (`recordHeartbeat`, `getOracleHeartbeats`) is dead code and stays dead. This PRD does not remove it, but any future observability work should take it as a greenfield decision rather than assuming the current scaffolding is alive.

### Operational change

- Add a new Vercel cron entry at `*/30 * * * *` hitting `/api/cron/resolve`. The ingest cron is unchanged.

## Testing Decisions

### What makes a good test in this codebase

Tests verify behavior through public interfaces, not implementation details. A translator test should assert on the translator's discriminated-union return value given realistic input, never on how the translator decomposes the work internally or which helpers it calls. An orchestrator test should assert on the database state and the aggregated summary after calling `runKalshiResolve`, never on which internal helpers were invoked or in what order. Fixtures are captured from real Kalshi responses and checked into the repo so tests are offline and deterministic.

### Translator — primary test target

The translator is the central testable artifact introduced by this refactor and receives the most thorough coverage. Tests are fixture-driven — small JSON payloads shaped like real Kalshi responses for settled/pending events are checked in next to the tests and replayed offline.

Fixtures explicitly include:

- a binary-moneyline event where both sides are terminal, A `yes` / B `no` (happy path: `resolved_a`),
- the symmetric B `yes` / A `no` (happy path: `resolved_b`),
- a binary-moneyline event where both sides settled `no` (`voided`),
- an event where at least one side is still in a non-terminal Kalshi status (`not_settled_yet`),
- an event where both sides are terminal but both `yes`, or one has a malformed result (`ambiguous`),
- and a minimal case standing in for `kalshi_event_missing` — where the orchestrator requested a ticker and the response contained zero matching events (tested at the orchestrator layer; at the translator layer there is no "missing" input, so this variant is emitted by the orchestrator's zip step).

The happy-path assertions check every field of the discriminated-union result, not just the `kind`.

### Orchestrator — integration tested, single-pass coverage

A single integration test covers the full orchestrator flow: set up a mixed DB state (Markets that will resolve A, resolve B, be voided, be stale-cancelled, be `not_settled_yet`, be `kalshi_event_missing`, and be `already_resolved` from a prior run), mock `fetch` to return Kalshi responses that together cover every branch, run `runKalshiResolve`, then assert on:

- the returned summary counts per category,
- the `markets` table's status/resolvedOutcome/resolvedAt for each test row,
- the relevant `balances` and `treasury` mutations,
- the `transactions` table entries (both `SettlePayout` or `CancelMarket` as appropriate, with correct `reason` strings).

This test uses the real test database and a mocked `fetch`, matching the pattern already established in the codebase's test infrastructure.

### Contract test — extended

The existing `kalshi.contract.test.ts` stays as-is in spirit. It gains an assertion that each market's `result` field is either absent, `""`, `"yes"`, or `"no"` — catching any upstream shape change.

### Persistence — not retested

`resolveMarket` and `cancelMarket` are unchanged in this PRD. Their existing tests (if any) stand. This PRD neither adds nor modifies persistence-layer test coverage.

### Prior art

The ingest pipeline's test structure is the direct template:

- `src/lib/kalshi/translator.test.ts` — fixture-driven translator tests with one fixture per skip reason and a full happy-path shape assertion. The resolution tests live in the same file, extending rather than duplicating this pattern.
- `src/lib/kalshi/kalshi.contract.test.ts` — live-network contract test asserting Zod shape. Extended with the `result` assertion.
- Fixture JSON captured into `src/lib/kalshi/fixtures/` and referenced from the translator test. The resolution fixtures join the existing `binary-healthy.json`, `non-binary.json`, `unparseable-close-time.json`, `zero-spread.json` set.

## Out of Scope

- **Disabling `sellShares`.** The existing sell path produces an asymmetry in cancellation refunds (a partial seller gets refunded less than the current market value of their remaining shares). This asymmetry is tolerable under the existing cost-basis refund semantics, and removing sell is a trading-policy decision with independent motivation. It is explicitly tracked as a separate concern; the resolution pipeline works correctly whether sell is enabled or not.
- **Per-sport Settlement Deadline.** 48h is a single global constant in this pass. Per-sport values (e.g. 24h for daily NFL, 72h for multi-day playoffs) are a future tuning exercise and require only a small orchestrator change.
- **Admin override / human-in-the-loop approval.** Explicitly rejected in ADR-0002. Any future feature along these lines would require revisiting that ADR first.
- **Retry/backoff on transient Kalshi errors at the per-request level.** A failed Kalshi fetch for one series aborts work for that series and surfaces as a failed cron run; next run at T+30min retries. More sophisticated per-request retry is not part of this pass.
- **Observability via heartbeats, dashboards, or alerts.** The cron response JSON is the single observability surface. A future observability effort can restart from a greenfield decision; the existing `oracle_heartbeats` scaffolding should not be assumed load-bearing.
- **Batch settlement payouts / payout events for UI notification.** Users discover resolved Markets via their next page load. Push notifications / toast banners on settlement are a separate UX initiative.
- **Supporting non-binary Kalshi Events.** Inherits the ingest constraint — these events are rejected at ingest, so they never become Wampum Markets, so the resolution pipeline never sees them.
- **Retroactive unresolution.** Once `resolveMarket` commits, there is no unwind path. If Kalshi retroactively corrects a settlement, Wampum does not follow. Accepted risk per ADR-0002.
- **Resolving Markets from a source other than Kalshi.** The translator's input is a `KalshiEvent`; source-agnosticism at the persistence layer is already in place for future work but no second source is being added here.

## Further Notes

Three artifacts related to this PRD are already in the repo and should be considered part of its context:

- `CONTEXT.md` at the repo root has been updated with the new terms (**Kalshi Settlement**, **Settlement Deadline**, revised **Resolution** / **Cancellation** / **Market Status**) and a new **Resolution invariants** section. The Kalshi-vs-Wampum "settlement" collision has been added to the flagged ambiguities.
- `docs/adr/0002-kalshi-is-also-the-resolution-oracle.md` records the design decisions, considered alternatives, and consequences.
- `docs/adr/0001-kalshi-is-one-shot-discovery.md` is the load-bearing prior ADR. ADR-0002 is deliberately framed as a complement — the "one-shot" framing becomes "two-shot total: pricing seed, then resolution."

The ordering of implementation matters for reviewability:

1. **Schema migration first** — drop `"closed"` from the enum. This forces any latent consumer to surface at compile time. No data migration required.
2. **`KalshiMarketSchema.result` + captured fixtures** — extend the contract layer and capture representative JSON for each translator variant. The contract test extension lands here.
3. **`translateKalshiResolution` with tests** — the translator is the system's long-lived interface between "what Kalshi tells us about settlement" and "what Wampum does about it." Over-invest in its clarity and test coverage now.
4. **`runKalshiResolve` orchestrator with its integration test** — the deadline-escalation logic lives here. This is the layer that ties everything together.
5. **Cron route + `vercel.json` entry** — the thinnest glue, landed last so the preceding steps are in a mergeable state before the scheduled job becomes active in production.

The resolution translator and orchestrator should be treated as the long-lived interface between Kalshi's settlement shape and Wampum's terminal Market states. Future changes to either side — Kalshi renaming statuses, Wampum adding a new cancellation trigger, operators tuning the Settlement Deadline — enter the codebase through these two files.
