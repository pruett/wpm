# Architecture of WPM (Wampum)

## Bird's Eye View

WPM is a prediction market platform for a small friend group: binary sports betting on game moneylines, priced by an Automated Market Maker (AMM). Users get an airdrop of WPM tokens at signup and trade outcome shares against per-market liquidity pools seeded by a treasury.

The system is a single Next.js application. It owns the user-facing UI, the server-side business logic, and the Postgres database (Neon in production) that stores balances, markets, positions, pools, and an audit log of every economic event. All mutations flow through server actions writing inside a single DB transaction.

Market ingest runs as a Vercel Cron job — a scheduled `GET /api/cron/ingest` that pulls schedules from Kalshi and creates missing markets.

## Code Map

### `src/app/`

Routes, layouts, and server actions following the App Router conventions.

### `src/app/api/cron/ingest/`

The Kalshi ingest cron route. Runs on a Vercel Cron schedule defined in `vercel.json`. Authenticated via `Authorization: Bearer ${CRON_SECRET}`.

### `src/lib/`

Server-side libraries used by routes and actions. Notable modules:

- `amm.ts` — pure AMM math (buy, sell, odds).
- `categories.ts` — sport category metadata.
- `constants.ts` — monetary supply constants.
- `types.ts` — domain types shared across the app.
- `kalshi/` — Kalshi API schemas and ingest logic.
- `auth/` — better-auth server + client.
- `db/` — drizzle schema and migrations.

## Cross-Cutting Concerns

**Caching and invalidation.** Read-side helpers in `data/` use Next's `"use cache"` with `cacheTag("market:<id>")`, `cacheTag("viewer:<userId>")`, etc. Mutations call `revalidateTag(...)` after the DB transaction commits.

**Auth.** Better-auth owns sessions, magic-link email, and passkeys. Admin status is computed from the `ADMIN_EMAILS` env var.

## Hosting

- **App:** Vercel (Pro plan — cron routes use `maxDuration = 300`).
- **Database:** Neon Postgres via `DATABASE_URL` (pooled).
- **Local dev:** `docker compose up wpm-db` starts a Postgres container; `bun dev` runs Next.
