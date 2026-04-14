# Next.js 16 — Canonical Server Data Pattern (Cache Components)

## TL;DR

**Server Actions are for mutations, not reads.** The canonical way to load data
and make it available "throughout the frontend" in Next.js 16 is:

0. Enable Cache Components in `next.config.ts` → `cacheComponents: true`.
1. Fetch in a **Server Component** (async function) — _not_ a Server Action.
2. Pass the data (or a `Promise` of it) down via props, and — when deep trees
   need it — wrap client subtrees in a **client Context Provider**.
3. Cache with the `'use cache'` directive + `cacheTag` / `cacheLife`
   (stable exports from `next/cache`). Wrap any uncached / request-time work
   in `<Suspense>`.
4. Invalidate from inside a Server Action with **`updateTag()`** (immediate
   expiration post-mutation) — or `revalidateTag` / `revalidatePath` for the
   older flow.

Server Actions show up only at step 4. If you catch yourself calling one from
`useEffect` to read data, you've reinvented an API route — use a Server
Component or SWR instead.

---

## 0. Enable Cache Components

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
};

export default nextConfig;
```

With this on, any component that reads runtime data (`cookies`, `headers`,
`searchParams`, uncached fetch, etc.) **must** sit under `<Suspense>` or be
marked `'use cache'` — otherwise you'll get an "Uncached data was accessed
outside of `<Suspense>`" error at build/dev time. This is the price of PPR.

## 1. Cached data loader (`'use cache'`)

```ts
// lib/data/get-posts.ts
import { cacheLife, cacheTag } from "next/cache";

export async function getPosts() {
  "use cache";
  cacheLife("hours");
  cacheTag("posts");

  return db.post.findMany();
}
```

- `'use cache'` → cross-request cache; arguments + closed-over values form the
  cache key automatically.
- `cacheTag('posts')` → the handle you'll invalidate against.
- No `React.cache()` wrapper needed — `'use cache'` already dedupes on key.
- **Don't** cache per-user data implicitly. Extract the runtime value first
  (see §3) and pass it as an argument so it becomes part of the cache key.

## 2. Server Component fetches, Client Provider distributes

Per-user data is runtime data, so the reading component must be wrapped in
`<Suspense>` (Cache Components requirement). Extract the runtime value, then
hand it to a cached function keyed by that value.

```ts
// lib/data/get-viewer.ts
import { cacheLife, cacheTag } from "next/cache";

export async function getViewerById(userId: string) {
  "use cache";
  cacheLife("minutes");
  cacheTag(`viewer:${userId}`);
  return db.user.findUnique({ where: { id: userId } });
}
```

```tsx
// app/(app)/layout.tsx
import { Suspense } from "react";
import { cookies } from "next/headers";
import { getViewerById } from "@/lib/data/get-viewer";
import { ViewerProvider } from "./viewer-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ViewerSkeleton />}>
      <ViewerBoundary>{children}</ViewerBoundary>
    </Suspense>
  );
}

async function ViewerBoundary({ children }: { children: React.ReactNode }) {
  const userId = (await cookies()).get("session")?.value;
  const viewer = userId ? await getViewerById(userId) : null;
  return <ViewerProvider viewer={viewer}>{children}</ViewerProvider>;
}
```

```tsx
// app/(app)/viewer-provider.tsx
"use client";
import { createContext, useContext } from "react";
import type { Viewer } from "@/lib/data/get-viewer";

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: Viewer | null;
  children: React.ReactNode;
}) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

export const useViewer = () => useContext(ViewerContext);
```

**Only pass fields the client uses** — RSC→client props are serialized into
the HTML/RSC payload, so don't hand the full row across the boundary.

## 3. Streaming variant (pass the Promise, not the value)

When you'd rather not block the layout:

```tsx
// app/(app)/layout.tsx
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const viewerPromise = getViewer(); // not awaited
  return <ViewerProvider viewerPromise={viewerPromise}>{children}</ViewerProvider>;
}
```

```tsx
// viewer-provider.tsx
"use client";
import { use } from "react";
// ...
export function ViewerProvider({ viewerPromise, children }: Props) {
  const viewer = use(viewerPromise); // suspends until resolved
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}
```

Wrap the provider in `<Suspense fallback={...}>` at the layout level.

## 4. Mutations + invalidation (this is where Server Actions belong)

```ts
// app/(app)/actions.ts
"use server";
import { updateTag } from "next/cache";
import { auth } from "@/lib/auth";

export async function updateViewerName(name: string) {
  const session = await auth();
  if (!session) throw new Error("Unauthorized"); // always re-check auth in actions

  await db.user.update({ where: { id: session.userId }, data: { name } });
  updateTag(`viewer:${session.userId}`); // expires that cache entry immediately
}
```

`updateTag` is the Cache Components–era API: it expires tagged entries right
after the mutation so the next read is fresh. `revalidateTag` /
`revalidatePath` still exist and are appropriate for scheduled or broader
invalidations.

Call from a client component; Next will re-run affected Server Components and
stream fresh data back — the `ViewerProvider` receives the new value on the
next render. No manual refetch needed.

## 5. When you _do_ want client-side reads

For data that must refresh on focus / interval / user action from a purely
client subtree, use **SWR** with a server-action fetcher:

```tsx
"use client";
import useSWR from "swr";
import { getFeed } from "./actions"; // 'use server'

export function Feed() {
  const { data, mutate } = useSWR("feed", () => getFeed());
  // mutate() after local changes for optimistic UI
}
```

SWR dedupes across component instances; the server action handles auth.

---

## Rules of thumb

| Need                                          | Use                                                |
| --------------------------------------------- | -------------------------------------------------- |
| Read data once per request, share in RSC tree | `React.cache()` wrapper                            |
| Read data, cache across requests              | `'use cache'` + `cacheTag` / `cacheLife`           |
| Per-user cached data                          | Extract runtime value, pass as arg → cache key     |
| Distribute server-fetched data to client tree | Server Component → Client Context Provider         |
| Stream without blocking layout                | Pass `Promise`, unwrap with `use()` + Suspense     |
| Mutate + invalidate (immediate)               | Server Action + `updateTag`                        |
| Scheduled / broad invalidation                | `revalidateTag` / `revalidatePath`                 |
| Non-deterministic values per request          | `await connection()` then generate, under Suspense |
| Client-driven refetch (focus, interval)       | SWR (fetcher can be a Server Action)               |

## Anti-patterns

- Calling a Server Action from `useEffect` to load initial data — use a Server
  Component.
- Putting a Server Action's result in React state and treating it as the source
  of truth — it won't revalidate; let RSC + `revalidateTag` drive freshness.
- Passing a whole DB row through a Client Provider — serialize only the fields
  the client reads.
- Skipping auth checks inside a Server Action because "middleware handles it"
  — actions are public endpoints.
