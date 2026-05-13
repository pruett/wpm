# PRD: Real-time updates via SSE + Postgres LISTEN/NOTIFY

> **Note on writer naming.** This PRD was authored before the multi-outcome
> refactor (ADRs 0006–0008). The transport and protocol described below ship
> unchanged; only the writer call sites moved. References to `sellShares`,
> `createMarket`, `resolveMarket`, `cancelMarket` should be read as the
> current `placeBet` (`data/trading`), `createEvent`, and `commitEvent`
> (`data/events`). Likewise `/market/[id]` is now `/event/[id]`, and the
> `affectedUsers` fan-out happens once per Event commit inside `commitEvent`
> rather than once per per-Market resolve. Implementation in this PR reflects
> the post-refactor shape; see ADR-0009 for the as-built description.

## Problem Statement

Wampum's data layer is aggressively cached. `getMarket`, `getMarkets`, viewer balances, and positions all sit behind Next 16's `"use cache"` + `cacheTag` machinery, with `cacheLife("minutes")` as the TTL. Writers (`placeBet`, `sellShares`) call `revalidateTag` after every mutation, which busts the cache _on the instance that handled the write_. On the next interaction from that same browser, the user sees fresh data.

That is the only path from "the database changed" to "a browser sees it." Specifically:

1. **A viewer on `/market/[id]` watching the **Price** never sees it move when someone else bets.** The other user's `placeBet` revalidates `market:${id}` on the writer's serverless instance; the viewer's instance has no idea. The cache stays warm with old reserves. The viewer must manually refresh the page or wait out the TTL.

2. **A viewer's WPM balance doesn't update after their winning **Market** resolves.** The `/api/cron/resolve` route runs in a separate function invocation from the viewer's session, invalidates _only_ `tags.marketsAll()`, and never touches `market:${id}` or `viewer:${userId}`. The viewer's balance display reads from a `viewer:${userId}`-tagged query that nobody invalidated. Stale balances persist until `cacheLife("minutes")` expires — which is the only reason this is bounded today.

3. **There is no transport for cross-tab or cross-instance updates.** The branch is named `worktree/realtime` but no SSE route, `EventSource` consumer, pub/sub, or NOTIFY plumbing exists in the codebase. Every "real-time" affordance in the UI today (e.g. `LiveOdds`) is aspirational — the data is rendered live at request time and never updated thereafter.

4. **The cron resolve gap is a latent bug masked by the TTL.** Today, users see stale balances for up to a minute after their Market resolves. With any real-time push in place, that one-minute window becomes a _visible_ regression — users expect instant updates, and the missing `viewer:${userId}` invalidation surfaces immediately. The cron gap and the SSE work cannot be addressed in isolation; the fix to the gap must land alongside the transport.

The result for users: an interface that looks live but isn't. **Price**s frozen mid-game, balances frozen post-resolution, the bettor list never growing, and the only recovery being a page refresh.

## Solution

Deliver a one-way push transport that fans **cache-invalidation hints** — `{tag: "market:${id}"}` style messages — from every writer to every connected browser tab, so that mutations on one instance trigger cache invalidation and re-render on every other instance that has a viewer watching.

The transport has two halves:

- **Server-to-server fanout via Postgres `LISTEN/NOTIFY`.** Every writer, inside the same DB transaction as its mutation, calls `pg_notify` with the affected tag. A singleton listener connection per Vercel instance — using Vercel Postgres' direct (non-pooled) connection URL — receives the notification and dispatches it to an in-process emitter. The cache layer's existing `revalidateTag` call is paired with the `pg_notify` call in a single `invalidate(tag)` helper, so they are inseparable by construction.

- **Server-to-client push via SSE.** Each browser tab opens one `/api/stream` connection. The handler authenticates the viewer via Better Auth, subscribes to the bus, broadcasts `market:*` hints to every connected tab, and filters `viewer:${userId}` hints to the matching session. Tabs run a debounced `router.refresh()` on every hint that matches a component-registered `useLiveTag` subscription.

