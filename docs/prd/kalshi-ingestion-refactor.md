# PRD: Kalshi → Wampum Ingestion Refactor

## Problem Statement

Wampum ingests real-world prediction markets from Kalshi on a cron schedule and creates internal **Markets** backed by our A/B AMM. The current ingestion pipeline is unfinished and accumulates friction in three places that make it hard to reason about and risky to extend:

1. **Two implicit sources of truth, no formalized bridge.** The Kalshi API payload and the Wampum `markets` database row are meant to be distinct shapes, but the translation between them lives inline inside the orchestration function and has no dedicated tests. A developer changing the translator has no safety net; a developer changing the schema has no compile-time warning that the translator still matches.

2. **Three hand-written types describe the same concept.** `CreateMarketRequest`, `OrderBookSnapshot`, and the inferred DB row type all describe "a Market to be written." They disagree on field names (`teamA` vs `outcomes[0]`) and representations (ISO string vs epoch ms), so every boundary crossing does a silent rename and reshape. The inferred types from drizzle are never used as the authority they should be.

3. **The schema encodes an intent the code doesn't fulfill.** Ten columns on `markets` hold snapshot prices and volume from Kalshi (`yesBidCentsA`, `noAskCentsB`, `volume24hA`, etc.). Ingestion writes them once at creation and never refreshes them, so they are stale within minutes and lie to every downstream reader that assumes they are live. The columns exist because an earlier design contemplated refresh; the refresh never got built.

A secondary problem: when translation fails or is intentionally skipped (non-binary Kalshi Event, missing prices, unparseable close time), the reason is lost. The orchestrator increments a generic `skipped` counter with no discriminator, so operational visibility into *why* Kalshi data isn't becoming Wampum markets is effectively zero.

## Solution

Refactor ingestion into a three-layer pipeline with explicit boundaries, commit to **one-shot discovery** as the only ingestion mode, and derive input types directly from the drizzle schema so the two sources of truth can never silently drift.

From the developer's perspective, after this change:

- There is exactly one file that knows Kalshi's wire format, and it returns a schema-shaped value. Every other layer is Kalshi-agnostic.
- Adding or removing a column on the `markets` table produces TypeScript errors in the translator, not runtime surprises.
- Every ingested event produces either a created Market or a typed skip reason. Ops can see at a glance which Kalshi events were skipped and why.
- Kalshi is consulted exactly once per Market — at creation — to seed the AMM with a real-world prior. After that moment, the Market is a self-contained Wampum entity and the AMM is the sole price authority.

## User Stories

1. As a developer modifying the Kalshi payload schema, I want the Zod schema to be the single source of truth for what we accept from the API, so that I don't have to chase payload assumptions across multiple modules.

2. As a developer changing the `markets` table, I want the translator's output type to be derived from the schema, so that TypeScript immediately tells me where translation logic needs to be updated.

3. As a developer writing translator logic, I want to work with a pure function that takes a parsed Kalshi Event and returns a typed result, so that I can test translation exhaustively without spinning up a database or mocking HTTP.

4. As a developer, I want the translator to return a discriminated union of success-with-input and skip-with-reason, so that callers can react appropriately to each skip reason instead of getting a silent `null`.

5. As a developer, I want the `createMarket` function to take only a translator-shaped value, so that persistence has no knowledge of Kalshi and can be reused by admin tooling or seed scripts.

6. As a developer, I want the `initializePool` call to live inside `createMarket` rather than inside the translator, so that AMM seeding remains a persistence-layer concern and the translator stays purely about shape mapping.

7. As a developer, I want ISO-string-to-epoch-ms conversion to happen at the translator boundary, so that the persistence layer only ever sees the number shape the database actually stores.

8. As an operator running the ingestion cron, I want the ingest summary to report created counts plus a breakdown of skip reasons, so that I can see at a glance whether Kalshi is returning unusable data or our translator is rejecting valid data.

9. As an operator, I want the cron to run every 30 minutes, so that Kalshi events which temporarily lack usable prices (zero-spread) are re-evaluated soon enough to be ingested before close.

10. As an operator, I want a Kalshi Event with zero-spread (no usable bid/ask on either side) to be rejected at the translator rather than created with a 50/50 default, so that we don't permanently lock in a fabricated prior for a market that will soon have real pricing available.

11. As an operator, I want the ingestion endpoint to skip Kalshi Events whose close timestamp has already passed, so that we don't create Markets that can never be traded.

12. As a developer, I want the `markets` table to contain only fields that the application actually uses at runtime, so that new readers of the schema aren't misled into believing we track live Kalshi data.

13. As a future maintainer, I want architectural invariants — "ingestion is one-shot," "Kalshi Event maps to one Market," "Kalshi Market maps to one Outcome" — recorded in `CONTEXT.md` and ADRs, so that the code's intent is discoverable without reverse engineering.

14. As a future maintainer, I want the terminology collision between "Kalshi Market" and "Wampum Market" resolved in naming conventions, so that unqualified "Market" in code always refers to the Wampum internal concept.

