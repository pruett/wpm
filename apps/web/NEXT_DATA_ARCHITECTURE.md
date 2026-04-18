# Next.js 16 Data Architecture

This document describes the data flow for the WPM web app. It is built on Next.js 16 Cache Components, the [Next.js Data Access Layer (DAL) pattern](https://nextjs.org/docs/app/guides/data-security#data-access-layer), SQLite via Drizzle, and better-auth.

## The three rules

1. **Every read and write goes through `src/data/`.** A Server Component, action, or route handler never touches `drizzle`/`db` directly.
2. **Every mutation goes through a server action in `src/actions/`.** The action is a thin shell: validate input → call DAL → invalidate tags → return `{ success } | { error }`.
3. **Suspense boundaries are the unit of streaming.** One `<Suspense>` per independent data read.

Everything below follows from these.

---

## High-level flow

```
        ┌─────────────────────────────────────────────────────────┐
        │                     BROWSER                             │
        │                                                         │
        │   Client Components                                     │
        │   ├─ forms (react-hook-form + zod)                      │
        │   ├─ local UI state (useState / useTransition)          │
        │   └─ <RealtimeProvider/> ─ SSE → router.refresh()       │
        └───────────────▲─────────────────────────▲───────────────┘
                        │ RSC payload             │ action result
                        │ (streamed, cached)      │ {success|error}
        ┌───────────────┴─────────────────────────┴───────────────┐
        │                    NEXT.JS 16 SERVER                    │
        │                                                         │
        │   app/                                                  │
        │   ├─ (app)/layout.tsx   session gate, mounts providers  │
        │   ├─ page.tsx           <Suspense><Reader/></Suspense>  │
        │   └─ api/stream/        SSE (auth-gated)                │
        │                                                         │
        │   src/actions/          "use server" — thin shells      │
        │        │                                                │
        │        ▼                                                │
        │   src/data/       ⭐ THE Data Access Layer              │
        │    ├─ reads:  "use cache" + cacheTag                    │
        │    ├─ writes: auth + drizzle transactions + DTOs        │
        │    └─ tags.ts: central invalidation registry            │
        │        │                                                │
        │        ▼                                                │
        │   src/lib/              infrastructure only             │
        │    ├─ db/  auth/  events/  validation/                  │
        │                                                         │
        └─────────────────────────────────────────────────────────┘
```

---

## Directory layout

```
src/
├── app/                            routing + UI shells only
│   ├── (auth)/                     unauthenticated route group
│   │   ├── layout.tsx
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   ├── (app)/                      authenticated route group
│   │   ├── layout.tsx              session gate + client providers
│   │   ├── page.tsx                home
│   │   ├── loading.tsx             file-based skeleton
│   │   ├── error.tsx               file-based error boundary
│   │   └── market/[id]/page.tsx
│   ├── admin/                      admin subtree (layout re-checks auth)
│   ├── api/
│   │   ├── auth/[...all]/route.ts  better-auth handler
│   │   ├── stream/route.ts         SSE (auth-gated)
│   │   └── oracle/…                external webhook surface
│   └── @modal/…                    parallel route for modals
│
├── actions/                        ⭐ "use server" — thin shells
│   ├── placeBet.ts
│   ├── sellShares.ts
│   └── admin/
│       ├── createMarket.ts
│       ├── resolveMarket.ts
│       └── cancelMarket.ts
│
├── data/                           ⭐ Data Access Layer (server-only)
│   ├── tags.ts                     central tag registry
│   ├── auth.ts                     getCurrentUser (React.cache-wrapped)
│   ├── markets.ts                  getMarket / listOpenMarkets / createMarket / resolveMarket
│   ├── balances.ts                 getBalance
│   ├── positions.ts                getPositions
│   ├── leaderboard.ts              getLeaderboard
│   └── trading.ts                  placeBet / sellShares
│
├── lib/                            infrastructure — imported by data/ only
│   ├── db/
│   │   ├── index.ts                drizzle client singleton
│   │   └── schema/                 drizzle schema
│   ├── auth/
│   │   ├── server.ts               better-auth server config
│   │   └── client.ts               authClient (for Client Components)
│   ├── events/
│   │   ├── bus.ts                  in-process EventTarget
│   │   └── emit.ts                 typed publish helpers
│   └── validation/                 zod schemas per domain
│
├── components/                     presentation — no data fetching
├── hooks/                          client hooks (use-mobile, etc.)
└── providers/                      client context providers
    ├── RealtimeProvider.tsx
    └── SessionProvider.tsx
```

**Invariant:** `grep -r "from '@/lib/db'"` should only return hits inside `src/data/`. Same for `cacheTag`, `revalidateTag`. This is the auditability property the DAL pattern is designed to deliver.

---

## `src/data/` — the Data Access Layer

Every file starts with `import 'server-only'`. Reads are wrapped with `'use cache'` and tagged. Writes perform their own auth and authorization checks (because a Server Action is a separate entry point from the page that rendered the UI — the page-level check does not extend to the action).

### `src/data/tags.ts`

Central registry. No string literal tags anywhere else in the codebase.

```ts
import "server-only";

export const tags = {
  market: (id: string) => `market:${id}` as const,
  marketsAll: () => "markets" as const,
  marketsList: (scope: "open" | "resolved" | "all") => `markets:${scope}` as const,
  balance: (userId: string) => `balance:${userId}` as const,
  positions: (userId: string) => `positions:${userId}` as const,
  leaderboard: () => "leaderboard" as const,
} as const;
```

### `src/data/auth.ts`

Session access, deduped per-request with `React.cache`. Never cached across requests.

```ts
import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";

export const getCurrentUser = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  const adminEmails = process.env.ADMIN_EMAILS?.split(",").map((e) => e.trim()) ?? [];
  if (!adminEmails.includes(user.email)) throw new Error("Forbidden");
  return user;
}
```

### `src/data/markets.ts`

Reads and writes for the markets domain. Reads are cached; writes are authed and return DTOs.

```ts
import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { eq } from "drizzle-orm";
import { calculateOdds } from "@wpm/shared";
import type { MarketWithOdds } from "@wpm/shared";
import { db } from "@/lib/db";
import { markets, ammPools } from "@/lib/db/schema";
import { requireAdmin } from "./auth";
import { tags } from "./tags";

export async function getMarket(id: string): Promise<MarketWithOdds> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.market(id));

  const row = await db.query.markets.findFirst({
    where: eq(markets.id, id),
    with: { pool: true },
  });
  if (!row || !row.pool) throw new Error(`Market ${id} not found`);
  return toMarketDTO(row);
}

export async function listOpenMarkets(): Promise<MarketWithOdds[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.marketsAll(), tags.marketsList("open"));

  const rows = await db.query.markets.findMany({
    where: eq(markets.status, "open"),
    with: { pool: true },
  });
  return rows.filter((r) => r.pool).map(toMarketDTO);
}

export async function createMarket(input: CreateMarketInput) {
  await requireAdmin();
  return db.transaction((tx) => {
    // ... drizzle writes
    return { id: input.id };
  });
}

function toMarketDTO(row: MarketRow & { pool: PoolRow }): MarketWithOdds {
  // Only the fields the UI needs. Never return raw rows.
  return {
    /* ... */
  } as MarketWithOdds;
}
```

### `src/data/trading.ts`

Mutations that touch multiple tables. Auth check lives inside — a Server Action calling `placeBet` cannot bypass it.

```ts
import "server-only";
import { eq, sql } from "drizzle-orm";
import { calculateBuy, calculateOdds } from "@wpm/shared";
import { db } from "@/lib/db";
import { ammPools, balances, markets, positions, transactions } from "@/lib/db/schema";
import { requireUser } from "./auth";

export type PlaceBetInput = {
  marketId: string;
  outcome: "A" | "B";
  amount: number;
};

export type PlaceBetResult = {
  userId: string;
  marketId: string;
  newBalance: number;
  odds: { priceA: number; priceB: number; multiplierA: number; multiplierB: number };
};

export async function placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
  const user = await requireUser();

  return db.transaction((tx) => {
    const market = tx.select().from(markets).where(eq(markets.id, input.marketId)).get();
    if (!market || market.status !== "open") throw new Error("Market is not open");
    // ... AMM math, balance check, position upsert, transaction log
    const odds = calculateOdds(/* ... */);
    return { userId: user.id, marketId: input.marketId, newBalance: 0, odds };
  });
}
```

### `src/data/balances.ts`

```ts
import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { balances } from "@/lib/db/schema";
import { tags } from "./tags";

export async function getBalance(userId: string): Promise<{ balance: number }> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.balance(userId));

  const row = await db.query.balances.findFirst({
    where: eq(balances.userId, userId),
    columns: { amount: true },
  });
  return { balance: row?.amount ?? 0 };
}
```

### `src/data/positions.ts`

```ts
import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { eq } from "drizzle-orm";
import type { SharePosition } from "@wpm/shared";
import { db } from "@/lib/db";
import { positions } from "@/lib/db/schema";
import { tags } from "./tags";

export async function getPositions(userId: string): Promise<SharePosition[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.positions(userId));

  const rows = await db.query.positions.findMany({ where: eq(positions.userId, userId) });
  return rows.flatMap(toPositionDTOs);
}

function toPositionDTOs(/* row */): SharePosition[] {
  return [];
}
```

### `src/data/leaderboard.ts`

```ts
import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { desc, eq } from "drizzle-orm";
import type { LeaderboardEntry } from "@wpm/shared";
import { db } from "@/lib/db";
import { balances, user } from "@/lib/db/schema";
import { tags } from "./tags";

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.leaderboard());

  return db
    .select({ userId: user.id, name: user.name, balance: balances.amount })
    .from(user)
    .innerJoin(balances, eq(balances.userId, user.id))
    .orderBy(desc(balances.amount));
}
```

### DAL rules

- **`import 'server-only'`** at the top of every file. Prevents accidental client import.
- **Reads:** `'use cache'` + `cacheLife(...)` + `cacheTag(...)`. Tagged under keys from `tags.ts`.
- **Writes:** call `requireUser()` / `requireAdmin()` inside — never rely on a caller to have authenticated.
- **Return DTOs.** The client must never see raw DB rows, internal fields, or unrelated columns.
- **One concern per tag.** Don't share a tag across unrelated reads (`balance:<id>` and `positions:<id>` are separate even though both are per-user).
- **Never call `revalidateTag` from inside a DAL function.** Cache invalidation is the action's job.
- **Never `emit()` events from inside a DAL function.** Event emission is the action's job.

---

## `src/actions/` — thin server-action shells

Every file starts with `'use server'`. Each action does four things, in order:

1. Validate input (zod).
2. Call into `src/data/`.
3. `revalidateTag` every tag the mutation affected.
4. `emit(...)` any realtime events and return `{ success } | { error }`.

### `src/actions/placeBet.ts`

```ts
"use server";
import { revalidateTag } from "next/cache";
import { z } from "zod/v4";
import { placeBet } from "@/data/trading";
import { tags } from "@/data/tags";
import { emit } from "@/lib/events/emit";

const PlaceBetInput = z.object({
  marketId: z.string().min(1),
  outcome: z.enum(["A", "B"]),
  amount: z.number().positive(),
});

type ActionResult = { success: true } | { error: string };

export async function placeBetAction(input: z.input<typeof PlaceBetInput>): Promise<ActionResult> {
  const parsed = PlaceBetInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const result = await placeBet(parsed.data);

    revalidateTag(tags.market(result.marketId));
    revalidateTag(tags.balance(result.userId));
    revalidateTag(tags.positions(result.userId));

    emit.priceUpdate(result.marketId, result.odds);
    emit.balanceUpdate(result.userId, result.newBalance);

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Bet failed" };
  }
}
```

### `src/actions/admin/createMarket.ts`

```ts
"use server";
import { revalidateTag } from "next/cache";
import { z } from "zod/v4";
import { initializePool } from "@wpm/shared";
import { createMarket } from "@/data/markets";
import { tags } from "@/data/tags";

const CreateMarketInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  teamA: z.string().min(1),
  teamB: z.string().min(1),
  startTime: z.iso.datetime(),
  bettingClosesAt: z.iso.datetime(),
  seedAmount: z.number().positive(),
  initialProbabilityA: z.number().min(0).max(1).optional(),
});

export async function createMarketAction(input: z.input<typeof CreateMarketInput>) {
  const parsed = CreateMarketInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const pool = initializePool(
      parsed.data.id,
      parsed.data.seedAmount,
      parsed.data.initialProbabilityA,
    );
    await createMarket({ ...parsed.data, ...pool });

    revalidateTag(tags.marketsAll());
    revalidateTag(tags.marketsList("open"));

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Create failed" };
  }
}
```

### Action rules

- **Return serializable results.** No JSX, no class instances, no raw DB rows.
- **Never re-export or re-implement DAL logic.** One call into `src/data/`, no more.
- **Tag invalidation is exhaustive.** If a mutation could affect a cached read, its tag must be invalidated here. Missing invalidations are the #1 source of stale-UI bugs.
- **`revalidateTag`, never `revalidatePath`.** Paths are too coarse for this app.

---

## `src/lib/` — infrastructure

Imported by `src/data/` (and nowhere else, except `lib/auth/client.ts` which is the Client Component auth SDK).

### `src/lib/db/index.ts`

```ts
import "server-only";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const DB_PATH = process.env.DATABASE_URL ?? "./wpm.db";
export const sqlite = new Database(DB_PATH);
sqlite.pragma("foreign_keys = ON");
export const db = drizzle(sqlite, { schema });
```

### `src/lib/auth/server.ts`

```ts
import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite" }),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:4102",
  plugins: [
    magicLink({
      /* ... */
    }),
    nextCookies(),
  ],
});

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
```

### `src/lib/auth/client.ts`

```ts
import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});
```

### `src/lib/events/bus.ts`

```ts
import "server-only";
import type { PriceUpdateEvent, MarketResolvedEvent, BalanceUpdateEvent } from "@wpm/shared";

export type RealtimeEvent = PriceUpdateEvent | MarketResolvedEvent | BalanceUpdateEvent;

const g = globalThis as unknown as { __wpmBus?: EventTarget };
const bus = g.__wpmBus ?? (g.__wpmBus = new EventTarget());

export function publish(event: RealtimeEvent): void {
  bus.dispatchEvent(new CustomEvent("realtime", { detail: event }));
}

export function subscribe(handler: (e: RealtimeEvent) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<RealtimeEvent>).detail);
  bus.addEventListener("realtime", listener);
  return () => bus.removeEventListener("realtime", listener);
}
```

### `src/lib/events/emit.ts`

```ts
import "server-only";
import { publish } from "./bus";

export const emit = {
  priceUpdate: (marketId: string, odds: { priceA: number; priceB: number }) =>
    publish({ type: "price:update", marketId, ...odds }),
  balanceUpdate: (userId: string, balance: number) =>
    publish({ type: "balance:update", userId, balance }),
  marketResolved: (marketId: string, result: "A" | "B") =>
    publish({ type: "market:resolved", marketId, result }),
};
```

### `src/lib/validation/` (optional, if schemas grow)

Hold zod schemas shared between actions and forms (`react-hook-form` with `@hookform/resolvers/zod`).

---

## `src/providers/` — client context

Mounted inside `app/(app)/layout.tsx`, not root. Unauthenticated routes don't pay the cost of SSE connection or session context.

### `src/providers/SessionProvider.tsx`

```tsx
"use client";
import { createContext, useContext, type ReactNode } from "react";

type SessionUser = { id: string; name: string } | null;
const SessionContext = createContext<SessionUser>(null);

export function SessionProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  return <SessionContext value={user}>{children}</SessionContext>;
}

export function useSession() {
  return useContext(SessionContext);
}
```

### `src/providers/RealtimeProvider.tsx`

Client wrapper around a single SSE connection to `/api/stream`. Dispatches events to local subscribers. **Only mounted for authenticated users.**

```tsx
"use client";
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { PriceUpdateEvent, MarketResolvedEvent, BalanceUpdateEvent } from "@wpm/shared";

type SSEEvent = PriceUpdateEvent | MarketResolvedEvent | BalanceUpdateEvent;
type Subscriber = (event: SSEEvent) => void;

const RealtimeContext = createContext<{ subscribe: (fn: Subscriber) => () => void } | null>(null);

export function RealtimeProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const router = useRouter();
  const subs = useRef<Set<Subscriber>>(new Set());

  const subscribe = useCallback((fn: Subscriber) => {
    subs.current.add(fn);
    return () => subs.current.delete(fn);
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    const dispatch = (e: MessageEvent) => {
      const event = JSON.parse(e.data) as SSEEvent;
      router.refresh();
      subs.current.forEach((fn) => fn(event));
    };
    es.addEventListener("price:update", dispatch);
    es.addEventListener("market:resolved", dispatch);
    es.addEventListener("balance:update", dispatch);
    return () => es.close();
  }, [router, userId]);

  return <RealtimeContext value={{ subscribe }}>{children}</RealtimeContext>;
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime requires RealtimeProvider");
  return ctx;
}
```

### Provider rules

- **`SessionProvider`** and **`RealtimeProvider`** mount in `app/(app)/layout.tsx` only. Not in root layout.
- `ThemeProvider` and `<Toaster/>` live in the root layout (pre-hydration requirements).
- **Do not put cached server data into a provider.** The RSC payload is your client cache — mirroring it into React Context guarantees drift.
- **Do not install TanStack Query / SWR.** Cache Components + `revalidateTag` + `router.refresh()` cover the same ground without a second cache to keep in sync.

---

## `src/app/` — routing only

### `app/layout.tsx` (root)

```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = { title: "WPM", description: "Wampum Prediction Markets" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
```

### `app/(app)/layout.tsx` — authenticated shell

```tsx
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/data/auth";
import { SessionProvider } from "@/providers/SessionProvider";
import { RealtimeProvider } from "@/providers/RealtimeProvider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <SessionProvider user={{ id: user.id, name: user.name }}>
      <RealtimeProvider userId={user.id}>{children}</RealtimeProvider>
    </SessionProvider>
  );
}
```

### `app/(app)/page.tsx` — Suspense granularity

```tsx
import { Suspense } from "react";
import { Header } from "@/components/header";
import { MarketsReader } from "@/components/readers/markets-reader";
import { PortfolioReader } from "@/components/readers/portfolio-reader";
import { LeaderboardReader } from "@/components/readers/leaderboard-reader";

export default function HomePage() {
  return (
    <>
      <Suspense fallback={<Header.Skeleton />}>
        <Header />
      </Suspense>
      <Suspense fallback={null}>
        <LeaderboardReader />
      </Suspense>
      <main className="mx-auto max-w-screen-xl px-4 py-6">
        <Suspense fallback={<p>Loading markets…</p>}>
          <MarketsReader />
        </Suspense>
        <Suspense fallback={null}>
          <PortfolioReader />
        </Suspense>
      </main>
    </>
  );
}
```

### A reader component

Reader components live alongside presentation components; they do one thing — call a DAL function and pass the DTO to a dumb presentation component.

```tsx
// src/components/readers/markets-reader.tsx
import { listOpenMarkets } from "@/data/markets";
import { MarketGrid } from "@/components/market-grid";

export async function MarketsReader() {
  const markets = await listOpenMarkets();
  return <MarketGrid markets={markets} />;
}
```

### Route handlers — `app/api/oracle/markets/[id]/resolve/route.ts`

External callers (the oracle service) call the same DAL as Server Actions. Auth differs (bearer token vs. session) but data access is unified.

```ts
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { resolveMarket } from "@/data/markets";
import { tags } from "@/data/tags";
import { emit } from "@/lib/events/emit";

function requireOracle(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  return token === process.env.WPM_ORACLE_SERVICE_TOKEN;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!requireOracle(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { outcome } = (await req.json()) as { outcome: "A" | "B" };

  const result = await resolveMarket({ marketId: id, outcome });

  revalidateTag(tags.market(id));
  revalidateTag(tags.marketsAll());
  revalidateTag(tags.leaderboard());
  result.affectedUsers.forEach((u) => {
    revalidateTag(tags.balance(u.userId));
    revalidateTag(tags.positions(u.userId));
  });

  emit.marketResolved(id, outcome);
  result.affectedUsers.forEach((u) => emit.balanceUpdate(u.userId, u.newBalance));

  return NextResponse.json({ ok: true });
}
```

---

## Cache invalidation map

Each mutation declares, at the action/route-handler level, every tag it invalidates. This table is the contract — if a mutation can affect a cached read, it must appear here.

| Mutation        | Invalidates                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `placeBet`      | `market:<id>`, `balance:<userId>`, `positions:<userId>`                                                                       |
| `sellShares`    | `market:<id>`, `balance:<userId>`, `positions:<userId>`                                                                       |
| `createMarket`  | `markets`, `markets:open`                                                                                                     |
| `resolveMarket` | `market:<id>`, `markets`, `markets:open`, `markets:resolved`, `leaderboard`, `balance:<u>` + `positions:<u>` for every winner |
| `cancelMarket`  | `market:<id>`, `markets`, `markets:open`, `balance:<u>` + `positions:<u>` for every refunded bettor                           |

---

## The realtime bridge

`revalidateTag` marks server cache stale, but connected browsers don't know until they navigate or refresh. SSE closes the loop:

```
  Action / Route handler
        │
        ├─ revalidateTag(...)        ← server cache marked stale
        └─ emit.xxx(...)             ← in-process bus
                    │
                    ▼
           /api/stream (SSE)         ← per-user event filtering
                    │
                    ▼
           RealtimeProvider          ← single connection, dispatches to subs
                    │
                    ▼
           router.refresh()          ← re-requests the RSC tree;
                                       invalidated reads refetch,
                                       valid ones stay cached
```

One `router.refresh()` site (inside `RealtimeProvider`) means a single choke-point for debugging. Component-level subscription hooks can still observe specific events for local-state needs.

---

## Anti-patterns

- ❌ **`connection()` inside reader components.** Cache Components opts everything out by default; `connection()` is for opting _into_ request-time dynamism (random, live clock). Using it on top of a `'use cache'` read is a no-op at best, a prerender blocker at worst.
- ❌ **Auth checks only in the action wrapper.** Server Actions are separate HTTP entry points. Auth must live inside the DAL function so both page-level calls and action-level calls enforce it.
- ❌ **Returning raw DB rows from the DAL.** Always DTO. Use `server-only` + narrow return types.
- ❌ **Using `revalidatePath`.** Too coarse for this app. Use tags.
- ❌ **Sharing a tag across unrelated reads.** `viewer:<id>` conflating balance and positions means selling a share stale-invalidates your balance cache for no reason.
- ❌ **Mirroring server data into a client context.** Props from Server Components + `router.refresh()` is the model.
- ❌ **`router.refresh()` from arbitrary components.** Keep it in `RealtimeProvider`.
- ❌ **`use cache` on session reads.** Use `React.cache` (per-request dedup) — never `'use cache'` (cross-request cache) for session data.

---

## Auditability

Grep checks that should return **only** `src/data/` hits:

```
rg "from ['\"]@/lib/db['\"]"     # drizzle client — DAL only
rg "cacheTag\("                  # tag writers — DAL only
rg "'use cache'"                 # cache directive — DAL only
```

Grep checks that should return **only** `src/actions/` and `src/app/api/` hits:

```
rg "revalidateTag\("             # tag invalidators — actions + route handlers only
rg "'use server'"                # server-action files — actions only
```

If either rule is violated, the DAL boundary has leaked.
