# Code Structure & Conventions

These rules formalize how Wampum organizes data fetching, server actions, and shared modules. They reflect patterns already established in the codebase — when in doubt, follow precedent in `src/data/`, `src/actions/`, and `src/lib/`.

The directory layout under `src/`:

```
src/
  app/         Next.js routes only — pages, layouts, route handlers. No business logic.
  actions/     Server Actions ("use server") — thin write entrypoints called from client components.
  data/        Data Access Layer ("server-only") — every server-side read of app data lives here.
  lib/         Pure domain logic, infra clients, shared types. No React, no Next-isms (with rare exceptions).
  components/  React components. UI primitives in components/ui/.
  hooks/       Client React hooks.
  providers/   React context providers (client).
```

---

## 1. `src/data/` — the Data Access Layer

**Rule 1.1 — All server-side reads of app data go through `src/data/`.**
Route handlers, pages, layouts, server components, and server actions must call a `data/` function rather than hitting Drizzle, Better-Auth, or external APIs directly. The exceptions are write paths that already live inside `data/trading.ts` (see §2.3) and infra wiring inside `lib/`.

**Rule 1.2 — Every `data/` module starts with `import "server-only";`.**
This prevents a DAL function from being accidentally bundled into a client component.

**Rule 1.3 — One file per domain noun.**
Files are named after the entity they read: `markets.ts`, `positions.ts`, `balances.ts`, `leaderboard.ts`, `auth.ts`, `tags.ts`. Don't create generic catch-alls (`queries.ts`, `db-helpers.ts`). If a function reads across two domains, put it with the *primary* noun.

**Rule 1.4 — Export the read functions, not the queries.**
The DAL returns plain serializable types from `lib/types.ts` (or a colocated exported type). Drizzle row shapes, query builders, and `db.query.*` calls are implementation detail — they never leak to callers. See `markets.ts` `toMarket` / `toPool` / `enrichMarket` for the pattern: query → map → return plain type.

**Rule 1.5 — Cache reads with `"use cache"` + `cacheLife` + `cacheTag`.**
The standard prologue for a cached read is:

```ts
export async function getX(id: string): Promise<X> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.x(id));
  // ...query
}
```

Pick the tightest tag that covers the data. Per-entity reads tag with the entity tag; viewer-scoped reads tag with `tags.viewer(userId)`.

**Rule 1.6 — All cache tags live in `src/data/tags.ts`.**
Never inline a tag string. Add a new factory to `tags.ts` before using it. This is the single source of truth that both readers (`cacheTag`) and writers (`revalidateTag`) reference.

**Rule 1.7 — Per-request memoization uses `cache()` from React, not `"use cache"`.**
Use React's `cache()` for per-request dedup of things that should not survive across requests — auth/session reads being the canonical example (see `data/auth.ts:getSession`). Use `"use cache"` for cross-request data caches.

**Rule 1.8 — Auth reads expose three shapes:** `getSession()` (raw), `getCurrentUser()` (nullable user), and `requireUser()` (returns `{session} | {error}` for callers that need to gate). Never re-implement these elsewhere.

**Rule 1.9 — Avoid waterfalls inside a single read.**
When a read needs multiple independent queries, parallelize with `Promise.all` (per `async-parallel`). When a page needs multiple `data/` reads, kick them off in parallel at the page level — do not chain `await getX(); await getY();` if they're independent.

---

## 2. `src/actions/` — Server Actions

**Rule 2.1 — One file per action.** Files are verb-named: `placeBet.ts`, `sellShares.ts`. The default export shape is a single named function matching the filename.

**Rule 2.2 — Every actions file starts with `"use server";`.**

**Rule 2.3 — Actions are thin: validate → delegate → revalidate → return.**
The canonical shape (see `actions/placeBet.ts`):

```ts
"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod/v4";
import { type ActionResult } from "@/data/auth";
import { tags } from "@/data/tags";
import { placeBet as placeBetDAL } from "@/data/trading";

const Input = z.object({ /* ... */ });

export async function placeBet(input: z.input<typeof Input>): Promise<ActionResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const result = await placeBetDAL(parsed.data);
    revalidateTag(tags.market(result.marketId), "max");
    revalidateTag(tags.viewer(result.userId), "max");
    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Bet failed" };
  }
}
```

No business logic in the action body — that lives in `data/` (or `lib/` for pure logic). The action's job is the boundary: parse input, call the write, invalidate caches, normalize errors.

**Rule 2.4 — Always validate input with Zod.** Even when the caller is your own typed client — server actions are a public network surface.

**Rule 2.5 — Return `ActionResult`** (`{success: true} | {error: string}`) from every action, unless the action genuinely needs to return data to the caller. Don't throw across the action boundary.

**Rule 2.6 — Auth check happens in the DAL write, not the action.**
Writes in `data/trading.ts` call `requireUser()` themselves. The action does not pre-check auth — the DAL is the enforcement point so any caller (action, route handler, cron) gets the same gate.

**Rule 2.7 — Always invalidate after writes.** Use `revalidateTag(tags.x(id), "max")` for every cache tag whose underlying data changed. Listing every tag is intentional; under-invalidating is the more common bug than over-invalidating.

