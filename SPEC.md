# `apps/web` — Next.js 16 Frontend Specification

## 1. Overview

New Next.js 16 application at `apps/web`. **Hard replacement** for the existing SvelteKit `packages/web`. Same role in the system (user-facing PWA + admin portal), same custodial wallet model, same chain contract — rebuilt on App Router with `cacheComponents`, Server Components, and Server Actions following the patterns in `NEXTJS_SERVER_DATA_PATTERN.md`.

The existing `packages/web` is deleted in the same PR that lands `apps/web`. There is no user migration — the production database is wiped and re-seeded.

## 2. Scope & Non-Goals

### In scope

- Landing page (unauthenticated)
- `/login` and `/register` with magic-link bootstrap + optional passkey attestation
- Dashboard (authenticated home) with live markets, leaderboard, search, active positions
- Market detail via intercepting route (modal over dashboard, canonical deep-link target)
- Full admin surface: distribute tokens, override seeds, cancel markets, manual resolve, user management, chain/oracle health
- Real-time updates via SSE proxied through Next.js
- Custodial wallet provisioning + signup airdrop (lazy, on first authenticated page load)

### Explicitly out of scope

- Invite codes (removed from the product)
- User migration from `packages/web` (fresh DB)
- Automated tests (deferred; may be added in a follow-up)
- Historical bet/settlement history UI (only active positions at MVP)

---

## 3. Topology

### 3.1 Container layout

`docker-compose.yml` replaces the existing `wpm-web` service 1:1 with the new Next.js build. **Service name stays `wpm-web`**, port stays `4102`, volume name stays `auth-data`. Nginx config does not change.

```yaml
wpm-web:
  image: ghcr.io/pruett/wpm-web:latest
  build:
    context: .
    dockerfile: apps/web/Dockerfile
  restart: unless-stopped
  depends_on:
    wpm-api:
      condition: service_healthy
  environment:
    - PORT=4102
    - API_URL=http://wpm-api:3000
    - BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
    - BETTER_AUTH_URL=https://${DOMAIN}
    - RESEND_API_KEY=${RESEND_API_KEY}
    - EMAIL_FROM=${EMAIL_FROM:-WPM <noreply@wpm.cash>}
    - RP_ID=${DOMAIN}
    - ORIGIN=https://${DOMAIN}
    - ADMIN_EMAILS=pruett.kevin@gmail.com
    - NODE_ENV=production
  volumes:
    - auth-data:/app/data
  networks:
    - wpm-net
```

### 3.2 Data flow (hybrid)

- **Reads (SSR path):** Server Components call `http://wpm-api:3000/...` directly via `fetch`. Results pass through `'use cache'` functions with appropriate tags.
- **Mutations (client path):** Client components invoke **Server Actions**. Server Actions call `wpm-api` and then `updateTag(...)` to bust relevant cache keys.
- **Real-time:** Browser opens a single `EventSource` to `/api/stream` (Next route handler), which proxies `wpm-api`'s SSE endpoint. A `<RealtimeProvider>` broadcasts events into React context.
- **No `/api/markets` route handler.** The list is fetched server-side and hydrated; client-side search is a filter over that hydrated array.

### 3.3 Runtime

All routes Node runtime. `better-sqlite3` is a native module and SSE requires persistent connections — Edge is unusable for this app.

---

## 4. Monorepo Scaffolding

### 4.1 Workspace

Root `package.json` workspaces array adds `"apps/*"`:

```json
"workspaces": ["packages/*", "apps/*"]
```

No other root changes needed. `turbo.json` pipelines (`build`, `test`, `dev`) automatically pick up `apps/web` scripts.

### 4.2 `apps/web/package.json`

