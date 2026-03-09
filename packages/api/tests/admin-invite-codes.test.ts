import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair } from "@wpm/shared/crypto";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
process.env.JWT_SECRET = "test-jwt-secret-for-admin-invite";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.ADMIN_API_KEY = "test-admin-api-key-for-invite";
const DB_PATH = join(tmpdir(), `wpm-admin-invite-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

// --- Dynamic imports ---
const { admin } = await import("../src/routes/admin");
const { signJwt } = await import("../src/middleware/auth");
const { encryptPrivateKey } = await import("../src/crypto/wallet");
const { getDb, closeDb } = await import("../src/db/index");
const { findActiveInviteCode } = await import("../src/db/queries");

// --- Test fixtures ---
const referrerKeys = generateKeyPair();
const referrerId = randomUUID();

let app: InstanceType<typeof Hono>;
let adminToken: string;
let userToken: string;

beforeAll(async () => {
  // Seed a user to act as referrer
  const db = getDb();
  const encKey = await encryptPrivateKey(
    referrerKeys.privateKey,
    process.env.WALLET_ENCRYPTION_KEY!,
  );
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    referrerId,
    "Referrer",
    `referrer-${randomUUID()}@example.com`,
    referrerKeys.publicKey,
    encKey,
    "user",
    Date.now(),
  );

  adminToken = await signJwt({
    sub: "admin",
    role: "admin" as const,
  });

  userToken = await signJwt({
    sub: referrerId,
    role: "user" as const,
    walletAddress: referrerKeys.publicKey,
    email: "referrer@example.com",
  });

  app = new Hono();
  app.route("/", admin);
});

afterAll(() => {
  closeDb();
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
    try {
      unlinkSync(f);
    } catch {}
  }
});

describe("POST /admin/invite-codes", () => {
  test("generates correct number of codes", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count: 3, maxUses: 5 }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.codes).toHaveLength(3);
  });

  test("codes are unique 8-char uppercase alphanumeric", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count: 5, maxUses: 1 }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const codes: string[] = body.codes;

    // All unique
    const unique = new Set(codes);
    expect(unique.size).toBe(5);

    // 8 chars, uppercase alphanumeric
    for (const code of codes) {
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
    }
  });

  test("codes are stored in database with correct metadata", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count: 1, maxUses: 10 }),
    });

    const body = await res.json();
    const code = body.codes[0];

    const dbCode = findActiveInviteCode(code);
    expect(dbCode).not.toBeNull();
    expect(dbCode!.max_uses).toBe(10);
    expect(dbCode!.use_count).toBe(0);
    expect(dbCode!.active).toBe(1);
    expect(dbCode!.created_by).toBe("admin");
    expect(dbCode!.referrer).toBeNull();
  });

  test("accepts optional referrer as existing wallet", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        count: 1,
        maxUses: 5,
        referrer: referrerKeys.publicKey,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const code = body.codes[0];

    const dbCode = findActiveInviteCode(code);
    expect(dbCode).not.toBeNull();
    expect(dbCode!.referrer).toBe(referrerKeys.publicKey);
  });

  test("rejects referrer with unknown wallet", async () => {
    const unknownKeys = generateKeyPair();
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        count: 1,
        maxUses: 5,
        referrer: unknownKeys.publicKey,
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("RECIPIENT_NOT_FOUND");
  });

  test("rejects invalid count (0)", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count: 0, maxUses: 5 }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects invalid maxUses (0)", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count: 1, maxUses: 0 }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count: 1, maxUses: 5 }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count: 1, maxUses: 5 }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /admin/invite-codes", () => {
  test("lists all codes with full metadata", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inviteCodes).toBeArray();
    expect(body.inviteCodes.length).toBeGreaterThan(0);

    const first = body.inviteCodes[0];
    expect(first).toHaveProperty("code");
    expect(first).toHaveProperty("createdBy");
    expect(first).toHaveProperty("maxUses");
    expect(first).toHaveProperty("useCount");
    expect(first).toHaveProperty("active");
    expect(first).toHaveProperty("createdAt");
    expect(typeof first.active).toBe("boolean");
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${userToken}`,
      },
    });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /admin/invite-codes/:code", () => {
  let codeToDelete: string;

  test("creates a code to deactivate", async () => {
    const res = await app.request("/admin/invite-codes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ count: 1, maxUses: 5 }),
    });

    const body = await res.json();
    codeToDelete = body.codes[0];
    expect(codeToDelete).toBeDefined();
  });

  test("deactivates code (sets active=false)", async () => {
    const res = await app.request(`/admin/invite-codes/${codeToDelete}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(codeToDelete);
    expect(body.active).toBe(false);

    // Verify in DB: still exists but active=0
    const { findInviteCode } = await import("../src/db/queries");
    const dbCode = findInviteCode(codeToDelete);
    expect(dbCode).not.toBeNull();
    expect(dbCode!.active).toBe(0);
  });

  test("deactivated code is not returned by findActiveInviteCode", async () => {
    const active = findActiveInviteCode(codeToDelete);
    expect(active).toBeNull();
  });

  test("returns already deactivated message for inactive code", async () => {
    const res = await app.request(`/admin/invite-codes/${codeToDelete}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(false);
    expect(body.message).toBe("Already deactivated");
  });

  test("returns 404 for nonexistent code", async () => {
    const res = await app.request("/admin/invite-codes/ZZZZZZZZ", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    expect(res.status).toBe(404);
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request(`/admin/invite-codes/${codeToDelete}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${userToken}`,
      },
    });

    expect(res.status).toBe(403);
  });
});
