import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { validateExtraFields } from "../src/validation";
import { signJwt } from "../src/middleware/auth";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-input-validation-secret";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "test-admin-api-key";

// --- validateExtraFields unit tests ---

describe("validateExtraFields", () => {
  test("returns null for valid body with exact fields", () => {
    const result = validateExtraFields({ outcome: "A", amount: 100 }, ["outcome", "amount"]);
    expect(result).toBeNull();
  });

  test("returns null for body with subset of allowed fields", () => {
    const result = validateExtraFields({ amount: 100 }, ["outcome", "amount"]);
    expect(result).toBeNull();
  });

  test("returns null for empty body with allowed fields", () => {
    const result = validateExtraFields({}, ["outcome", "amount"]);
    expect(result).toBeNull();
  });

  test("returns error string for extra fields", () => {
    const result = validateExtraFields({ outcome: "A", amount: 100, hack: true }, [
      "outcome",
      "amount",
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain("hack");
    expect(result).toContain("Unknown fields");
  });

  test("returns error listing multiple extra fields", () => {
    const result = validateExtraFields({ outcome: "A", amount: 100, hack: true, extra: "foo" }, [
      "outcome",
      "amount",
    ]);
    expect(result).not.toBeNull();
    expect(result).toContain("hack");
    expect(result).toContain("extra");
  });

  test("returns null for empty body with no allowed fields", () => {
    const result = validateExtraFields({}, []);
    expect(result).toBeNull();
  });

  test("returns error for any fields when none allowed", () => {
    const result = validateExtraFields({ a: 1 }, []);
    expect(result).not.toBeNull();
    expect(result).toContain("a");
  });
});

// --- CORS middleware tests ---

describe("CORS middleware", () => {
  test("sets Access-Control-Allow-Origin header on responses", async () => {
    const app = new Hono();
    app.use(
      "*",
      cors({
        origin: "https://wpm.example.com",
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        credentials: true,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Origin: "https://wpm.example.com" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://wpm.example.com");
  });

  test("includes credentials header", async () => {
    const app = new Hono();
    app.use(
      "*",
      cors({
        origin: "https://wpm.example.com",
        credentials: true,
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Origin: "https://wpm.example.com" },
    });

    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  test("handles OPTIONS preflight requests", async () => {
    const app = new Hono();
    app.use(
      "*",
      cors({
        origin: "https://wpm.example.com",
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        credentials: true,
      }),
    );
    app.post("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      method: "OPTIONS",
      headers: {
        Origin: "https://wpm.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Authorization",
      },
    });

    expect(res.status).toBe(204);
    const allowMethods = res.headers.get("Access-Control-Allow-Methods");
    expect(allowMethods).toContain("POST");
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers");
    expect(allowHeaders).toContain("Content-Type");
    expect(allowHeaders).toContain("Authorization");
  });

  test("rejects requests from disallowed origin", async () => {
    const app = new Hono();
    app.use(
      "*",
      cors({
        origin: "https://wpm.example.com",
      }),
    );
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Origin: "https://evil.com" },
    });

    // Response still succeeds but no CORS header set for wrong origin
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("https://evil.com");
  });
});

// --- Body size limit tests ---

describe("body size limit", () => {
  test("allows request body under 64 KB", async () => {
    const app = new Hono();
    app.use(
      "*",
      bodyLimit({
        maxSize: 64 * 1024,
        onError: (c) => {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR",
                message: "Request body too large (max 64 KB)",
              },
            },
            413,
          );
        },
      }),
    );
    app.post("/test", async (c) => {
      const body = await c.req.json();
      return c.json({ received: true });
    });

    const smallBody = JSON.stringify({ data: "x".repeat(1000) });
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: smallBody,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean };
    expect(json.received).toBe(true);
  });

  test("rejects request body over 64 KB with 413", async () => {
    const app = new Hono();
    app.use(
      "*",
      bodyLimit({
        maxSize: 64 * 1024,
        onError: (c) => {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR",
                message: "Request body too large (max 64 KB)",
              },
            },
            413,
          );
        },
      }),
    );
    app.post("/test", async (c) => {
      const body = await c.req.json();
      return c.json({ received: true });
    });

    // Create body larger than 64 KB
    const largeBody = JSON.stringify({ data: "x".repeat(70_000) });
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: largeBody,
    });

    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.message).toContain("64 KB");
  });
});

// --- X-Request-Id tests ---

