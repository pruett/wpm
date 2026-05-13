import "server-only";
import postgres from "postgres";

import { directConnectionString } from "@/lib/db";

// Fail fast at module load. PgBouncer transaction-mode silently drops
// LISTEN registrations, so the bus must connect through a non-pooled URL;
// falling back to `DATABASE_URL` (which may point at a pooler) is unsafe.
// Any module that imports the bus expects to send/receive realtime hints,
// so a missing direct URL is a misconfiguration we want to surface at
// startup rather than the first time a subscriber connects.
if (!directConnectionString) {
  throw new Error(
    "DATABASE_URL_UNPOOLED is not set; the realtime bus requires a non-pooled Postgres URL",
  );
}

const directUrl: string = directConnectionString;

const CHANNEL = "wpm_invalidations";

// Exponential backoff with jitter, capped at 30s, when the listener
// connection drops. postgres.js calls this with a retry counter and treats
// the return value as seconds. The library reconnects internally and
// re-issues LISTEN via its `onclose` hook, so this schedule governs both
// the initial connect (if the DB is unreachable at startup) and every
// subsequent reconnect after a dropped socket.
function backoffSeconds(retries: number): number {
  const base = Math.min(0.5 * 2 ** retries, 30);
  return base * (0.5 + Math.random() / 2);
}

export type Handler = (tag: string) => void;

// When the last subscriber unsubscribes we don't close the LISTEN connection
// immediately — short gaps (page nav, tab focus shuffles, the brief window
// between an old SSE handler self-terminating and a fresh one reconnecting)
// are common and would otherwise churn the connection. A truly idle instance
// releases the connection after the TTL expires.
const TEARDOWN_TTL_MS = 30_000;

const handlers = new Set<Handler>();

let listenerClient: ReturnType<typeof postgres> | null = null;
let listenPromise: Promise<unknown> | null = null;
let reconnectCount = 0;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;

function cancelTeardown() {
  if (teardownTimer) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
}

function scheduleTeardown() {
  if (teardownTimer) return;
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (handlers.size > 0) return;
    const client = listenerClient;
    listenerClient = null;
    listenPromise = null;
    reconnectCount = 0;
    if (client) {
      void client.end({ timeout: 5 }).catch(() => {});
    }
  }, TEARDOWN_TTL_MS);
  // Don't hold the Node event loop open just for the teardown timer — if the
  // process is otherwise idle, it should be free to exit.
  teardownTimer.unref?.();
}

function ensureListener() {
  if (listenPromise) return listenPromise;

  listenerClient = postgres(directUrl, {
    max: 1,
    backoff: backoffSeconds,
  });

  listenPromise = listenerClient.listen(
    CHANNEL,
    (payload) => {
      for (const handler of handlers) {
        handler(payload);
      }
    },
    () => {
      // Fires after every LISTEN registration. The first call is the
      // initial subscribe; subsequent calls indicate the lib reconnected
      // a dropped socket and re-registered. Client-side resync (one
      // `router.refresh()` on `EventSource` reopen) is handled in the
      // RealtimeProvider — no server-side action is needed beyond log
      // visibility for operators.
      if (reconnectCount > 0) {
        console.warn(
          `[realtime/bus] LISTEN ${CHANNEL} re-registered (reconnect #${reconnectCount})`,
        );
      }
      reconnectCount += 1;
    },
  );

  return listenPromise;
}

export function subscribe(handler: Handler): () => void {
  cancelTeardown();
  handlers.add(handler);
  void ensureListener();

  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      scheduleTeardown();
    }
  };
}
