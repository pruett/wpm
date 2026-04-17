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

#### `apps/web/src/lib/`

Server-side libraries used by routes and actions.

#### `apps/web/src/proxy.ts`

Next.js middleware

#### DB and schema

- `apps/web/wpm.db` - sqlite db
- `apps/web/drizzle.config.ts` and `apps/web/src/lib/db` - db configuration

### `packages/shared/`

Pure TypeScript library imported by both `apps/web` and `packages/oracle`. No I/O, no framework dependencies.

### `packages/oracle/`

Standalone Node process that bridges ESPN data into the system. Uses Effect for orchestration. Communicates with the web app exclusively through REST endpoints under `/api/oracle/`, authenticated with a shared bearer token (`WPM_ORACLE_SERVICE_TOKEN`).

## Cross-Cutting Concerns

**Caching and invalidation.** Read-side helpers in `lib/data/` use Next's `"use cache"` with `cacheTag("market:<id>")`, `cacheTag("viewer:<userId>")`, etc. Mutations call `updateTag(...)` after the DB transaction commits, so the next render fetches fresh data without busting unrelated caches.

**Auth.** Better-auth owns sessions, magic-link email, and passkeys. Admin status is _not_ a database field; it is computed from `ADMIN_EMAILS`. Auth-gated routes use `requireUser` / `requireAdmin` inside actions; `/admin/*` also has a middleware redirect.

## Architectural Invariants

- The `transactions` table is a plain audit log.
- SQLite is the single source of truth. There is no separate node process or external API server holding state.
- The oracle never reads or writes the database directly. It communicates with the web app exclusively through the `/api/oracle/` REST endpoints, authenticated by a shared bearer token (`WPM_ORACLE_SERVICE_TOKEN`).
