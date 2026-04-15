# Implementation Plan: `apps/web` Next.js 16 Frontend

> Source: `SPEC.md`
> Generated: 2026-04-14

---

## Phase 0 — Tracer Bullets

> Two thin end-to-end slices that prove distinct architectural seams: (1) SSR + cached read from `wpm-api`, and (2) SSE proxy into a React client subtree.

### SSR Read Tracer

- [x] Add `"apps/*"` to root `package.json` workspaces; scaffold `apps/web/package.json` as `@wpm/web` with Next 16, React 19, `@wpm/shared: workspace:*`
- [x] Create `apps/web/tsconfig.json` (Next conventions, `@/*` path alias) and `apps/web/next.config.ts` with `cacheComponents: true`
- [x] Create `apps/web/src/app/layout.tsx` (minimal `<html>/<body>`) and `apps/web/src/app/page.tsx` rendering hardcoded "WPM" landing
- [x] Add `apps/web/src/lib/data/markets.ts` with a `'use cache'` `getMarkets()` loader that fetches `http://wpm-api:3000/api/markets`, tagged `markets`, lifetime `minutes`
- [x] Render market names from `getMarkets()` in a `<Dashboard />` server component behind a hardcoded `authenticated=true` flag
- [x] Author `apps/web/Dockerfile` (builder + runtime stages, Next standalone output, port 4102)
- [x] Swap `docker-compose.yml` `wpm-web.build.dockerfile` from `packages/web/Dockerfile` to `apps/web/Dockerfile`; verify `docker compose up` serves the cached market list at `:4102`

### SSE Proxy Tracer

- [x] Create `apps/web/src/app/api/stream/route.ts` — Node runtime handler that proxies `http://wpm-api:3000/events/stream` with `ReadableStream` piping and `text/event-stream` headers
- [x] Create `apps/web/src/lib/realtime/RealtimeProvider.tsx` — client component opening one `EventSource('/api/stream')`, publishing parsed events into React context
- [x] Add a throwaway `<LiveTicker />` client component mounted in `<Dashboard />` that renders the last received SSE event payload
- [ ] End-to-end check: trigger a bet on `wpm-api`, confirm the Next UI sees `price:update` propagate without refresh

---

## Phase 1 — Authentication

### Better-auth server setup

- [x] Create `apps/web/src/lib/auth.ts` — better-auth instance with `better-sqlite3` adapter pointing at `/app/data/wpm.db` (containerized) / `apps/web/data/wpm.db` (local)
- [x] Register `@better-auth/passkey` and magic-link plugins with Resend email driver; `RP_ID` + `ORIGIN` from env
- [x] Extend schema with `user.walletPublicKey` (nullable TEXT, immutable once set)
- [x] Create `apps/web/src/app/api/auth/[...all]/route.ts` — better-auth catch-all handler
- [x] Port magic-link email template from `packages/web` as-is

### Browser auth client

- [x] Create `apps/web/src/lib/auth-client.ts` exposing `authClient.signIn.magicLink` and `authClient.passkey.signIn` helpers
- [x] Build `(auth)/layout.tsx` route group using shadcn auth block as visual foundation
- [x] Implement `/login/page.tsx` — email input + passkey-primary CTA when a passkey is detected, magic-link secondary CTA
- [x] Implement `/register/page.tsx` — name + email form calling `authClient.signIn.magicLink({ email, name })`
- [x] Implement `/auth/verify/page.tsx` — completes magic-link handshake, prompts passkey enrollment, redirects to `/`

### Root routing gate

- [x] Update `app/page.tsx` to branch on `auth().session`: render `<Landing />` when null, `<Dashboard />` when authenticated
- [x] Add `isAdmin(session)` helper in `lib/auth.ts` using `process.env.ADMIN_EMAILS.split(',')`
- [x] Add `app/admin/layout.tsx` guard that 404s non-admins

### Wallet provisioning (lazy)

- [x] Create `apps/web/src/lib/wallet/provisionWalletIfNeeded.ts` — if `user.walletPublicKey` is null, POST `/api/register { userId }` to `wpm-api`, persist returned `address` to user row
- [x] Call `provisionWalletIfNeeded(userId)` from the root layout server path on first authenticated render
- [x] Verify airdrop `Distribute` lands on-chain before layout resolves (await the API response)

---

## Phase 2 — Landing & Dashboard Reads

### Landing page

- [x] Build `<Landing />` server component per design brief (techno-brutalist, monochrome, halftone chief portrait hero)
- [x] Wire Log in / Create account CTAs to `/login` and `/register`

### Cached data loaders

- [x] `lib/data/market.ts` — `getMarket(id)` tagged `market:${id}`, lifetime `minutes`
- [x] `lib/data/leaderboard.ts` — `getLeaderboard()` tagged `leaderboard`, lifetime `minutes`
- [x] `lib/data/positions.ts` — `getPositions(userId)` tagged `viewer:${userId}`, lifetime `minutes`
- [x] `lib/data/balance.ts` — `getBalance(userId)` tagged `viewer:${userId}`, lifetime `minutes`
- [x] `lib/data/users.ts` — `getUsers()` tagged `users`, lifetime `minutes` (admin-only)

### Dashboard composition