**Rule 2.8 — Writes belong in `data/`, exposed *through* `actions/`.**
DAL write functions (e.g. `placeBet`, `sellShares` in `data/trading.ts`) contain the transaction and domain enforcement. The matching action in `actions/` is a wrapper. This keeps writes callable from non-action contexts (cron jobs, route handlers, tests) without going through the `"use server"` boundary.

---

## 3. `src/lib/` — domain logic, infra, types

`lib/` holds everything that is *not* a Next.js route, a server action, or a DAL function. Its contents fall into four buckets:

### 3.1 Pure domain modules (top-level files)
`amm.ts`, `settlement.ts`, `utils.ts`, `constants.ts`, `types.ts`.

- Pure functions, no I/O, no Next.js imports.
- Co-locate tests next to the module: `amm.ts` ↔ `amm.test.ts`.
- These modules are the only place where domain math/rules live. The DAL composes them; it does not re-implement them.

### 3.2 Infra clients (subdirectories with `index.ts`)
`lib/db/`, `lib/auth.ts` + `lib/auth-client.ts`.

- One folder (or pair) per external dependency.
- Export a configured singleton (`db`, `auth`) — callers never construct their own.
- Schema, migrations, and seeds live alongside the client (`lib/db/schema/`, `lib/db/migrations/`, `lib/db/seeds/`).

### 3.3 External integrations (subdirectories)
`lib/kalshi/` is the template:

```
lib/kalshi/
  index.ts          # public surface — re-exports the integration's API
  translator.ts     # external shape → internal shape (pure)
  ingest.ts         # orchestration: fetch + translate + persist
  resolve.ts        # orchestration: fetch + apply resolution
  fixtures/         # captured external responses for tests
  *.test.ts         # unit tests
  *.contract.test.ts # contract tests against the live API
```

Rules for any new integration folder:
- A `translator.ts` (or equivalent) isolates pure mapping from external → internal shape. It has no I/O.
- An `index.ts` is the only thing the rest of the app imports from. Internal files are not imported across the integration boundary.
- Contract tests have their own filename suffix (`*.contract.test.ts`) and run via `vitest.contract.config.ts`.

### 3.4 Shared types (`lib/types.ts`)
Cross-cutting domain types (`Market`, `AMMPool`, `SharePosition`, `Transaction`). Types used by exactly one module live in that module instead.

### 3.5 What does *not* go in `lib/`
- React components or hooks (those go in `components/`, `hooks/`).
- `revalidateTag`, `cookies()`, `headers()`, route-handler glue. Those belong in `data/` or `actions/`.
- Per-feature one-off helpers — colocate them with the consumer.

---

## 4. `src/app/` — routes only

**Rule 4.1 — Pages and layouts call `data/` for reads and `actions/` for writes. Nothing else.**
A page should look like: `await Promise.all([getX(), getY()])` then render. No Drizzle imports, no Better-Auth imports, no inline business logic.

**Rule 4.2 — Route handlers (`app/api/.../route.ts`) follow the same rule** — they're a thin protocol adapter over `data/` and `actions/` (or, for cron, over an integration's `ingest`/`resolve` orchestrator in `lib/`).

**Rule 4.3 — Route groups encode access boundaries, not features.**
`(app)` = authenticated app, `(auth)` = auth flows, `welcome/` = public. Don't add a route group to organize features — use folder nesting.

**Rule 4.4 — Parallel routes (`@modal`) and intercepting routes (`(.)`) are the standard for modal flows.** See `app/(app)/@modal/(.)event/[id]/` for the reference pattern. Don't reach for client-only modals when the route can express it.

---

## 5. Naming conventions

| Kind | Style | Example |
|---|---|---|
| `data/` files | plural noun, kebab unnecessary (single word) | `markets.ts`, `positions.ts` |
| `data/` functions | `getX`, `createX`, `resolveX` | `getMarket`, `createMarket` |
| `actions/` files | camelCase verb matching the export | `placeBet.ts` |
| `lib/` files | kebab-case for multi-word | `auth-client.ts` |
| Components | kebab-case file, PascalCase export | `market-card.tsx` → `MarketCard` |
| Tests | `<module>.test.ts` colocated | `amm.test.ts` |
| Cache tag factories | noun in `tags.ts` | `tags.market(id)` |

---

## 6. Import order

Match the existing pattern (see `data/markets.ts`):

1. `"server-only"` / `"use server"` / `"use client"` directive
2. Node / external packages
3. Type-only imports from `@/lib/...`
4. Value imports from `@/lib/...`
5. Sibling imports (`./tags`)

Use the `@/` path alias for anything outside the current folder; relative imports only for siblings.

---

## 7. Quick decision guide

- **Need to read app data from a page/component?** → call `data/<noun>.ts`. Add the function there if missing.
- **Need to write app data from a client component?** → server action in `actions/<verb>.ts`, which calls a write in `data/`.
- **Need to write from a cron / route handler?** → call the `data/` write directly; skip the action.
- **Need a new cache invalidation key?** → add a factory to `data/tags.ts` first.
- **Pure function with no I/O?** → `lib/`, with a colocated `.test.ts`.
- **Integrating a new external API?** → new `lib/<provider>/` folder with `translator.ts` + `index.ts` + fixtures.
- **Tempted to put logic in `app/`?** → don't. Push it to `data/`, `actions/`, or `lib/`.
