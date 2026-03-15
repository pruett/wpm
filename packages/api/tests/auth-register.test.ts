import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
process.env.JWT_SECRET = "test-jwt-secret-auth-register";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_RP_NAME = "WPM Test";
process.env.WEBAUTHN_ORIGIN = "http://localhost";
const DB_PATH = join(tmpdir(), `wpm-auth-register-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

// --- Dynamic imports ---
const { auth } = await import("../src/routes/auth");
const { getDb, closeDb } = await import("../src/db/index");
const { insertChallenge, findActiveInviteCode, findUserByEmail, findChallenge } =
  await import("../src/db/queries");

let app: InstanceType<typeof Hono>;

describe("auth: POST /auth/register/begin", () => {
  beforeAll(() => {
    app = new Hono();
    app.route("/", auth);

    // Seed invite codes (INSERT OR IGNORE in case DB is shared across test files)
    const db = getDb();
    db.query(
      "INSERT OR IGNORE INTO invite_codes (code, created_by, referrer, max_uses, use_count, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("TESTCODE", "admin", null, 10, 0, 1, Date.now());

    db.query(
      "INSERT OR IGNORE INTO invite_codes (code, created_by, referrer, max_uses, use_count, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("MAXEDOUT", "admin", null, 1, 1, 1, Date.now());

    db.query(
      "INSERT OR IGNORE INTO invite_codes (code, created_by, referrer, max_uses, use_count, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("INACTIVE", "admin", null, 10, 0, 0, Date.now());

    db.query(
      "INSERT OR IGNORE INTO invite_codes (code, created_by, referrer, max_uses, use_count, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("REFCODE1", "admin", "some-wallet-address", 10, 0, 1, Date.now());
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

  test("returns WebAuthn options with valid invite code and unique email", async () => {
    const email = `reg-begin-${randomUUID()}@example.com`;
    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "TESTCODE",
        name: "Test User",
        email,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Should have challengeId and publicKey
    expect(body.challengeId).toBeDefined();
    expect(typeof body.challengeId).toBe("string");

    expect(body.publicKey).toBeDefined();
    expect(body.publicKey.challenge).toBeDefined();
    expect(body.publicKey.rp).toEqual({ name: "WPM Test", id: "localhost" });
    expect(body.publicKey.user).toBeDefined();
    expect(body.publicKey.user.name).toBe(email);
    expect(body.publicKey.user.displayName).toBe("Test User");
    expect(body.publicKey.timeout).toBe(60000);
    expect(body.publicKey.authenticatorSelection).toEqual({
      residentKey: "required",
      userVerification: "required",
      requireResidentKey: true,
    });

    // Verify challenge was stored in DB
    const storedChallenge = findChallenge(body.challengeId);
    expect(storedChallenge).not.toBeNull();
    expect(storedChallenge!.type).toBe("webauthn_register");
    expect(storedChallenge!.challenge).toBe(body.publicKey.challenge);

    // Verify user data was stored
    const userData = JSON.parse(storedChallenge!.user_data!);
    expect(userData.name).toBe("Test User");
    expect(userData.email).toBe(email);
    expect(userData.inviteCode).toBe("TESTCODE");
  });

  test("rejects invalid invite code", async () => {
    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "DOESNOTEXIST",
        name: "Test User",
        email: "new@example.com",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_INVITE_CODE");
  });

  test("rejects exhausted invite code", async () => {
    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "MAXEDOUT",
        name: "Test User",
        email: "maxed@example.com",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_INVITE_CODE");
  });

  test("rejects deactivated invite code", async () => {
    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "INACTIVE",
        name: "Test User",
        email: "inactive@example.com",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_INVITE_CODE");
  });

  test("rejects duplicate email (case-insensitive) → DUPLICATE_REGISTRATION 409", async () => {
    // Insert an existing user with a unique email
    const dupeEmail = `dupe-${randomUUID()}@example.com`;
    const db = getDb();
    db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      "Existing",
      dupeEmail,
      "wallet-" + randomUUID(),
      Buffer.from("fake"),
      "user",
      Date.now(),
    );

    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "TESTCODE",
        name: "Test User",
        email: dupeEmail.toUpperCase(), // uppercase — should still match
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("DUPLICATE_REGISTRATION");
  });

  test("rejects empty name", async () => {
    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "TESTCODE",
        name: "",
        email: `valid-${randomUUID()}@example.com`,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Name");
  });

  test("rejects name longer than 50 characters", async () => {
    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "TESTCODE",
        name: "A".repeat(51),
        email: `valid2-${randomUUID()}@example.com`,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Name");
  });

  test("rejects invalid email format", async () => {
    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "TESTCODE",
        name: "Test",
        email: "not-an-email",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("email");
  });

  test("stores challenge with correct 60s TTL", async () => {
    const before = Date.now();
    const res = await app.request("/auth/register/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteCode: "TESTCODE",
        name: "TTL User",
        email: `ttl-${randomUUID()}@example.com`,
      }),
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = await res.json();
    const storedChallenge = findChallenge(body.challengeId);

    // expires_at should be ~60s from now
    expect(storedChallenge!.expires_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(storedChallenge!.expires_at).toBeLessThanOrEqual(after + 60_000);
  });

  test("POST /auth/register/complete rejects expired challenge → CHALLENGE_EXPIRED 400", async () => {
    // Insert an expired challenge
    const challengeId = randomUUID();
    insertChallenge({
      id: challengeId,
      challenge: "expired-challenge-value",
      type: "webauthn_register",
      userData: JSON.stringify({
        userId: randomUUID(),
        name: "Test",
        email: "expired@test.com",
        inviteCode: "TESTCODE",
      }),
      expiresAt: Date.now() - 1000, // already expired
    });

    const res = await app.request("/auth/register/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        credential: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("CHALLENGE_EXPIRED");

    // Challenge should be cleaned up
    expect(findChallenge(challengeId)).toBeNull();
  });

  test("POST /auth/register/complete rejects nonexistent challenge", async () => {
    const res = await app.request("/auth/register/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: randomUUID(),
        credential: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("CHALLENGE_EXPIRED");
  });

  test("POST /auth/register/complete rejects invalid attestation → WEBAUTHN_VERIFICATION_FAILED 400", async () => {
    // Insert a valid (non-expired) challenge
    const challengeId = randomUUID();
    insertChallenge({
      id: challengeId,
      challenge: "valid-challenge-value",
      type: "webauthn_register",
      userData: JSON.stringify({
        userId: randomUUID(),
        name: "Test",
        email: "bad-attestation@test.com",
        inviteCode: "TESTCODE",
      }),
      expiresAt: Date.now() + 60_000,
    });

    const res = await app.request("/auth/register/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        credential: {
          id: "fake-credential-id",
          rawId: "fake-raw-id",
          type: "public-key",
          response: {
            attestationObject: "fake-attestation",
            clientDataJSON: "fake-client-data",
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("WEBAUTHN_VERIFICATION_FAILED");

    // Challenge should be cleaned up
    expect(findChallenge(challengeId)).toBeNull();
  });
});