15. As a developer adding a new ingestion source in the future (not Kalshi), I want the persistence layer and AMM seeding logic to already be Kalshi-agnostic, so that adding a second source requires only a new translator, not a rewrite of `createMarket`.

16. As a developer testing translation, I want recorded JSON fixtures captured from real Kalshi responses alongside the translator tests, so that I can assert behavior against realistic payload shapes without live network dependencies.

17. As a developer, I want the existing Kalshi contract test to continue verifying that the live Kalshi response matches our Zod schema, so that upstream shape changes are caught early even though they no longer affect translation internals.

18. As a developer, I want idempotent re-ingestion — running the cron twice in a row produces no duplicates and no errors — so that retries and overlapping runs are safe.

19. As a player using the app, I want newly opened Kalshi contests to become tradable Wampum Markets within 30 minutes of Kalshi listing them, so that I can bet on fresh real-world events without long lag.

20. As a player, I want Wampum's price for a Market to be driven by Wampum trading activity alone after creation, so that the odds I see reflect the AMM state and aren't subject to ambiguity from a secondary external feed.

21. As an operator investigating an ingestion anomaly, I want each skip reason typed with its relevant context (e.g. the Kalshi event ticker for `no_initial_price`), so that I can jump straight to the upstream event in question.

22. As a developer, I want the Kalshi URL construction to include a `min_close_ts` parameter at the current time, so that Kalshi does as much server-side filtering as its API allows and we transfer less useless data.

## Implementation Decisions

### Architectural shape: three layers with explicit boundaries

- **API contract layer** owns the Zod schema for the Kalshi payload. This is the only layer that knows what the wire format looks like. It is validated at ingest time and backed by a contract test that hits live Kalshi.
- **Translator layer** is a pure function module. It takes a parsed Kalshi Event plus a sport identifier and returns a discriminated result: either a translated value or a typed skip reason. It performs no I/O and produces no side effects. It owns every numeric and temporal conversion between the Kalshi shape and the Wampum shape.
- **Orchestration layer** performs the fetch, invokes the Zod schema to parse, loops over events calling the translator, hands successful translations to the persistence function, and aggregates a summary with per-reason skip counts. It is the only layer that touches network or database.

The persistence function that creates a Market is a deep module in the Ousterhout sense: it takes a simple value and encapsulates the full complexity of writing rows across `markets`, `amm_pools`, and `transactions` inside a transaction, plus the AMM-pool initialization math. Its interface is stable; its internals can change freely.

The translator is another deep module: a single pure function with a simple input and a typed output that hides every detail of how the two schemas relate.

### Module responsibilities after the refactor

- **Kalshi API contract module**: exports the Zod schema and inferred types for the `/events` response and the URL builder for the endpoint. Unchanged in spirit; trimmed of the fields we stop mapping.
- **Kalshi translator module** (new): exports the pure translation function, the `TranslatedMarket` output type (derived from the drizzle insert type), and the `SkipReason` discriminated union. Owns `midProbability`.
- **Market persistence module**: exports a single `createMarket` function that accepts a translator-shaped value, stamps orchestrator-owned fields (creation timestamp, initial status), runs AMM seeding internally, and writes all three rows transactionally. Loses its dependency on Kalshi entirely.
- **Ingestion orchestrator module**: becomes a thin glue function — fetch, parse, loop, summarize. Contains no conversion logic.
- **Cron route module**: unchanged.

### Type decisions

- The translator's happy-path output is a struct whose primary field is shaped as `Omit` of the drizzle-inferred insert type, with the fields the orchestrator stamps (status, creation timestamp) removed. Plus a seed amount and an initial probability for the A outcome.
- Three legacy types — the hand-written create-market request, the order-book snapshot, and their intersection — are deleted. Any code that referenced them consumes the new translator-shaped value or the drizzle-inferred insert type directly.
- The initial probability for A is a non-nullable number on the happy path. The translator guarantees a usable prior or skips entirely; there is no "use 50/50 as fallback" path.

### Skip reason taxonomy

The translator returns one of four discriminated variants:

- `ok`: a successful translation with the translated value.
- `non_binary`: the Kalshi Event has anything other than exactly two nested Kalshi Markets; includes the actual count.
- `unparseable_close_time`: the close timestamp couldn't be parsed; includes the raw string.
- `no_initial_price`: both sides of the Kalshi Event do not have strictly positive bid *and* ask; includes the Kalshi event ticker.

The orchestrator also tracks an `already_exists` counter, distinct from translator skip reasons, for events the persistence layer rejects because the Market already exists.

### Schema changes

- Drop ten columns from the `markets` table: the four bid/ask cents columns for outcome A, the same four for outcome B, and the two 24-hour volume columns. Generate a drizzle migration.
- No other schema changes.

### API / integration contract

- The Kalshi URL gains a `min_close_ts` query parameter set to the current Unix time in seconds on every call, as a cheap server-side filter against already-closed events.
- Kalshi's `/events` endpoint does not support server-side filtering by price validity, volume, or open interest; zero-spread filtering must remain client-side in the translator.