Hints carry _only the identity_ of the changed slice, never the data itself. Re-fetching is delegated to Next's `cacheComponents` machinery; on `router.refresh()`, slices whose tag was just invalidated recompute, slices whose tag was untouched serve cached output. The cache layer (`src/data/*`) remains the sole source of truth for what a tag's content actually is.

The pre-existing invalidation gaps in the cron paths are fixed in the same change. The natural place to fix them is _not_ at the cron route, but inside the persistence functions that already know the affected user set: `resolveMarket` and `cancelMarket` return `affectedUsers`, and they should be the call site for the corresponding `invalidate` fan-outs. After this work, writers don't decide which tags to invalidate — the data layer does, on commit.

From the player's perspective, after this change:

- **Price**, bettor list, and **Resolution** state on a **Market** page update without a refresh as soon as any other user bets, sells, or the cron resolves the market.
- WPM balance and **Position** rows update without a refresh the moment the **Market** they're in resolves or cancels.
- The "Live" in `LiveOdds` becomes accurate (no rename required).
- Disconnects (network blips, deploys, function-timeout-triggered reconnects) are invisible: `EventSource` reconnects automatically; the client fires one resync refresh on reconnect.

From the developer's perspective:

- A single `invalidate(tag)` call replaces every `revalidateTag` call site. The function does both: revalidates the local cache and dispatches the `NOTIFY`. Forgetting one half is impossible.
- The realtime bus and the SSE handler are deep modules tested in isolation. The rest of the application sees only `invalidate(tag)` server-side and `useLiveTag(tag)` client-side.
- No new infra. Postgres (which the app already uses) is the bus; SSE (which Next/Vercel support natively) is the transport.

## User Stories

1. As a player watching a **Market** page, I want the **Price** and bettor list to update the moment any other player **Bet**s or **Sell**s in that **Market**, so that I see the same number my opponents see and can decide to act on it.

2. As a player who just placed a **Bet**, I want my own balance and **Position** to update immediately in every open tab — not just the one I bet from — so that the app stays coherent across the windows I have open.

3. As a player holding **Shares** in a **Market** that resolves while I'm watching, I want the **Market** status, my **Position**, and my WPM balance to all update without a refresh, so that the **Settlement** is visible in real time rather than discovered on my next navigation.

4. As a player whose **Market** is **Cancelled** by the resolution cron, I want my `costBasis` refund to appear in my balance display without a refresh, so that the refund is visible the moment it lands.

5. As a player on a slow connection or after a brief disconnect, I want the realtime updates to resume automatically when the connection comes back, so that I don't need to refresh or notice anything happened.

6. As a player keeping the app open across a deploy or a long idle period, I want the realtime connection to reconnect transparently and the UI to re-sync with current state, so that "long-lived tabs" stay accurate.

7. As a player who is not signed in, I want the realtime stream not to attach, so that anonymous browsing still works against the cached read path without surfacing user-private signals.

8. As a player with multiple **Market** pages open in tabs, I want each tab to receive only the updates relevant to what it is rendering, so that the UI does not thrash on unrelated activity.

9. As a player when the resolution cron processes many **Markets** in a single sweep, I want the UI to update without refresh storms, so that the page stays responsive even when dozens of invalidations arrive in close succession.

10. As a developer writing a new server action that mutates **Market**, **Position**, or balance state, I want a single `invalidate(tag)` call site to perform both local cache invalidation and cross-instance fanout, so that I cannot forget to do one half.

11. As a developer reading any writer in the codebase, I want the invalidation contract to live in the data layer — the persistence functions that _know_ which entities were affected — rather than at the action or cron call site, so that adding a new caller of `resolveMarket` does not require reasoning about which tags to invalidate.

12. As a developer modifying the realtime transport, I want the bus (Postgres `LISTEN` connection, in-process emitter, subscriber registry) to be a deep module with a small interface (`subscribe`, `unsubscribe`, `publishLocal`), so that the SSE route, the test harness, and any future consumers all see the same shape.

