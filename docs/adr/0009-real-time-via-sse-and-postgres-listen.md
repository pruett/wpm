# Real-time updates are invalidation hints over SSE, fanned out via Postgres LISTEN/NOTIFY

Wampum delivers real-time updates to the browser as a one-way push of **invalidation hints** — small `{tag}` messages naming a cached slice that has changed. Hints travel from writers (server actions, cron handlers) through Postgres `LISTEN/NOTIFY` to a per-instance SSE handler, which forwards them to every connected browser tab on that instance. Clients react by calling `router.refresh()`, letting Next 16's `cacheComponents` recompute only the slices whose `cacheTag` was revalidated. The cached data layer (`src/data/*`) remains the sole source of truth for what a tag's content actually is; the real-time channel never carries data, only the _fact_ that data changed.

## What this gets us

The user-visible promise is: a viewer staring at `/event/[id]` sees the price move when _anyone_ bets on any child Market in that Event; a viewer on `/bets` sees their balance change the moment an Event they hold resolves. No polling, no refresh button, no client-side caches to keep coherent.

## Why not push the data itself

A push-the-data design (server emits the full updated `MarketWithOdds`; client patches local state) would shave a round trip. We rejected it for two reasons. First, the AMM-derived shape — bettor dedup, price/multiplier computation, resolved-state price-fixing in `toMarketWithOdds()` (`src/data/markets.ts`) — exists in exactly one place. Push-data would duplicate that computation in the SSE producer, or couple the producer to the data layer's return shape. Second, the `"use cache"` machinery already does the right thing on the writer's instance via `revalidateTag`; SSE only needs to _fan that out_ across instances and tabs. Pushing data would parallel a system that already works rather than completing it.

At WPM's scale (binary-moneyline sports markets, dozens at a time, human-bet cadence), the extra RSC round trip per update is invisible. If the regime ever shifts toward HFT-style flow, this decision is the one to revisit.

## Why not websockets

We have nothing to send upstream. Bets, sells, and resolutions all flow through HTTP server actions; the only thing the server pushes to the client is "tag X changed." Websockets pay for bidirectional state we don't use, with worse HTTP/2 multiplexing behavior, more brittle proxy traversal, and a heavier client API. SSE rides on a normal `GET`, reconnects automatically via `EventSource`, and works with cookie auth and Vercel's streaming model out of the box.

## Why not Redis (or Pusher/Ably)

A Redis pub/sub bus would work — it's the textbook answer. We rejected it for one reason: we already have Postgres in the request path, and Postgres' `LISTEN/NOTIFY` is purpose-built for low-volume cache fanout signals. Adding Upstash (or Pusher/Ably) would introduce a vendor, env vars, monthly cost, and a second consistency boundary between "did the bet commit?" and "did the message dispatch?" — for a fanout volume that Postgres handles in single-digit milliseconds.

Pusher/Ably additionally replace SSE wholesale; their managed client owns the persistent connection. That's a heavier dependency than the problem warrants.

## Why Postgres `LISTEN/NOTIFY` works here specifically

The producer side stays trivial. Inside the same DB transaction as the write, the writer issues `NOTIFY wpm_invalidations, '<tag>'`. Postgres queues the notification and delivers it on `COMMIT` — atomic with the bet, the resolve, the cancel. A rolled-back transaction discards the notification. No second-system race between "DB says yes" and "bus says no."

On the consumer side, each Vercel instance opens _one_ singleton Postgres connection in `LISTEN wpm_invalidations` mode, lazily on first SSE subscriber. That one connection multiplexes to every SSE-connected tab on the instance via an in-process emitter. SSE clients come and go; the LISTEN connection persists for the instance's lifetime.

The PgBouncer caveat is load-bearing: `LISTEN` requires a connection that _belongs_ to the listener for as long as it listens, which PgBouncer's transaction-pool mode does not provide. Vercel Postgres (Neon under the hood) exposes a direct connection string for exactly this case. Writers continue to use the pooled URL; only the SSE handler's singleton listener uses the direct URL.