### Ingestion invariants (restated for implementation)

- Ingestion is one-shot discovery. A Market, once created, is never re-touched by ingestion. The Wampum AMM is the sole source of price truth from t=0 onward.
- A Kalshi Event with insufficient pricing at cron time T is *not* ingested; it is left for cron time T+30min to re-evaluate. Cron cadence must be frequent enough that events rarely stay zero-spread from Kalshi open to Kalshi close.
- Only binary-moneyline Kalshi Events are ingested. This is an invariant, not a filter: anything else returning from the API is skipped with a typed reason.

### Operational change

- The Vercel cron schedule changes from every two hours to every thirty minutes (48 runs per day).

## Testing Decisions

### What makes a good test in this codebase

Tests verify behavior through public interfaces, not implementation details. A translator test should assert on the translator's return value given realistic input, never on how the translator decomposes the work internally. A persistence test should assert on the state of the database after calling `createMarket`, never on which helper functions were invoked. The goal of every test is to pin down a contract that external callers depend on, so that the implementation underneath can be rewritten without breaking the test.

### Translator — primary test target

The translator is the central testable artifact introduced by this refactor and receives the most thorough coverage. Tests are fixture-driven: small, realistic JSON payloads captured from live Kalshi responses are checked into the repo next to the tests and replayed offline. Each skip reason is covered by at least one fixture, plus a full happy-path assertion that every field on the resulting translator output matches expectations (team names, tickers, derived close timestamp, derived initial probability, derived seed amount).

Fixtures explicitly include:

- a binary-moneyline event with healthy spreads on both sides (happy path),
- a binary-moneyline event with one zero-bid/zero-ask side (skip: `no_initial_price`),
- an event with three or more nested markets (skip: `non_binary`),
- an event with a malformed expiration timestamp (skip: `unparseable_close_time`).

### Persistence — simplified target

With Kalshi concerns removed from `createMarket`, its tests can focus on the behavior that actually matters: given a translator-shaped input, the correct rows are written transactionally across `markets`, `amm_pools`, and `transactions`; treasury is debited by the seed amount; and duplicate-id calls return the `already_exists` result without writing.

### Orchestration — integration tested, optional in first pass

The orchestration layer is thin enough that a single integration test covering "Kalshi returns a mix of ingestible and skippable events → summary reports the correct counts per category" is sufficient. This test mocks `fetch` and runs against the real test database. If it's deferred, the risk is low because the orchestration layer contains no branching logic beyond the summary accumulation.

### Contract test — retained

The existing contract test for the Kalshi endpoint stays as-is. It verifies that our Zod schema matches the live API and catches upstream breaking changes. It is not affected by the refactor but its value grows, because the Zod-derived types now drive the translator's input.

## Out of Scope

- **Read-side type drift.** The `Market` type returned from data-layer read functions still uses `outcomes: [string, string]` while the schema uses `teamA`/`teamB`. Fixing this the same way (infer from `$inferSelect` and propagate) is a worthwhile follow-up, but it affects more UI surface area than this pass should swallow.
- **Live Kalshi tracking / refresh.** Explicitly ruled out by ADR-0001. Any feature requiring current Kalshi prices for existing Markets is a separate decision that would first require revisiting the ADR.
- **Admin UI for skip observability.** The typed skip reasons enable a future "Kalshi events we've seen but not ingested, and why" view. That view itself is not part of this work; the refactor only ensures the underlying data is first-class.
- **Supporting non-binary Kalshi Events.** Props, totals, and multi-outcome events remain explicitly unsupported and skipped. Extending the AMM to more than two outcomes is a separate, much larger initiative.
- **Second ingestion source.** The refactor leaves the persistence layer source-agnostic, which makes adding another provider easier, but no second source is being added here.
- **Retry/backoff on transient Kalshi errors.** The existing behavior — bubble the error, return 502 from the cron endpoint — is preserved. More sophisticated retry logic is not part of this pass.

## Further Notes

Three artifacts from the grilling session that accompanies this PRD are already in the repo and should be considered part of the PRD's context:

- `CONTEXT.md` at the repo root establishes the project's domain glossary and documents the ingestion invariants.
- `docs/adr/0001-kalshi-is-one-shot-discovery.md` records the one-shot-discovery decision, its motivation, and its consequences.
- `vercel.json` has been updated to the 30-minute cron cadence.

The ordering of implementation matters for reviewability. Starting with the schema migration (dropping the ten snapshot columns) is recommended because it forces every downstream module to confront the change at compile time rather than discovering stale code paths later. The translator module should land with its tests in the same change; tests without a module or a module without tests both defeat the purpose of this refactor.

The translator should be treated as the system's long-lived interface between "what Kalshi sends" and "what Wampum stores." It is worth over-investing in its clarity and test coverage now, because future changes to either the Kalshi schema or the Wampum schema will enter the codebase through this file.