13. As a developer of the SSE route handler, I want a simple `subscribe()` API that yields `{tag}` events for the lifetime of the connection, so that the handler is a thin pass-through from bus to response stream with no Postgres knowledge of its own.

14. As a developer adding a new component that reads a cached tagged query, I want a one-line `useLiveTag(tag)` hook to register the component's interest, so that adding realtime to a new piece of data is a single import and a single call.

15. As a developer running the test suite, I want the realtime bus and `invalidate` helper covered by unit tests using a real Postgres test database, so that the LISTEN/NOTIFY contract, the subscription fanout, and the revalidate+notify pairing are verified rather than assumed.

16. As an operator inspecting a production instance, I want each Vercel instance to hold exactly one Postgres `LISTEN` connection regardless of how many SSE clients it serves, so that connection pressure scales with instances, not clients.

17. As an operator paying Vercel function bills, I want the SSE handler to self-terminate before the function timeout (with an `event: reconnect` frame so the client reconnects to a fresh instance), so that we never hit hard-kill timeouts and `EventSource`'s native reconnect behavior absorbs the cycle.

18. As an operator monitoring keep-alive behavior, I want a periodic SSE heartbeat comment frame so proxies and load balancers do not idle-kill the connection, so that the channel stays open across realistic network paths.

19. As an operator who needs to drop a `NOTIFY` payload without re-deploying writers, I want the consumer side to treat hints as fire-and-forget — a dropped hint is recovered by the next hint or by `cacheLife` — so that there is no monotonic event ID, no replay log, and no write-ahead buffer to maintain.

20. As an operator running multiple instances, I want `pg_notify` from any writer instance to reach the listener on every instance with a connected SSE client, so that fanout is provably cross-instance without per-tab Postgres connections.

21. As a future maintainer reading the architecture, I want the decision to use SSE + Postgres `LISTEN/NOTIFY` (rather than websockets, Redis, or Pusher/Ably) recorded in an ADR, so that the rejection of each alternative is discoverable and the production system's shape is explained.

22. As a future maintainer extending the transport (e.g. adding new tag namespaces, replacing the bus, adding event sourcing), I want the writer-side contract to be the single `invalidate(tag)` function, so that the transport can change underneath without touching every writer.

23. As a future maintainer wondering whether `cacheLife("minutes")` is still the right TTL after realtime ships, I want the answer in the ADR: the TTL stays as belt-and-suspenders — invalidations are primary, TTL is the recovery path if a hint is lost — and lengthening it is a future tuning decision, not a prerequisite.

24. As a future maintainer reading the components, I want the `LiveOdds` component name to stay as-is rather than be renamed during this work, because once the hook is wired the name becomes accurate without any rename ceremony.

## Implementation Decisions

### Architectural shape: writer → bus → tab, in three layers

Three modules with explicit boundaries, mirroring the ingestion/resolution pipeline style:

- **Writer-side primitive** (new `invalidate.ts` in the data layer) — a single function `invalidate(tag: string): Promise<void>` that calls `revalidateTag(tag, "max")` and `pg_notify('wpm_invalidations', tag)` in that order. The function is the _only_ sanctioned way to invalidate. `revalidateTag` is not called directly anywhere after this change.

