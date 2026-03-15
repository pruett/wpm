import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  createRateLimiter,
  ipKey,
  userIdFromJwt,
  resetAllStores,
} from "../src/middleware/rate-limit";
import { signJwt } from "../src/middleware/auth";

// Set JWT_SECRET for token generation in tests
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-rate-limit-secret";

describe("rate-limit middleware", () => {
  beforeEach(() => {
    resetAllStores();
  });

  test("allows requests within limit", async () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }
  });

  test("rejects requests exceeding limit with 429", async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    await app.request("/test");

    const res = await app.request("/test");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toBe("Too many requests");
  });

  test("includes Retry-After header on 429", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    const res = await app.request("/test");

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  });

  test("different keys are rate limited independently", async () => {
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyFn: (c) => c.req.header("x-test-key") ?? "default",
    });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test", { headers: { "x-test-key": "userA" } });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/test", { headers: { "x-test-key": "userB" } });
    expect(res2.status).toBe(200);

    // userA is now over limit
    const res3 = await app.request("/test", { headers: { "x-test-key": "userA" } });
    expect(res3.status).toBe(429);

    // userB still has capacity... wait, limit is 1, so userB is also at limit
    const res4 = await app.request("/test", { headers: { "x-test-key": "userB" } });
    expect(res4.status).toBe(429);

    // userC is fresh — should succeed
    const res5 = await app.request("/test", { headers: { "x-test-key": "userC" } });
    expect(res5.status).toBe(200);
  });

  test("window expires and requests are allowed again", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 100, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test");
    expect(res1.status).toBe(200);

    const res2 = await app.request("/test");
    expect(res2.status).toBe(429);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 150));

    const res3 = await app.request("/test");
    expect(res3.status).toBe(200);
  });

  test("null key skips rate limiting", async () => {
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyFn: () => null,
    });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    // Should never be rate limited since key is null
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }
  });

  test("supports async keyFn", async () => {
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyFn: async (c) => c.req.header("x-user") ?? null,
    });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test", { headers: { "x-user": "u1" } });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/test", { headers: { "x-user": "u1" } });
    expect(res2.status).toBe(429);

    // No header → null key → skipped
    const res3 = await app.request("/test");
    expect(res3.status).toBe(200);
  });

  test("store tracks timestamps correctly", async () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    await app.request("/test");
    await app.request("/test");

    expect(limiter.store.size).toBe(1);
    const timestamps = limiter.store.get("unknown");
    expect(timestamps?.length).toBe(3);
  });

  test("stale timestamps are filtered on new request", async () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 100, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    await app.request("/test");
    expect(limiter.store.get("unknown")?.length).toBe(2);

    await new Promise((r) => setTimeout(r, 150));

    await app.request("/test");
    // Old timestamps filtered, only the new one remains
    expect(limiter.store.get("unknown")?.length).toBe(1);
  });
});

describe("ipKey helper", () => {
  test("extracts IP from x-forwarded-for header", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res1.status).toBe(200);

    // Different IP — should succeed
    const res2 = await app.request("/test", { headers: { "x-forwarded-for": "5.6.7.8" } });
    expect(res2.status).toBe(200);

    // Same IP — should fail
    const res3 = await app.request("/test", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res3.status).toBe(429);
  });

  test("takes first IP from comma-separated x-forwarded-for", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });
    expect(res1.status).toBe(200);

    // Same first IP — should fail
    const res2 = await app.request("/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 99.99.99.99" },
    });
    expect(res2.status).toBe(429);
  });

  test("falls back to x-real-ip header", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test", { headers: { "x-real-ip": "10.0.0.1" } });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/test", { headers: { "x-real-ip": "10.0.0.1" } });
    expect(res2.status).toBe(429);
  });
});

describe("userIdFromJwt helper", () => {
  test("extracts userId from valid Bearer token", async () => {
    const token = await signJwt({ sub: "user-123", role: "user" as const });
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyFn: userIdFromJwt,
    });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/test", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2.status).toBe(429);
  });

  test("returns null for missing Authorization header (skips rate limiting)", async () => {
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyFn: userIdFromJwt,
    });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    // No auth header — should be skipped every time
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }
  });

  test("returns null for invalid token (skips rate limiting)", async () => {
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyFn: userIdFromJwt,
    });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await app.request("/test", {
        headers: { authorization: "Bearer invalid-token" },
      });
      expect(res.status).toBe(200);
    }
  });

  test("different users are rate limited independently", async () => {
    const token1 = await signJwt({ sub: "user-1", role: "user" as const });
    const token2 = await signJwt({ sub: "user-2", role: "user" as const });
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 60_000,
      keyFn: userIdFromJwt,
    });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test", {
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/test", {
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(res2.status).toBe(200);

    // user-1 over limit
    const res3 = await app.request("/test", {
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(res3.status).toBe(429);

    // user-2 over limit
    const res4 = await app.request("/test", {
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(res4.status).toBe(429);
  });
});

describe("resetAllStores", () => {
  test("clears all rate limit stores", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, keyFn: ipKey });
    const app = new Hono();
    app.use("/*", limiter);
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test");
    const res1 = await app.request("/test");
    expect(res1.status).toBe(429);

    resetAllStores();

    const res2 = await app.request("/test");
    expect(res2.status).toBe(200);
  });
});
