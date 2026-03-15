import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";

// --- Env setup (must run before dynamic imports) ---
const DB_PATH = join(tmpdir(), `wpm-admin-oracle-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
process.env.JWT_SECRET = "test-jwt-secret-for-admin-oracle";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.ADMIN_API_KEY = "test-admin-api-key-for-oracle";

// --- Dynamic imports ---
const { admin } = await import("../src/routes/admin");
const { signJwt } = await import("../src/middleware/auth");
const { closeDb } = await import("../src/db/index");

let app: InstanceType<typeof Hono>;
let adminToken: string;
let userToken: string;
let oracleServer: ReturnType<typeof Bun.serve>;

// Mock oracle responses (mutable so tests can override)
let mockIngestResponse: { status: number; body: unknown } = {
  status: 200,
  body: { ingested: 5, markets: ["m1", "m2"] },
};
let mockResolveResponse: { status: number; body: unknown } = {
  status: 200,
  body: { resolved: 2, markets: ["m1", "m2"] },
};

beforeAll(async () => {
  // 1. Start mock oracle HTTP server using Bun.serve
  oracleServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/trigger/ingest" && req.method === "POST") {
        return new Response(JSON.stringify(mockIngestResponse.body), {
          status: mockIngestResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/trigger/resolve" && req.method === "POST") {
        return new Response(JSON.stringify(mockResolveResponse.body), {
          status: mockResolveResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  process.env.ORACLE_URL = `http://127.0.0.1:${oracleServer.port}`;

  // 2. Mint tokens
  adminToken = await signJwt({ sub: "admin", role: "admin" as const });
  userToken = await signJwt({
    sub: randomUUID(),
    role: "user" as const,
    walletAddress: "some-wallet",
    email: "user@example.com",
  });

  // 3. Create Hono app with admin routes
  app = new Hono();
  app.route("/", admin);
});

afterAll(async () => {
  oracleServer.stop(true);
  closeDb();
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
    try {
      unlinkSync(f);
    } catch {}
  }
});

describe("POST /admin/oracle/ingest", () => {
  test("forwards request to oracle and returns response", async () => {
    mockIngestResponse = {
      status: 200,
      body: { ingested: 5, markets: ["m1", "m2", "m3", "m4", "m5"] },
    };

    const res = await app.request("/admin/oracle/ingest", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingested).toBe(5);
    expect(body.markets).toBeArray();
    expect(body.markets.length).toBe(5);
  });

  test("forwards oracle error responses", async () => {
    mockIngestResponse = {
      status: 400,
      body: { error: { code: "INGEST_FAILED", message: "No events found" } },
    };

    const res = await app.request("/admin/oracle/ingest", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INGEST_FAILED");
  });

  test("returns NODE_UNAVAILABLE when oracle is unreachable", async () => {
    const originalUrl = process.env.ORACLE_URL;
    process.env.ORACLE_URL = "http://127.0.0.1:19999";

    const res = await app.request("/admin/oracle/ingest", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NODE_UNAVAILABLE");
    expect(body.error.message).toBe("Oracle server is unreachable");

    process.env.ORACLE_URL = originalUrl;
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request("/admin/oracle/ingest", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request("/admin/oracle/ingest", {
      method: "POST",
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /admin/oracle/resolve", () => {
  test("forwards request to oracle and returns response", async () => {
    mockResolveResponse = {
      status: 200,
      body: { resolved: 3, markets: ["m1", "m2", "m3"] },
    };

    const res = await app.request("/admin/oracle/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolved).toBe(3);
    expect(body.markets).toBeArray();
    expect(body.markets.length).toBe(3);
  });

  test("forwards oracle error responses", async () => {
    mockResolveResponse = {
      status: 500,
      body: { error: { code: "RESOLVE_FAILED", message: "External API error" } },
    };

    const res = await app.request("/admin/oracle/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("RESOLVE_FAILED");
  });

  test("returns NODE_UNAVAILABLE when oracle is unreachable", async () => {
    const originalUrl = process.env.ORACLE_URL;
    process.env.ORACLE_URL = "http://127.0.0.1:19999";

    const res = await app.request("/admin/oracle/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NODE_UNAVAILABLE");
    expect(body.error.message).toBe("Oracle server is unreachable");

    process.env.ORACLE_URL = originalUrl;
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request("/admin/oracle/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request("/admin/oracle/resolve", {
      method: "POST",
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