- **Bus** (new `lib/realtime/bus.ts` or equivalent) — owns the singleton Postgres `LISTEN` connection (lazily opened on the first subscriber), the in-process `EventEmitter`-style fanout, the subscriber registry, and reconnect logic if the listener connection drops. Public interface is intentionally narrow:
  - `subscribe(handler: (tag: string) => void): () => void` — returns an `unsubscribe` function.
  - Internally: opens the direct-URL Postgres connection on first subscribe, issues `LISTEN wpm_invalidations`, fans incoming notifications to all handlers, tears down the listener when the last handler unsubscribes (or keeps it open with a TTL — implementer's call).
  - Reconnects on connection drop with exponential backoff. On reconnect, no replay; subscribers continue receiving live hints.

- **SSE transport** (new `app/api/stream/route.ts`) — a thin HTTP handler:
  - `requireUser` for auth; anonymous → 401.
  - Opens a `ReadableStream` with `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`.
  - Subscribes to the bus. On each tag:
    - If `tag` starts with `viewer:`, forward only if the suffix matches the authenticated `userId`.
    - Otherwise (currently only `market:*` and `markets`), forward unconditionally.
  - Sends a comment-frame heartbeat every ~25 seconds.
  - Self-terminates at ~270 seconds with one final `event: reconnect\ndata: {}\n\n` frame and closes the stream. `EventSource` auto-reconnects.

- **Client-side coordinator** (new provider mounted in the `(app)` layout) — opens one `EventSource` to `/api/stream` for the session, maintains an in-memory `Set<string>` of subscribed tags fed by `useLiveTag(tag)` calls from components, and on each incoming hint:
  - Drops the hint silently if no component currently has it in the subscribed set.
  - Schedules a debounced `router.refresh()` (~150ms window). Multiple matching hints inside the window coalesce to one refresh.
  - On reconnect (handled natively by `EventSource`), fires one `router.refresh()` to resync any state missed during the gap.

- **`useLiveTag(tag)` hook** — registers the tag with the coordinator on mount; unregisters on unmount. Returns nothing; its only effect is to gate future hints.

### Invalidation responsibility moves into the data layer

After this change, **the data layer's persistence functions own invalidation**. Action handlers and cron routes no longer call `invalidate` directly. The shift:

- `placeBet` (in `data/trading.ts`) calls `invalidate(tags.market(marketId))` and `invalidate(tags.viewer(userId))` inside or immediately after the transaction.
- `sellShares` does the same.
- `createMarket` calls `invalidate(tags.marketsAll())` and `invalidate(tags.market(market.id))` on successful insert.
- `resolveMarket` calls `invalidate(tags.market(marketId))` + `invalidate(tags.marketsAll())` and one `invalidate(tags.viewer(userId))` per entry in its returned `affectedUsers`.
- `cancelMarket` does the same.

The `placeBet` and `sellShares` server actions drop their existing `revalidateTag` calls. The `/api/cron/ingest` and `/api/cron/resolve` routes drop theirs as well. The summary-returning behavior of the crons stays unchanged; only the invalidation calls are removed because the underlying data layer now owns them.

This fixes the pre-existing cron-resolve gap as a side effect of the contract move: `resolveMarket` always knew which users it touched (`affectedUsers` is already in its return shape); it just wasn't responsible for telling anyone. After the move, it is.

### Why writers must `NOTIFY` inside their DB transactions

Postgres queues `NOTIFY` payloads issued inside a transaction and delivers them at `COMMIT`. A rolled-back transaction discards the queue. Calling `invalidate` _inside_ the transaction (via the same `tx` client) is therefore atomic with the write: a successful commit guarantees the notification fires; a failed write guarantees no spurious hint reaches subscribers.

The current `revalidateTag` calls fire _after_ the transaction returns. For the local cache this is fine — the writer holds the result, and Next's cache invalidation is idempotent. For `NOTIFY` it is also fine in practice, but we standardize on **inside the transaction** because it eliminates a class of "write rolled back, hint already sent" race the writer would otherwise have to reason about per-call.

Concretely, the persistence functions invoke `invalidate` against `tx`, not `db`. The `invalidate` helper accepts an optional `tx?: Tx` argument; if absent, it uses `db` directly. Most call sites pass `tx`; admin or background callers that don't have a transaction in hand pass nothing.

### Postgres connection separation

Two connection strings are used:

- **Pooled URL** (the existing `DATABASE_URL` or equivalent) — every read and write, including writers' `NOTIFY` calls. The notification goes _out_ through whatever connection executed the transaction; PgBouncer transaction-mode is fine for that.
- **Direct URL** — used _only_ by the bus's singleton `LISTEN` connection. The bus reads this from a new env var (e.g. `DATABASE_URL_DIRECT`) and fails fast at startup if it is missing. Falling back to the pooled URL is explicitly _not_ supported: PgBouncer in transaction mode would silently drop the LISTEN registration without surfacing an error.

Vercel Postgres / Neon expose both. Self-hosted setups need only ensure the listener URL bypasses any pooler.

### NOTIFY channel and payload shape

- Channel name: `wpm_invalidations`. Single channel for all tags.
- Payload: the tag string itself (e.g. `market:kalshi-KXMLBGAME-25APR15-NYY`). No JSON wrapper, no version field, no metadata. The tag is the message.
- Postgres `NOTIFY` payloads are 8 KB max; our tags are short strings well under that.
- If the payload shape ever needs to grow (e.g. carry a timestamp), the channel name gains a `_v2` suffix and the bus runs both for a transitional period. Not part of this PRD.

### SSE event shape

Sent to the client as standard SSE frames:

```
event: invalidate
data: {"tag":"market:kalshi-KXMLBGAME-25APR15-NYY"}

```

A heartbeat is a comment line (`:keepalive\n\n`) every ~25 seconds.

A self-terminated cycle ends with:

```
event: reconnect
data: {}

```

…and a stream close. The client's `EventSource` reconnects automatically; the coordinator fires one `router.refresh()` on the next `open` event.

### Client coordinator: subscription, debounce, refresh

- The coordinator is mounted in the `(app)` layout once per session. Anonymous sessions do not mount it.
- `useLiveTag(tag)` adds `tag` to a `Set<string>` on mount, removes it on unmount, via `useEffect`. The set lives in a single module-scoped instance for the lifetime of the page session.
- On each `invalidate` event, the coordinator checks `tag ∈ subscribedSet`. If absent, drop.
- If present, schedule a `router.refresh()` via `setTimeout(..., 150)`. If a refresh is already scheduled, do nothing (debounce by coalescence). Cancel and re-schedule is not necessary — we want the first scheduled refresh to fire on time, not be pushed further out by a stream of hints.
- On the `EventSource` `open` event _after the initial connection_ (i.e. on reconnect), force one `router.refresh()` regardless of subscriptions, so that any state that drifted during the gap is resynced.

### Why hints are fire-and-forget, no replay

A dropped hint leaves a tab stale until either the next matching hint or the `cacheLife("minutes")` TTL — both bounded. Building a replay system (monotonic event IDs, `Last-Event-ID`, a persistent ring buffer) would require schema additions, ordering guarantees across writers, and consumer state management — all to recover from a class of failure (a dropped Postgres notification or a missed SSE frame mid-flight) that the existing TTL already bounds. The trade-off is asymmetric in the TTL's favor; we keep it.

The single concession: on every SSE _reconnect_, the coordinator fires one bulk `router.refresh()`. This recovers anything missed during the connection gap without requiring server-side replay.

### `cacheLife("minutes")` stays

The TTL is now belt-and-suspenders. Invalidations are the primary mechanism; the TTL is the recovery path if a hint is lost. Lengthening it (e.g. to `hours`) is a future tuning decision — it would reduce wasted recomputation when nothing is invalidating, at the cost of longer staleness on any missed hint. Not in scope for this PRD.

### CONTEXT.md is not changed

The new vocabulary (Invalidation Hint, Live Tag, Stream, Bus) is implementation, not domain. CONTEXT.md's scope is domain language; these terms do not belong there. Real-time changes nothing about the domain — **Bets**, **Sells**, **Resolutions**, **Cancellations**, **Pool**, **Positions** are the same entities and trigger the same state transitions. Only the _transport_ of the resulting state changes.

If a domain-level fact wants to enter CONTEXT.md later (e.g. an invariant phrased in terms of price-observability), that is a follow-up decision after the system runs in production. Not preempted here.

### ADR 0006 records the architecture

`docs/adr/0006-real-time-via-sse-and-postgres-listen.md` (drafted alongside this PRD) records:

- the choice of SSE over websockets,
- the choice of Postgres `LISTEN/NOTIFY` over Redis / Pusher / Ably,
- the invalidation-hint payload model over push-data,
- the single multiplexed connection over per-route streams,
- the move of invalidation responsibility into the data layer,
- the fire-and-forget posture and the `cacheLife` safety-net role,
- the Vercel direct-connection requirement for the listener.

### What is _not_ a module boundary change

The AMM, settlement, resolution, ingest, and translator modules are untouched. The Kalshi-side flow is unchanged. The `markets`, `ammPools`, `positions`, `balances`, `transactions`, `treasury` tables are unchanged. No schema migration. No new tables. The Better Auth integration is unchanged.

## Testing Decisions

### What makes a good test in this codebase

Tests verify behavior through public interfaces, not implementation details. A bus test asserts that a subscriber receives the right tag string after a `pg_notify` is issued from elsewhere — never that the bus internally uses an `EventEmitter` or maintains its registry as a `Set`. An `invalidate` test asserts that after a call, the local cache reflects invalidation _and_ a subscriber on the bus has received the tag — never that one or the other implementation function was called. This mirrors the testing discipline already established in `data/markets.test.ts`, the integration tests for `runKalshiResolve`, and the settlement tests.

### Modules under test

Two modules receive dedicated test coverage in this PRD:

- **The realtime bus.** Subscribe / unsubscribe lifecycle. Multiple subscribers receive the same payload. The singleton `LISTEN` connection is opened on first subscribe and remains open (or is torn down per the implementation's chosen policy) for the lifetime of the bus. A `pg_notify` from a _separate_ connection — simulating a writer instance — reaches all subscribers. Listener-connection drop and reconnect: a dropped underlying Postgres connection is recovered without subscriber-visible disruption beyond the gap itself. Tests run against the real test Postgres database (no mocks), using the direct connection URL.

- **The `invalidate(tag)` helper.** After calling `invalidate("market:foo")`, both side effects are observable: the Next data cache is invalidated for that tag (assertable via the cache's own probes or via a follow-up read that bypasses the cache); and a bus subscriber registered before the call has received the string `"market:foo"`. A call made inside a rolled-back transaction does _not_ deliver a notification — verifying the `NOTIFY` happens against the transaction's connection, not against `db` outside the transaction.

The other modules — SSE route, client coordinator, `useLiveTag`, and the modifications to writer call sites — are _not_ covered by new tests in this PRD. Their behavior is exercised end-to-end by the existing Playwright config if the team wants to extend it, but unit/integration tests for them are out of scope. The reasoning: their value-add is glue (HTTP framing, React lifecycle), and the underlying primitives (bus + `invalidate`) are the load-bearing testable surface.

### Prior art

- `data/markets.test.ts` and `lib/settlement.test.ts` — vitest unit tests against pure functions and against the test database. The realtime bus tests follow the same shape: real DB connection, no network mocks, deterministic teardown.
- `vitest.integration.config.ts` — the existing integration test config covers DB-backed flows. The bus tests live in this configuration since they require a real Postgres connection in `LISTEN` mode.
- `vitest.contract.config.ts` — the contract tests run live against Kalshi. Not relevant here.

The new test files live alongside their modules (`invalidate.test.ts` next to `invalidate.ts`; `bus.test.ts` next to `bus.ts`).

## Out of Scope

- **Real-time updates for leaderboard or the markets-list grid.** Both stay on the cron-driven invalidation path. The leaderboard recomputes on `tags.leaderboard()` revalidation (currently nothing revalidates it; a follow-up can wire `invalidate(tags.leaderboard())` into the bet/sell/settlement paths if desired). The markets-list grid invalidates via `tags.marketsAll()` on ingest and resolve. Adding `useLiveTag(tags.marketsAll())` to the grid is a small follow-up but not blocking.

- **Push-data payloads.** Rejected; see ADR 0006.

- **Websockets, Redis, Pusher, Ably.** Rejected; see ADR 0006.

- **Per-market or per-route SSE connections.** Rejected; the single multiplexed stream per session is the chosen shape.

- **Replay / `Last-Event-ID` / server-side event log.** Rejected; the fire-and-forget posture with TTL as safety net is the chosen shape. Adding replay later is a non-breaking change to the SSE handler.

- **Anonymous SSE.** Anonymous users do not mount the realtime coordinator. The marketing/welcome routes are unchanged.

- **Notifications / toasts on settlement.** The push channel reaches the browser but only triggers `router.refresh()`. UI-level "you won" toasts are a separate UX initiative.

- **CONTEXT.md vocabulary additions.** Considered and rejected during planning. Real-time is implementation, not domain; the existing glossary stays untouched.

- **Per-sport, per-market, or per-tag SSE channels.** Single channel; routing is client-side. Sharding the bus is a future-scaling decision not motivated by current load.

- **Removing or extending `cacheLife("minutes")` TTL.** Stays as-is. Tuning is a separate decision.

- **Reconnecting clients to a sticky instance.** Vercel does not guarantee instance affinity for SSE reconnects; the bus is per-instance, so a reconnect lands on whichever instance the new request hits. This is fine because every instance subscribes to the same Postgres channel; no per-tab state lives on a specific instance.

- **Observability of hint volume / drop rate.** No metrics are added in this pass. If hint loss becomes suspected in production, a later pass can add a counter to the bus and surface it via the existing cron-summary pattern.

- **Backpressure on slow consumers.** If an SSE client's stream backs up, the handler will eventually fail to write and the connection will close; `EventSource` reconnects. Explicit backpressure (e.g. dropping hints for slow consumers) is not implemented; the volume regime does not warrant it.

- **Server-side rate-limiting of `NOTIFY` frequency.** The cron sweeps can fan a burst of notifications. Client-side debounce absorbs this. Server-side throttling is not implemented.

## Further Notes

The PRD lands alongside `docs/adr/0006-real-time-via-sse-and-postgres-listen.md`, which captures the _why_ for each architectural choice. Read the ADR before the PRD when onboarding to this work.

The ordering of implementation matters for reviewability:

1. **`invalidate(tag)` helper** with its tests. Standalone, no transport implications yet. Once landed, every writer in the codebase can switch over to it without changing observable behavior — `pg_notify` fires but nothing is listening yet. This step is a no-op from the user's perspective and is independently mergeable.

2. **Move invalidation calls into the data layer.** `placeBet`, `sellShares`, `createMarket`, `resolveMarket`, `cancelMarket` start calling `invalidate` for every tag they touch; the server actions and cron routes drop their existing `revalidateTag` calls. This step fixes the pre-existing cron-resolve gap as a side effect. Verified by the existing test suite plus a manual scenario: resolve a Market via the cron and confirm an affected viewer's balance updates on next interaction (today, this still relies on TTL or page navigation; after this step, it works on the next request to a route that reads `viewer:${userId}`).

3. **Realtime bus** with its tests. Standalone module; no consumer yet. Verifies the `LISTEN`/`NOTIFY` round trip works against the configured direct connection URL.

4. **SSE route** wired to the bus, with a basic Playwright sanity check (optional) that hitting `/api/stream` as an authenticated user yields a `text/event-stream` response and forwards a `pg_notify`-issued payload.

5. **Client coordinator + `useLiveTag` hook**, mounted in the `(app)` layout. At this point, opening two tabs against the same market and betting from one demonstrates the full flow: bet writes → `invalidate` fires → `NOTIFY` reaches the other tab's instance → SSE delivers `{tag}` → coordinator debounces → `router.refresh()` → other tab shows new price.

6. **Component-level `useLiveTag` registrations** added to `MarketCard`, `LiveOdds`, `Portfolio`, and any other consumer of `market:${id}` / `viewer:${userId}`-tagged data. The list is short; one PR per logical area or one bundled PR is acceptable.

Steps 1 and 2 are reviewable and mergeable independently of the rest. They are the smallest unit that fixes the pre-existing cron-resolve correctness bug; everything beyond them is the realtime feature.

The realtime bus and the `invalidate` helper are the long-lived interfaces between writers and the rest of the world. Future changes — adding a new tag namespace, swapping the bus for Redis if scale warrants, adding observability — enter the codebase through these two modules.
