# Cleanup Plan: Monorepo → Single Next.js on Vercel

## Goals

- Delete `packages/oracle` and `packages/shared`; fold remaining contents into the web app
- Replace the out-of-process oracle daemon with Vercel Cron → route handlers (Kalshi pattern)
- Drop realtime entirely for now; reintroduce on Vercel-native primitives later
- Host on Vercel with Neon Postgres (single `DATABASE_URL`)
- Keep `docker-compose.yml` as local-only Postgres; remove all Docker deployment artifacts
- Collapse the monorepo to a single root Next.js project

## Constraints / Decisions Locked In

- Single env var for DB: `DATABASE_URL` (Neon pooled). Revisit split when graduating from `drizzle-kit push` to formal migrations.
- Vercel Pro plan assumed. Cron routes use `export const maxDuration = 300; export const dynamic = 'force-dynamic';`
- Cron auth via `Authorization: Bearer ${CRON_SECRET}` (Vercel convention). Retire `WPM_ORACLE_SERVICE_TOKEN`.
- Flat `src/lib/*.ts` layout for ported shared code — no nested `lib/domain/`.
- Swap Effect `Schema` for Zod in Kalshi ingest.
- Market resolution and cancellation are **out of scope** — punted to follow-up work.

---

## Phase 1 — Drop realtime

No dependencies; purges imports that would otherwise block Phase 3.

- Delete `apps/web/src/lib/events/bus.ts`
- Delete `apps/web/src/app/api/stream/` (SSE route)
- Delete client-side realtime provider/consumers; rip `subscribe()` callers
- Remove `publish()` calls from `apps/web/src/data/markets.ts` and `trading.ts`
- Event types (`PriceUpdateEvent`, `MarketResolvedEvent`, `BalanceUpdateEvent`) are dropped in Phase 3 — not ported

## Phase 2 — Delete dead HTTP surface + admin

- Delete `apps/web/src/app/api/oracle/health/`
- Delete `apps/web/src/app/api/oracle/heartbeat/`
- Delete `apps/web/src/app/api/oracle/markets/` (create + `[id]/resolve` + `[id]/cancel`)
- Delete `apps/web/src/actions/admin/` entirely
- Delete admin frontend routes (`apps/web/src/app/admin/` or wherever they live)
- Leave `apps/web/src/app/api/oracle/kalshi/` in place — it relocates in Phase 6

## Phase 3 — Inline `@wpm/shared` into `apps/web/src/lib/`

| From `packages/shared/src/`                  | To `apps/web/src/lib/`                |
| -------------------------------------------- | ------------------------------------- |
| `amm/index.ts`                               | `amm.ts`                              |
| `categories.ts`                              | `categories.ts`                       |
| `constants.ts` (drop `WEB_INTERNAL_URL`)     | `constants.ts`                        |
| `types/index.ts` (drop realtime event types) | `types.ts`                            |
| `oracle/index.ts`                            | **delete** — IPC contracts, no caller |

- Find-and-replace `@wpm/shared` → `@/lib/amm` / `@/lib/categories` / `@/lib/constants` / `@/lib/types`
- Remove `@wpm/shared` from `apps/web/package.json`
- Typecheck must pass before moving on

## Phase 4 — Swap Effect Schema for Zod in Kalshi ingest

- Replace `Schema.decodeUnknownSync(KalshiEventsResponse)` with a Zod schema and `.parse()` in `apps/web/src/lib/kalshi/`
- Add `zod`; remove `effect` from `apps/web/package.json` if no other callers remain (grep first)

## Phase 5 — Delete the dead packages

- `rm -rf packages/oracle`
- `rm -rf packages/shared`
- `rm -rf packages/`

## Phase 6 — Collapse monorepo to single root Next.js project

- Move `apps/web/*` (and dotfiles) to repo root; merge `apps/web/package.json` into root `package.json`
- `rm -rf apps/`
- Delete `turbo.json`; remove `turbo` dep; remove `workspaces` from root `package.json`
- Rename Kalshi ingest: `src/app/api/oracle/kalshi/ingest/route.ts` → `src/app/api/cron/ingest/route.ts`
  - Handler checks `Authorization: Bearer ${CRON_SECRET}`, returns 401 on mismatch
  - `export const maxDuration = 300;`
  - `export const dynamic = 'force-dynamic';`
- Delete `src/app/api/oracle/` (now empty)

## Phase 7 — Kill Docker-for-deploy; keep docker-compose for local Postgres only

- Delete `apps/web/Dockerfile`
- Delete `nginx/`
- Trim `docker-compose.yml` to a single `wpm-db` Postgres service
- Update `AGENTS.md` / `ARCHITECTURE.md` to reflect Vercel hosting topology

## Phase 8 — Vercel config

- Add `vercel.json`:
  ```json
  { "crons": [{ "path": "/api/cron/ingest", "schedule": "0 */2 * * *" }] }
  ```
- Vercel env vars: `DATABASE_URL` (Neon pooled), `BETTER_AUTH_SECRET`, `CRON_SECRET`, admin emails
- Grep for `WPM_ORACLE_SERVICE_TOKEN` — must return zero references

## Phase 9 — Verify before deploy

- `drizzle-kit push` against Neon using prod `DATABASE_URL` (one-time schema sync)
- Confirm `src/lib/auth.ts` (better-auth) uses the Drizzle PG adapter for sessions — not in-memory
- Local dev smoke test: `docker compose up wpm-db`, `bun dev`, exercise signup / market list / trade
- Deploy preview; `curl` `/api/cron/ingest` with bearer token; confirm markets created

---

## Appendix — Follow-up work (explicitly out of scope)

1. **Market resolution** — new `/api/cron/resolve` using Kalshi settlement data; replaces deleted `packages/oracle/src/resolve.ts`
2. **Market cancellation** — same shape, for postponed/voided Kalshi markets
3. **Realtime** — re-implement on Vercel-native primitives (Upstash Redis pub/sub, Postgres `LISTEN/NOTIFY`, or Vercel's realtime offering); reintroduce event types and client subscribers
4. **Per-series cron fan-out** — if ingest flirts with `maxDuration`, split into `/api/cron/ingest/[series]` with individual schedules
5. **Formal Drizzle migrations** — graduate from `drizzle-kit push` to migration files; add `DATABASE_URL_UNPOOLED` for the migrator
6. **Admin UI** — rebuild against the current data layer once requirements are clear