- `"name": "@wpm/web"` (reuse the existing name once `packages/web` is deleted)
- `"dependencies"`: `next@^16`, `react@^19`, `react-dom@^19`, `better-auth`, `@better-auth/passkey`, `better-sqlite3`, `resend`, `@wpm/shared: "workspace:*"`, shadcn-svelte→**shadcn** (React; Svelte version is in `packages/web` and not applicable), `clsx`, `tailwind-merge`, `lucide-react`, `zod`
- Dev: `typescript`, `@types/react`, `@types/node`, `tailwindcss@^4`, `@tailwindcss/postcss`, `postcss`
- Scripts:
  - `"dev": "bunx next dev --port $PORT"` (bunx launches Next under Node; avoids SWC/Turbopack quirks under the bun runtime)
  - `"build": "bunx next build"`
  - `"start": "bunx next start --port $PORT"`
  - `"test": "echo skipped"` (placeholder so turbo doesn't complain)

### 4.3 `apps/web/tsconfig.json`

Standalone. Next.js conventions: `"jsx": "preserve"`, `"moduleResolution": "bundler"`, `"plugins": [{ "name": "next" }]`, `"paths": { "@/*": ["./src/*"] }`.

### 4.4 `apps/web/next.config.ts`

```ts
const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    /* as needed */
  },
};
```

### 4.5 Lint/format

Inherit root `oxlint` and `oxfmt`. No scoped ESLint config. Accepted gap: no Next.js-specific lint rules. Revisit if it causes problems.

---

## 5. Authentication

### 5.1 Stack

- `better-auth` core
- `@better-auth/passkey` plugin (WebAuthn)
- Magic-link plugin (bootstrap + recovery)
- better-sqlite3 adapter, DB file at `/app/data/wpm.db` (volume-mounted in container, `apps/web/data/wpm.db` locally)

### 5.2 Config location

- `apps/web/src/lib/auth.ts` — server-side better-auth instance
- `apps/web/src/lib/auth-client.ts` — browser client
- `apps/web/src/app/api/auth/[...all]/route.ts` — better-auth catch-all handler

### 5.3 Schema extensions

Beyond better-auth's canonical tables (`user`, `session`, `account`, `passkey`, `verification`), add:

- `user.walletPublicKey` — nullable TEXT. Written once, when `wpm-api` provisions the wallet on first authenticated page load. Immutable thereafter.

No invite_code table. No role column (admin gated by env var).

### 5.4 Signup flow

1. Visitor hits `/register`, enters name + email.
2. Server Action calls `authClient.signIn.magicLink({ email, name })` → better-auth creates `user` row and emails a magic-link token via Resend.
3. Visitor clicks link → lands on `/auth/verify` → session established.
4. `/auth/verify` prompts to add a passkey. Success or dismissal both redirect to `/`.
5. On first authenticated `/` render, server-side layout load calls `provisionWalletIfNeeded(userId)` — if `user.walletPublicKey` is null, POSTs to `wpm-api` `POST /api/register { userId }`, receives `{ address }`, writes it back to `user.walletPublicKey`. `wpm-api` submits the 100,000 WPM `Distribute` to the chain in the same handler.

### 5.5 Login flow

1. Visitor hits `/login`, enters email.
2. If they have a passkey registered, primary CTA is "Sign in with passkey" (navigator.credentials.get flow via better-auth client).
3. Secondary CTA: "Send me a magic link" — works for users who've never registered a passkey or lost their device.

### 5.6 Admin gating

- Helper `isAdmin(session)` returns `true` if `session.user.email` is in `process.env.ADMIN_EMAILS.split(',')`.
- Middleware or layout-level guard on `/admin/*` routes: non-admins get a 404.
- Server Actions for admin mutations re-check `isAdmin` before dispatching to `wpm-api`.

---

## 6. Routing

### 6.1 File tree (abridged)

```
apps/web/src/app/
  layout.tsx                       # RootLayout: fonts, <html>, <body>, <Providers>
  page.tsx                         # /, conditional render (landing vs dashboard)
  login/
    page.tsx                       # /login
  register/
    page.tsx                       # /register
  auth/
    verify/page.tsx                # magic-link landing + passkey upsell
  @modal/                          # parallel route slot for intercepted market detail
    default.tsx                    # renders null when not intercepted
    (.)market/[id]/page.tsx        # sheet/modal interceptor
  market/
    [id]/page.tsx                  # canonical market detail (deep-link target)
  admin/
    layout.tsx                     # admin gate
    page.tsx                       # admin dashboard
    users/page.tsx
    markets/page.tsx
    system/page.tsx                # chain/oracle health
  api/
    auth/[...all]/route.ts         # better-auth
    stream/route.ts                # SSE proxy to wpm-api
```

### 6.2 Root `page.tsx`

- If `auth().session` is null → render `<Landing />` (unauthenticated marketing page).
- If authenticated → render `<Dashboard />`.
- Both branches live in the same route; no redirect.

### 6.3 Intercepting route for market detail

- `/market/[id]` (canonical) and `/@modal/(.)market/[id]` (interceptor) both render a shared `<MarketDetail id={id} />` component.
- When navigating from the dashboard, the interceptor renders as a sheet (mobile) or side panel (desktop).
- On refresh, direct link, or share, the canonical page renders full-screen. Same component, same data.
- Both variants use the same `'use cache'` `getMarket(id)` loader.

---

## 7. Component Composition

Follows `.claude/skills/vercel-composition-patterns` and `.claude/skills/vercel-react-best-practices`. All shadcn components installed via the **shadcn skill**.

### 7.1 Landing page (`<Landing />`)

Design brief — invoke `frontend-design` skill when implementing.

- Techno-brutalist aesthetic, minimalism, monochrome palette.
- Hero: dot-matrix / halftone shader rendering a Native American chief portrait. Thematic hook: Wampum is shell-bead currency of the Northeastern Woodland peoples.
- Primary CTA (solid button): "Log in" → `/login`
- Secondary CTA (outline button): "Create account" → `/register`
- No other content. Single viewport.

### 7.2 Auth layout (`/login`, `/register`)

- Shared `(auth)/layout.tsx` route group.
- shadcn/ui auth block template as the visual foundation.
- Forms use better-auth client hooks (`authClient.signIn.magicLink`, `authClient.passkey.signIn`).

### 7.3 Dashboard (authenticated `/`)

Component tree:

```
<Dashboard>
  <Header />                       # logo, balance (server-fetched, live via SSE), user menu
  <ScrollingLeaderboard />         # all-time total WPM, top 10, horizontal marquee
  <Search />                       # client-side text filter, controlled input
  <MarketList markets={…} />       # server-fetched, hydrated; renders <MarketCard>s
  <Portfolio />                    # active share positions, cost basis, current value, P&L
</Dashboard>
```

**`<Header>`**: Server component for static structure + cached user data (name). Balance is a client subtree subscribed to SSE — wrapped in `<Suspense>`.

**`<ScrollingLeaderboard>`**: Server component fetches top 10 via `'use cache'` `getLeaderboard()` with `cacheTag('leaderboard')`, `cacheLife('minutes')`. Marquee animation is CSS-only (`@keyframes`), no JS. Invalidated on resolve/settle transactions that change balances.

**`<Search>`**: Client component. Holds query state. Filters the hydrated `markets` array passed from parent. Matches against market name + outcome names. No server round-trip.

**`<MarketList>`**: Server component. Receives markets array from parent. Each item is a `<MarketCard>`. `<MarketCard>` is mostly server-rendered, with a small client-component for the live-odds display (subscribed via `<RealtimeProvider>`).

**`<Portfolio>`**: Server component. Fetches current user's positions via `'use cache'` `getPositions(userId)` with `cacheTag('viewer:${userId}')`. Renders empty state if no positions. Each row shows outcome, shares held, cost basis, current value (computed from market price), unrealized P&L.

### 7.4 Market detail (`<MarketDetail>`)

- Used by both canonical and intercepting routes.
- Shows outcome probabilities, pool state, user's current position in this market, buy/sell controls.
- Controls call `placeBet` / `sellShares` Server Actions. Actions call `wpm-api`, then `updateTag('market:${id}')` and `updateTag('viewer:${userId}')`.

### 7.5 Admin (`/admin/*`)

- Sidebar layout. Sections: Overview, Users, Markets, System.
- Each admin action is a Server Action that re-verifies `isAdmin` then dispatches to `wpm-api` internal endpoints.
- System page subscribes to the same SSE stream with elevated event filters (chain health, oracle status).

---

## 8. Real-Time (SSE)

### 8.1 Proxy route

`apps/web/src/app/api/stream/route.ts`:

- Opens a `fetch` against `http://wpm-api:3000/api/stream` with `{ cache: 'no-store' }` and `ReadableStream` piping.
- Forwards `text/event-stream` headers.
- Closes upstream when the client disconnects.

### 8.2 Provider

`<RealtimeProvider>` is a client component mounted near the root of authenticated layouts. One `EventSource` for the lifetime of the session. Publishes events into a React context keyed by event type (`market.updated`, `market.resolved`, `balance.changed`, etc.).

### 8.3 Consumption hooks

- `useMarket(id)` — subscribes to `market.updated` events with matching `id`, merges deltas into the initial server-provided snapshot.
- `useBalance()` — subscribes to `balance.changed` for the current user.
- Hooks live in `apps/web/src/lib/realtime/`.

---

## 9. Caching Strategy

Follows `NEXTJS_SERVER_DATA_PATTERN.md`. All cached data loaders live in `apps/web/src/lib/data/`.

| Loader                 | Tag                | Lifetime  | Invalidated by                                                           |
| ---------------------- | ------------------ | --------- | ------------------------------------------------------------------------ |
| `getMarkets()`         | `markets`          | `minutes` | `CreateMarket`, `CancelMarket`, `ResolveMarket`                          |
| `getMarket(id)`        | `market:${id}`     | `minutes` | `PlaceBet`, `SellShares`, `ResolveMarket`, `CancelMarket` on that market |
| `getLeaderboard()`     | `leaderboard`      | `minutes` | Settle payouts                                                           |
| `getPositions(userId)` | `viewer:${userId}` | `minutes` | Any tx touching that user                                                |
| `getBalance(userId)`   | `viewer:${userId}` | `minutes` | Any tx touching that user                                                |
| `getUsers()` (admin)   | `users`            | `minutes` | Signup                                                                   |

**Key decision:** bets do **not** invalidate `markets`. The list's initial render stays cached; SSE overlays live odds on top. Invalidating `markets` on every bet would churn the most-requested cache entry for cosmetic jitter.

Server Actions fire `updateTag(...)` after the `wpm-api` call succeeds, before returning to the client.

---

## 10. Build & Deployment

### 10.1 Dockerfile

`apps/web/Dockerfile` — multi-stage build. Mirror the pattern from `packages/web/Dockerfile`:

1. Builder stage: `oven/bun` base, install workspace, run `bunx next build`.
2. Runtime stage: slim Node image, copy `.next/standalone`, `.next/static`, `public/`, and the bun-installed `node_modules` necessary for `better-sqlite3` native bindings.
3. Expose 4102. Entry: `node apps/web/server.js` (Next standalone output).

### 10.2 CI/CD

GitHub Actions workflow needs a new job (or matrix entry) to build and push `ghcr.io/pruett/wpm-web:latest` from the new Dockerfile. The existing `wpm-web` image tag is reused; deploy step (`docker compose pull && up -d`) is unchanged.

---

## 11. Cutover

1. Land `apps/web` alongside `packages/web` on a branch. Verify locally via `docker compose up`.
2. In the merge PR: delete `packages/web` entirely; update root `package.json` workspaces (`packages/*` stays — `packages/web` just no longer exists).
3. Deploy. `auth-data` volume is retained but the schema inside will be fresh — acceptable because the app is friend-scale and no existing users need to survive.
4. First admin action post-deploy: add markets via oracle, verify airdrop-on-signup + passkey + bet flow end-to-end with a test account.

---

## 12. Open Items / Follow-ups

- Automated tests (unit + E2E) — scope TBD after MVP lands.
- Email template design for magic-link (currently plain from `packages/web`; can upgrade later).
- Observability: no metrics/tracing spec yet.
- Mobile install UX (PWA manifest) — carry over from `packages/web` if present.

---

## Appendix A — Decision Log

Captured for future-you. Full context in the spec conversation.

| Decision                       | Chose                                                              | Over                      |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------- |
| Relationship to `packages/web` | Hard replacement                                                   | Parallel rebuild          |
| Container strategy             | Replace `wpm-web` 1:1                                              | New service alongside     |
| API data flow                  | Hybrid (SC direct + Next route handlers for mutations/SSE)         | Pure proxy                |
| Signup                         | Magic-link primary, passkey additive, lazy wallet                  | Passkey-first             |
| User ID on chain               | Pubkey (unchanged) with app-side mapping on `user.walletPublicKey` | Chain-level userId        |
| Orphan handling                | Lazy provisioning sidesteps it                                     | Transactional signup hook |
| Betting UI                     | Intercepting routes (modal over dashboard + canonical detail)      | Inline, separate page     |
| Admin gating                   | `ADMIN_EMAILS` env var                                             | Role column, chain-level  |
| Cache tagging                  | List + per-market + per-viewer                                     | Single global tag         |
| Lint for Next.js               | Accept oxlint gap                                                  | Add scoped ESLint         |
| Bun + Next                     | `bunx next` under Node                                             | `bun next` native         |