## Single multiplexed stream per browser tab

Each tab opens one `/api/stream` connection. The handler authenticates the cookie via Better Auth, learns the viewer's `userId`, and forwards messages from the in-process emitter to the response stream, gated by visibility:

- `market:*`, `event:*`, and listing-scope hints (`markets`, `events`) are broadcast to every connected tab. Tabs filter client-side against an in-memory set of subscribed tags (each rendered component that depends on a slice registers via `useLiveTag(tag)` — typically by rendering `<LiveTag tag={tags.market(id)} />` or `<LiveTag tag={tags.event(id)} />` from a server component).
- `viewer:${userId}` hints are filtered server-side and only forwarded to the matching session's stream.

We rejected per-market and per-route streams. They would proliferate connections, churn on navigation, and require coordinating subscribe/unsubscribe RPCs against the SSE channel. A single broadcast channel with client-side filtering trades a few wasted bytes for a much simpler connection lifecycle.

## Single `invalidate(tag)` helper, called by every writer

The writer-side contract becomes one call:

```ts
// src/data/invalidate.ts
export async function invalidate(tag: string, tx?: Tx): Promise<void> {
  revalidateTag(tag, "max");
  const conn = tx ?? db;
  await conn.execute(sql`SELECT pg_notify('wpm_invalidations', ${tag})`);
}
```

Every writer — `placeBet` (`data/trading`), `createEvent`, `commitEvent` (`data/events`) — invokes `invalidate(tag, tx)` from inside its transaction for every tag it touches. The helper removes the failure mode where a writer calls `revalidateTag` but forgets `NOTIFY` (or vice versa); the two are inseparable by construction. Pairing the `pg_notify` to a `tx` means hints fan out on `COMMIT` and a rolled-back write emits nothing.

This rolls up a pre-existing latent bug: the cron `resolve` route previously invalidated only `tags.marketsAll()`, leaving `market:${id}` and `viewer:${userId}` stale for every affected user until the `cacheLife("minutes")` TTL expired. With SSE in place, that stale window becomes a visible regression on balance and resolution state. The fix — fan `invalidate` across every affected user inside `commitEvent` — lands in the same change and is independent of SSE in its correctness merit.

## Consequences

- **Hints are fire-and-forget.** A dropped `NOTIFY` would leave a tab stale until the next hint or until `cacheLife` expires. We accept this: hints are not transactional state, and the cache TTL is the safety net. We do _not_ introduce monotonic event IDs, `Last-Event-ID` replay, or a write-ahead log of invalidations. On SSE reconnect (which `EventSource` does automatically after network blips and after the handler's self-terminated cycles), the client fires one `router.refresh()` to re-sync. Drift is bounded by reconnect frequency.
- **The SSE handler self-terminates before Vercel's function timeout.** A heartbeat comment frame goes out every ~25s; the handler closes at ~270s with an `event: reconnect` frame. `EventSource` reconnects on the next request to a fresh instance. From the user's perspective: indistinguishable.
- **Client refreshes are debounced.** A hint received within ~150ms of the previous matching hint coalesces into a single `router.refresh()` call. Protects against refresh storms during a cron sweep that resolves many markets at once.
- **`cacheLife("minutes")` stays.** The TTL is now belt-and-suspenders: invalidations are the primary mechanism; the TTL is the recovery path if a hint is lost. Extending the TTL is a future tuning decision, not a prerequisite.
- **Authentication is mandatory on `/api/stream`.** The handler `requireUser`s; anonymous requests get `401`. The viewer-scoped filter has nothing to gate against otherwise. The `(app)` route group is already authenticated, so this matches the rest of the app.
- **No new infra.** Postgres, Next, Vercel. The shape of the system in production is unchanged; we are using primitives already present.
