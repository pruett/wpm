# Architecture of WPM (Wampum)

## Bird's Eye View

WPM is a prediction market platform for a small friend group: binary sports betting on game moneylines, priced by an Automated Market Maker (AMM). Users get an airdrop of WPM tokens at signup and trade outcome shares against per-market liquidity pools seeded by a treasury.

The system is intentionally small. A single Next.js application owns the user-facing UI, the server-side business logic, the SQLite database that stores balances, markets, positions, pools, and an audit log of every economic event. A separate Oracle process ingests sports schedules from ESPN and feeds new markets into the system. There is no blockchain — earlier designs used a custom chain with signed transactions, a mempool, and a standalone API; that has been collapsed into Next.js server actions writing to SQLite inside a single transaction.

Real-time price and balance updates fan out over an in-process event bus to a single SSE endpoint that the browser subscribes to.

## Code Map

### `apps/web/`

The Next.js application — the only user-facing service and the source of truth for all state.

#### `apps/web/src/app/`

Routes, layouts, and server actions following the App Router conventions.

- `page.tsx`, `landing.tsx`, `dashboard.tsx`, `layout.tsx` — top-level entry; `page.tsx` chooses landing vs. dashboard based on session.
- `(auth)/` — login and registration flows (route group, no URL prefix).
- `market/[id]/` — market detail page.
- `@modal/` — parallel route slot rendering market detail as an intercepted modal over the dashboard.
- `admin/` — admin pages (markets, users, system). Gated by `src/proxy.ts`.
- `actions/placeBet.ts`, `actions/sellShares.ts` — server actions for trading. Wrap a synchronous `db.transaction(...)` that updates `balances`, `ammPools`, `positions`, and writes a row to `transactions`. After commit they `publish(...)` to the realtime bus and call `updateTag(...)` to invalidate Next's cache tags.
- `actions/admin/` — admin server actions: `cancelMarket`, `distributeTokens`, `overrideSeed`, `resolveMarket`. The trade-side actions (`cancelMarket`, `resolveMarket`) are thin wrappers around `lib/market/`.
- `api/auth/[...all]/` — better-auth's catch-all handler.
- `api/oracle/` — REST endpoints consumed by the oracle process, authenticated via `requireOracle()` (bearer token from `WPM_ORACLE_SERVICE_TOKEN`). `health/` — liveness check. `markets/` — list open markets (GET) and create a market (POST). `markets/[id]/resolve/` — resolve by outcome. `markets/[id]/cancel/` — cancel (e.g. postponement). These routes delegate to the shared `lib/market/` functions.
- `api/stream/route.ts` — single SSE endpoint that subscribes to the realtime bus and streams events to the browser. `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

#### `apps/web/src/lib/`

Server-side libraries used by routes and actions.

- `auth.ts`, `auth-client.ts` — better-auth setup with `magicLink` and `passkey` plugins, drizzle adapter on the same SQLite database. Exports `getSession`, `requireUser`, `requireAdmin`, `isAdmin`, `requireOracle`. Admin membership is derived from the `ADMIN_EMAILS` env var, not stored in the database. `requireOracle` validates a bearer token from the `WPM_ORACLE_SERVICE_TOKEN` env var for service-to-service calls.
- `market/` — extracted market lifecycle logic shared by both admin server actions and oracle API routes: `create.ts`, `resolve.ts`, `cancel.ts`. Each function runs the DB transaction and publishes realtime events.
- `db/index.ts` — exports a single `better-sqlite3` connection and a Drizzle client. Path comes from `DATABASE_URL` (defaults to `./wpm.db`). `foreign_keys = ON`.
- `db/schema/app.ts` — application tables: `balances`, `treasury` (singleton, enforced by CHECK constraint), `markets`, `ammPools`, `positions`, `transactions`. The `transactions` table is an append-only audit log of economic events — there are no signatures, blocks, or mempool.
- `db/schema/auth.ts` — better-auth's tables (generated; do not hand-edit).
- `db/migrations/`, `db/migrate.ts`, `db/seed.ts` — Drizzle Kit migrations and seeding.
- `data/` — read-side query helpers (`market.ts`, `markets.ts`, `balance.ts`, `leaderboard.ts`, `positions.ts`, `users.ts`, `health.ts`). These use Next's `"use cache"` directive with `cacheLife` and `cacheTag` so server actions can invalidate them surgically.
- `realtime/bus.ts` — a process-local `EventTarget` pinned to `globalThis`. `publish()` and `subscribe()` are the only API. In-memory only; not safe across multiple Node processes.
- `realtime/RealtimeProvider.tsx`, `realtime/useBalance.ts`, `realtime/useMarket.ts` — client provider that opens the SSE connection, plus hooks that filter events by topic for components.

#### `apps/web/src/components/`

Presentational and interactive React components. Split into feature components at the top level (`market-card.tsx`, `bet-controls.tsx`, `portfolio.tsx`, `live-odds.tsx`, etc.) and primitives under `ui/`.

#### `apps/web/src/proxy.ts`

Next.js middleware (named `proxy` here). Currently only guards `/admin/*` by redirecting unauthenticated users to `/login`.

### `packages/shared/`

Pure TypeScript library imported by both `apps/web` and `packages/oracle`. No I/O, no framework dependencies.

- `src/amm/` — constant-product AMM math: `calculateBuy`, `calculateSell`, `calculateOdds`. The single source of truth for pricing; both server actions and read-side enrichers go through it.
- `src/types/` — shared domain types (`Market`, `AMMPool`, `MarketWithOdds`, realtime event types: `PriceUpdateEvent`, `BalanceUpdateEvent`, `MarketResolvedEvent`).
- `src/crypto/` — hashing and key utilities (legacy from the chain era; still used in spots, scope is shrinking).
- `src/oracle/` — oracle API contract types shared between `apps/web` and `packages/oracle`: `CreateMarketRequest`, `ResolveMarketRequest`, `CancelMarketRequest`, `OracleMarket`.
- `src/constants.ts` — token economics constants (`INITIAL_SUPPLY`, `SIGNUP_AIRDROP`), `WEB_INTERNAL_URL` (base URL for oracle→web communication), plus port/URL constants left over from the node/api era.
- `src/categories.ts` — sport/category metadata.

### `packages/oracle/`

Standalone Node process that bridges ESPN data into the system. Uses Effect for orchestration. Communicates with the web app exclusively through REST endpoints under `/api/oracle/`, authenticated with a shared bearer token (`WPM_ORACLE_SERVICE_TOKEN`).

- `src/index.ts` — entry point. Waits for the web app to be healthy, then runs two concurrent scheduled loops: an ingest cycle (every 2 hours) that creates new markets, and a resolve/cancel cycle (every 30 minutes) that settles or cancels completed/postponed games. The two loops run with `concurrency: "unbounded"` so neither blocks the other.
- `src/adapters/{nfl,mlb,golf}.ts` — per-sport modules that query ESPN and normalize responses. NFL is the original; MLB and golf followed. Adapters also expose score and winner fields for completed games, used by the resolve pipeline.
- `src/ingest.ts`, `src/mlb-ingest.ts`, `src/golf-ingest.ts` — per-sport ingest pipelines that turn adapter output into `CreateMarketRequest` payloads, computing initial AMM reserves via `@wpm/shared`.
- `src/resolve.ts` — resolve pipeline. Fetches open markets from the web app, matches them to completed ESPN games by ESPN ID, and submits resolution outcomes. Team sports determine winner from score data; golf matches the position-1 competitor (with a guard against missing data).
- `src/cancel.ts` — cancel pipeline. Detects postponed team-sport games and cancels their corresponding markets.
- `src/market-ids.ts` — shared helpers (`extractEspnId`, `extractGolfIds`) that parse ESPN IDs out of market ID strings (e.g. `nfl-401234` → `401234`, `golf-pga-401234-56789` → `{ tournamentId, competitorId }`).
- `src/web-client.ts` — Effect service (`WebClient`) that wraps `@effect/platform`'s HTTP client. Prepends `WEB_INTERNAL_URL`, attaches the bearer token, and exposes typed methods: `health`, `getMarkets`, `createMarket`, `resolveMarket`, `cancelMarket`.
- `src/errors.ts`, `src/types.ts` — Effect-tagged errors and shared types.

### Top-level

- `docker-compose.yml` — production deployment manifest. Currently lists `wpm-node`, `wpm-api`, `wpm-oracle`, `wpm-web`, `nginx`. The `wpm-node` and `wpm-api` services correspond to the deleted packages and need to be removed as part of the cutover.
- `nginx/` — TLS termination and reverse proxy config.
- `turbo.json`, `package.json` — Bun workspaces + Turborepo orchestration.
- `scripts/` — operational scripts.

## Cross-Cutting Concerns

**Money math.** WPM has 2 decimals; all amounts are integers in the smallest unit (0.01 WPM). Every column that holds an amount or share count is an `integer` in SQLite. AMM math operates on integers and rounds at the boundary.

**Transactional writes.** Every economic action (bet, sell, distribute, resolve, cancel) reads the affected rows, computes the new state, and writes balances, pool reserves, positions, and the audit log row inside one synchronous `db.transaction(...)`. Server actions return a discriminated `ActionResult` (`{ success: true } | { error: string }`).

**Caching and invalidation.** Read-side helpers in `lib/data/` use Next's `"use cache"` with `cacheTag("market:<id>")`, `cacheTag("viewer:<userId>")`, etc. Mutations call `updateTag(...)` after the DB transaction commits, so the next render fetches fresh data without busting unrelated caches.

**Realtime.** Mutations also `publish(...)` an event to the in-process bus. `/api/stream` subscribes once per connection and writes SSE frames. Clients use `useBalance` and `useMarket` hooks to react. The bus is in-memory — horizontal scaling requires swapping it for Redis or Postgres LISTEN.

**Auth.** Better-auth owns sessions, magic-link email, and passkeys. Admin status is _not_ a database field; it is computed from `ADMIN_EMAILS`. Auth-gated routes use `requireUser` / `requireAdmin` inside actions; `/admin/*` also has a middleware redirect.

**Testing.** Vitest. Tests must verify behavior through public interfaces (server actions, helpers in `lib/data/`, AMM functions), not internal implementation details.

## Architectural Invariants

- There is no blockchain. No chain file, no mempool, no block production, no transaction signatures. The `transactions` table is a plain audit log.
- SQLite is the single source of truth. There is no separate node process or external API server holding state.
- All economic mutations happen inside a single `db.transaction(...)` block; no partial writes are ever committed.
- All AMM pricing goes through `@wpm/shared`'s `calculateBuy` / `calculateSell` / `calculateOdds`. Web routes and the oracle never re-implement pricing.
- `@wpm/shared` has no I/O and no framework dependencies. It must remain importable from any TS context.
- Admin identity lives in `ADMIN_EMAILS`, not in the database. Do not add an `is_admin` column.
- The realtime bus is process-local. Code must not assume events fan out across processes.
- The treasury is a singleton row enforced by a CHECK constraint. There is exactly one.
- The oracle never reads or writes the database directly. It communicates with the web app exclusively through the `/api/oracle/` REST endpoints, authenticated by a shared bearer token (`WPM_ORACLE_SERVICE_TOKEN`).