- [x] `<Header />` server component (logo + user menu) with `<Suspense>`-wrapped client `<Balance />` subtree subscribed to SSE
- [x] `<ScrollingLeaderboard />` — server fetch via `getLeaderboard()`, CSS `@keyframes` marquee, no JS animation
- [x] `<Search />` — client component filtering the hydrated markets array on name + outcome names
- [x] `<MarketList />` + `<MarketCard />` — server-rendered cards with a small client `<LiveOdds />` leaf subscribed to `market.updated`
- [x] `<Portfolio />` — server fetch via `getPositions(userId)`, shows outcome/shares/cost basis/current value/unrealized P&L, empty state if none

---

## Phase 3 — Market Detail & Mutations

### Intercepting routes

- [x] Add `app/@modal/default.tsx` returning `null`
- [x] Add `app/@modal/(.)market/[id]/page.tsx` — sheet (mobile) / side panel (desktop) wrapper around `<MarketDetail />`
- [x] Add `app/market/[id]/page.tsx` — canonical full-screen `<MarketDetail />`
- [x] Wire parallel slot `@modal` into `app/layout.tsx`

### MarketDetail component

- [x] Build `<MarketDetail id={id} />` — outcome probabilities, pool state, user's position, buy/sell controls
- [x] Data sourced from `getMarket(id)` + `getPositions(userId)` (shared with dashboard)

### Server Actions

- [x] `app/actions/placeBet.ts` — validates input with Zod, POSTs `/api/bet` to `wpm-api`, then `updateTag('market:${id}')` and `updateTag('viewer:${userId}')`
- [x] `app/actions/sellShares.ts` — validates with Zod, POSTs `/api/sell`, same tag invalidation
- [x] Wire buy/sell controls in `<MarketDetail />` to the actions; return-value plumbed to toast on success/error

---

## Phase 4 — Admin Surface

### Admin shell

- [x] `app/admin/layout.tsx` — sidebar layout with Overview / Users / Markets / System links
- [x] `app/admin/page.tsx` — overview cards (active markets, signups today, chain height)

### Admin pages

- [x] `app/admin/users/page.tsx` — table from `getUsers()` with "distribute tokens" action
- [x] `app/admin/markets/page.tsx` — list with actions: override seeds, cancel market, manual resolve
- [ ] `app/admin/system/page.tsx` — chain/oracle health panel, subscribed to elevated-filter SSE events

### Admin Server Actions

- [x] `app/actions/admin/distributeTokens.ts` — re-check `isAdmin`, dispatch to `wpm-api` `POST /internal/distribute`, invalidate `users` + `viewer:${target}`
- [x] `app/actions/admin/cancelMarket.ts` — re-check `isAdmin`, dispatch, invalidate `markets` + `market:${id}`
- [x] `app/actions/admin/resolveMarket.ts` — re-check `isAdmin`, dispatch to `/internal/resolve-market`, invalidate `markets` + `market:${id}` + `leaderboard`
- [x] `app/actions/admin/overrideSeed.ts` — re-check `isAdmin`, dispatch, invalidate `market:${id}`

---

## Phase 5 — Realtime Consumption

### Hooks

- [ ] `lib/realtime/useMarket.ts` — subscribes to `market.updated` for matching id, merges deltas into server snapshot
- [ ] `lib/realtime/useBalance.ts` — subscribes to `balance.changed` for current user
- [ ] Replace placeholder `<LiveTicker />` with real `<LiveOdds marketId={id} />` using `useMarket`
- [ ] Wire `<Balance />` in `<Header />` to `useBalance`

### Invalidation audit

- [ ] Verify each Server Action fires `updateTag(...)` for every tag listed in SPEC §9 table
- [ ] Confirm bets do NOT invalidate `markets` (live odds delivered via SSE overlay instead)

---

## Phase 6 — Build, CI, Cutover

### Build

- [ ] Finalize `apps/web/Dockerfile` — multi-stage, bun builder → slim Node runtime, preserves `better-sqlite3` native bindings, entry `node apps/web/server.js`
- [ ] Confirm `apps/web` `dev`/`build`/`start` scripts use `bunx next ...` under Node

### CI/CD

- [ ] Update `.github/workflows/deploy.yml` so `docker compose build` picks up the new `apps/web/Dockerfile` context; re-push `ghcr.io/pruett/wpm-web:latest`
- [ ] Confirm `turbo test` still passes with `"test": "echo skipped"` placeholder in `apps/web`

### Cutover PR

- [ ] Delete `packages/web` entirely (source, Dockerfile, scripts)
- [ ] Remove `@wpm/web` entry for old workspace; keep new `apps/web` as sole `@wpm/web`
- [ ] Root `package.json` workspaces stays `["packages/*", "apps/*"]`
- [ ] Deploy; retain `auth-data` volume but accept fresh schema (no user migration)
- [ ] Post-deploy smoke test: seed markets via oracle, create test account, verify magic-link → passkey → airdrop → bet → SSE price update end-to-end

---

## Phase 7 — Follow-ups (deferred)

- [ ] Automated tests (unit + E2E) — scope TBD
- [ ] Richer magic-link email template
- [ ] Observability (metrics/tracing)
- [ ] PWA manifest carryover from `packages/web`
