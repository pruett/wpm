import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const ADMIN_API_KEY = "test-admin-api-key-super-secret";
process.env.JWT_SECRET = "test-jwt-secret-auth-admin";
process.env.ADMIN_API_KEY = ADMIN_API_KEY;
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_RP_NAME = "WPM Test";
process.env.WEBAUTHN_ORIGIN = "http://localhost";
const DB_PATH = join(tmpdir(), `wpm-auth-admin-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

// --- Dynamic imports ---
const { auth } = await import("../src/routes/auth");
const { closeDb } = await import("../src/db/index");
const { insertUser } = await import("../src/db/queries");
const { verifyJwt, authMiddleware } = await import("../src/middleware/auth");
const { adminMiddleware } = await import("../src/middleware/admin");

let app: InstanceType<typeof Hono>;

const TEST_USER = {
  id: randomUUID(),
  name: "Admin Test User",
  email: `admin-test-${randomUUID()}@example.com`,
  walletAddress: `wallet-${randomUUID()}`,
  role: "user",
};

beforeAll(() => {
  app = new Hono();
  app.route("/", auth);

  // Add a protected admin route for testing adminMiddleware
  app.get("/admin/test", authMiddleware, adminMiddleware, (c) => {
    return c.json({ ok: true });
  });

  insertUser({
    id: TEST_USER.id,
    name: TEST_USER.name,
    email: TEST_USER.email,
    walletAddress: TEST_USER.walletAddress,
    walletPrivateKeyEnc: Buffer.from("fake-encrypted-key"),
  });
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(DB_PATH);
    unlinkSync(DB_PATH + "-wal");
    unlinkSync(DB_PATH + "-shm");
  } catch {
    // ignore
  }
});

describe("POST /auth/admin/login", () => {
  test("correct API key → returns admin JWT with 24h expiry", async () => {
    const res = await app.request("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: ADMIN_API_KEY }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe("string");

    // Verify JWT claims
    const payload = await verifyJwt(body.token);
    expect(payload.sub).toBe("admin");
    expect(payload.role).toBe("admin");

    // 24h expiry
    const ttl = payload.exp - payload.iat;
    expect(ttl).toBe(24 * 60 * 60);
  });

  test("wrong API key → FORBIDDEN 403", async () => {
    const res = await app.request("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "wrong-key" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("missing apiKey field → FORBIDDEN 403", async () => {
    const res = await app.request("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("non-string apiKey → FORBIDDEN 403", async () => {
    const res = await app.request("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: 12345 }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("invalid JSON body → FORBIDDEN 403", async () => {
    const res = await app.request("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

describe("Admin middleware", () => {
  test("admin JWT on admin route → 200", async () => {
    // Get admin token
    const loginRes = await app.request("/auth/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: ADMIN_API_KEY }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const res = await app.request("/admin/test", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("user JWT on admin route → FORBIDDEN 403", async () => {
    const { signJwt } = await import("../src/middleware/auth");
    const userToken = await signJwt({
      sub: TEST_USER.id,
      role: "user",
      walletAddress: TEST_USER.walletAddress,
      email: TEST_USER.email,
    });

    const res = await app.request("/admin/test", {
      headers: { Authorization: `Bearer ${userToken}` },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("no auth header on admin route → UNAUTHORIZED 401", async () => {
    const res = await app.request("/admin/test");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