describe("X-Request-Id middleware", () => {
  test("adds X-Request-Id header to responses", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      const requestId = crypto.randomUUID();
      c.set("requestId", requestId);
      c.header("X-Request-Id", requestId);
      await next();
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);

    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    // UUID v4 format
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates unique IDs for different requests", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      const requestId = crypto.randomUUID();
      c.set("requestId", requestId);
      c.header("X-Request-Id", requestId);
      await next();
    });
    app.get("/test", (c) => c.json({ ok: true }));

    const res1 = await app.request("/test");
    const res2 = await app.request("/test");
    const res3 = await app.request("/test");

    const id1 = res1.headers.get("X-Request-Id");
    const id2 = res2.headers.get("X-Request-Id");
    const id3 = res3.headers.get("X-Request-Id");

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  test("requestId is accessible on context", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      const requestId = crypto.randomUUID();
      c.set("requestId", requestId);
      c.header("X-Request-Id", requestId);
      await next();
    });
    app.get("/test", (c) => {
      const id = c.get("requestId");
      return c.json({ requestId: id });
    });

    const res = await app.request("/test");
    const body = (await res.json()) as { requestId: string };
    const headerRequestId = res.headers.get("X-Request-Id");

    expect(body.requestId).toBe(headerRequestId);
  });
});

// --- Strict body validation integration tests ---
// Each test mounts only the relevant router to avoid middleware cross-contamination
// (e.g., trading's use("*", authMiddleware) would affect auth routes if co-mounted)

function makeTestApp() {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: "https://wpm.example.com",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        c.json(
          { error: { code: "VALIDATION_ERROR", message: "Request body too large (max 64 KB)" } },
          413,
        ),
    }),
  );
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    await next();
  });
  return app;
}

describe("strict body validation — trading routes", () => {
  let tradingApp: InstanceType<typeof Hono>;
  let userToken: string;

  beforeAll(async () => {
    userToken = await signJwt({
      sub: "test-user",
      role: "user" as const,
      walletAddress: "test-wallet",
      email: "test@example.com",
    });

    const { trading } = await import("../src/routes/trading");
    tradingApp = makeTestApp();
    tradingApp.route("/", trading);
  });

  test("rejects buy/preview with extra fields → VALIDATION_ERROR", async () => {
    const res = await tradingApp.request("/markets/fake-market/buy/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ outcome: "A", amount: 100, extraField: "malicious" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("extraField");
  });

  test("rejects sell/preview with extra fields → VALIDATION_ERROR", async () => {
    const res = await tradingApp.request("/markets/fake-market/sell/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ outcome: "A", amount: 100, injected: "data" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("injected");
  });

  test("accepts valid body (passes to next validation step)", async () => {
    const res = await tradingApp.request("/markets/fake-market/buy/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).not.toBe("VALIDATION_ERROR");
  });
});

describe("strict body validation — auth routes", () => {
  let authApp: InstanceType<typeof Hono>;

  beforeAll(async () => {
    const { auth } = await import("../src/routes/auth");
    authApp = makeTestApp();
    authApp.route("/", auth);
  });

  test("rejects register/begin with extra fields", async () => {
    const res = await authApp.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "ABC123",
        name: "Test",
        email: "test@example.com",
        role: "admin",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("role");
  });

  test("rejects admin/login with extra fields", async () => {
    const res = await authApp.request("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "test-key",
        extraField: "should-fail",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("extraField");
  });
});

describe("strict body validation — wallet routes", () => {
  let walletApp: InstanceType<typeof Hono>;
  let userToken: string;

  beforeAll(async () => {
    userToken = await signJwt({
      sub: "test-user",
      role: "user" as const,
      walletAddress: "test-wallet",
      email: "test@example.com",
    });

    const { wallet } = await import("../src/routes/wallet");
    walletApp = makeTestApp();
    walletApp.route("/", wallet);
  });

  test("rejects transfer with extra fields → VALIDATION_ERROR", async () => {
    const res = await walletApp.request("/wallet/transfer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        recipientAddress: "some-addr",
        amount: 10,
        isAdmin: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("isAdmin");
  });
});

describe("strict body validation — admin routes", () => {
  let adminApp: InstanceType<typeof Hono>;
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await signJwt({ sub: "admin", role: "admin" as const });

    const { admin } = await import("../src/routes/admin");
    adminApp = makeTestApp();
    adminApp.route("/", admin);
  });

  test("rejects distribute with extra fields", async () => {
    const res = await adminApp.request("/admin/distribute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        recipient: "some-addr",
        amount: 100,
        reason: "manual",
        privilegeEscalation: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("privilegeEscalation");
  });
});

describe("middleware integration", () => {
  test("X-Request-Id header present on responses", async () => {
    const app = makeTestApp();
    app.get("/health", (c) => c.json({ status: "ok" }));

    const res = await app.request("/health");
    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("CORS headers present on responses", async () => {
    const app = makeTestApp();
    app.get("/health", (c) => c.json({ status: "ok" }));

    const res = await app.request("/health", {
      headers: { Origin: "https://wpm.example.com" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://wpm.example.com");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
});
