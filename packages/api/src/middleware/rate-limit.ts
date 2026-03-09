import type { Context, MiddlewareHandler } from "hono";
import { sendError } from "../errors";
import { verifyJwt } from "./auth";

type RateLimitConfig = {
  limit: number;
  windowMs: number;
  keyFn: (c: Context) => string | null | Promise<string | null>;
};

type RateLimitStore = Map<string, number[]>;

const allStores: RateLimitStore[] = [];

function createRateLimiter(config: RateLimitConfig): MiddlewareHandler & { store: RateLimitStore } {
  const { limit, windowMs, keyFn } = config;
  const store: RateLimitStore = new Map();
  allStores.push(store);

  // Periodic cleanup of stale keys every 60s
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of store) {
      const valid = timestamps.filter((t) => t > now - windowMs);
      if (valid.length === 0) {
        store.delete(key);
      } else {
        store.set(key, valid);
      }
    }
  }, 60_000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  const middleware: MiddlewareHandler = async (c, next) => {
    const key = await keyFn(c);
    if (!key) {
      await next();
      return;
    }

    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = store.get(key);
    if (!timestamps) {
      timestamps = [];
      store.set(key, timestamps);
    }

    // Sliding window: remove timestamps outside the window
    const valid = timestamps.filter((t) => t > windowStart);

    if (valid.length >= limit) {
      // Retry-After = seconds until the oldest request in window expires
      const retryAfterMs = valid[0] + windowMs - now;
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);
      c.header("Retry-After", String(retryAfterSec));
      return sendError(c, "RATE_LIMITED");
    }

    valid.push(now);
    store.set(key, valid);
    await next();
  };

  return Object.assign(middleware, { store });
}

// --- Key extraction helpers ---

function ipKey(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown"
  );
}

async function userIdFromJwt(c: Context): Promise<string | null> {
  // Reuse already-verified user from auth middleware if available
  const existing = c.get("user" as never) as { sub?: string } | undefined;
  if (existing?.sub) return existing.sub;

  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const payload = await verifyJwt(authHeader.slice(7));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

// --- Pre-configured rate limiters ---

const authRateLimit = createRateLimiter({
  limit: 10,
  windowMs: 60_000,
  keyFn: (c) => ipKey(c),
});

const adminRateLimit = createRateLimiter({
  limit: 120,
  windowMs: 60_000,
  keyFn: (c) => ipKey(c),
});

const userRateLimit = createRateLimiter({
  limit: 60,
  windowMs: 60_000,
  keyFn: (c) => userIdFromJwt(c),
});

function resetAllStores(): void {
  for (const store of allStores) {
    store.clear();
  }
}

export {
  createRateLimiter,
  authRateLimit,
  adminRateLimit,
  userRateLimit,
  ipKey,
  userIdFromJwt,
  resetAllStores,
};
export type { RateLimitConfig, RateLimitStore };
