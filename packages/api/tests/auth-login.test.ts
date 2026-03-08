import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
process.env.JWT_SECRET = "test-jwt-secret-auth-login";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_RP_NAME = "WPM Test";
process.env.WEBAUTHN_ORIGIN = "http://localhost";
const DB_PATH = join(tmpdir(), `wpm-auth-login-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

// --- Dynamic imports ---
const { auth } = await import("../src/routes/auth");
const { closeDb } = await import("../src/db/index");
const { insertUser, insertCredential, insertChallenge, findChallenge, findCredentialById } =
  await import("../src/db/queries");

let app: InstanceType<typeof Hono>;

const TEST_USER = {
  id: randomUUID(),
  name: "Login Test User",
  email: `login-${randomUUID()}@example.com`,
  walletAddress: `wallet-${randomUUID()}`,
};

const TEST_CREDENTIAL_ID = "test-cred-" + randomUUID();

beforeAll(() => {
  app = new Hono();
  app.route("/", auth);

  insertUser({
    id: TEST_USER.id,
    name: TEST_USER.name,
    email: TEST_USER.email,
    walletAddress: TEST_USER.walletAddress,
    walletPrivateKeyEnc: Buffer.from("fake-encrypted-key"),
  });

  insertCredential({
    credentialId: TEST_CREDENTIAL_ID,
    userId: TEST_USER.id,
    publicKey: Buffer.from("fake-public-key"),
    counter: 5,
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

describe("POST /auth/login/begin", () => {
  test("returns authentication options with challenge", async () => {
    const res = await app.request("/auth/login/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.challengeId).toBeDefined();
    expect(typeof body.challengeId).toBe("string");

    expect(body.publicKey).toBeDefined();
    expect(body.publicKey.challenge).toBeDefined();
    expect(body.publicKey.rpId).toBe("localhost");
    expect(body.publicKey.timeout).toBe(60000);
    expect(body.publicKey.userVerification).toBe("required");

    // No allowCredentials for discoverable credentials
    expect(body.publicKey.allowCredentials).toBeUndefined();

    // Verify challenge was stored in DB
    const storedChallenge = findChallenge(body.challengeId);
    expect(storedChallenge).not.toBeNull();
    expect(storedChallenge!.type).toBe("webauthn_login");
    expect(storedChallenge!.challenge).toBe(body.publicKey.challenge);
  });

  test("stores challenge with correct 60s TTL", async () => {
    const before = Date.now();
    const res = await app.request("/auth/login/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = await res.json();
    const storedChallenge = findChallenge(body.challengeId);

    expect(storedChallenge!.expires_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(storedChallenge!.expires_at).toBeLessThanOrEqual(after + 60_000);
  });
});

describe("POST /auth/login/complete", () => {
  test("rejects nonexistent challenge → UNAUTHORIZED 401", async () => {
    const res = await app.request("/auth/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: randomUUID(),
        credential: {
          id: TEST_CREDENTIAL_ID,
          rawId: TEST_CREDENTIAL_ID,
          type: "public-key",
          response: {
            authenticatorData: "fake",
            clientDataJSON: "fake",
            signature: "fake",
          },
        },
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects expired challenge → CHALLENGE_EXPIRED 400", async () => {
    const challengeId = randomUUID();
    insertChallenge({
      id: challengeId,
      challenge: "expired-login-challenge",
      type: "webauthn_login",
      expiresAt: Date.now() - 1000,
    });

    const res = await app.request("/auth/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        credential: {
          id: TEST_CREDENTIAL_ID,
          rawId: TEST_CREDENTIAL_ID,
          type: "public-key",
          response: {
            authenticatorData: "fake",
            clientDataJSON: "fake",
            signature: "fake",
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("CHALLENGE_EXPIRED");
    expect(findChallenge(challengeId)).toBeNull();
  });

  test("rejects wrong challenge type (register challenge used for login)", async () => {
    const challengeId = randomUUID();
    insertChallenge({
      id: challengeId,
      challenge: "register-type-challenge",
      type: "webauthn_register",
      expiresAt: Date.now() + 60_000,
    });

    const res = await app.request("/auth/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        credential: {
          id: TEST_CREDENTIAL_ID,
          rawId: TEST_CREDENTIAL_ID,
          type: "public-key",
          response: {
            authenticatorData: "fake",
            clientDataJSON: "fake",
            signature: "fake",
          },
        },
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(findChallenge(challengeId)).toBeNull();
  });

  test("rejects unknown credentialId → UNAUTHORIZED 401", async () => {
    const challengeId = randomUUID();
    insertChallenge({
      id: challengeId,
      challenge: "valid-login-challenge",
      type: "webauthn_login",
      expiresAt: Date.now() + 60_000,
    });

    const res = await app.request("/auth/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        credential: {
          id: "nonexistent-credential-id",
          rawId: "nonexistent-credential-id",
          type: "public-key",
          response: {
            authenticatorData: "fake",
            clientDataJSON: "fake",
            signature: "fake",
          },
        },
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("Unknown credential");
    expect(findChallenge(challengeId)).toBeNull();
  });

  test("rejects invalid assertion (bad authenticator data) → UNAUTHORIZED 401", async () => {
    const challengeId = randomUUID();
    insertChallenge({
      id: challengeId,
      challenge: "valid-assertion-challenge",
      type: "webauthn_login",
      expiresAt: Date.now() + 60_000,
    });

    const res = await app.request("/auth/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        credential: {
          id: TEST_CREDENTIAL_ID,
          rawId: TEST_CREDENTIAL_ID,
          type: "public-key",
          response: {
            authenticatorData: "AAAAAAAAAAAAAAAAAAAAAA",
            clientDataJSON: "AAAAAAAAAAAAAAAAAAAAAA",
            signature: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        },
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("verification failed");
    expect(findChallenge(challengeId)).toBeNull();
  });

  test("rejects missing credential in body → UNAUTHORIZED 401", async () => {
    const challengeId = randomUUID();
    insertChallenge({
      id: challengeId,
      challenge: "no-cred-challenge",
      type: "webauthn_login",
      expiresAt: Date.now() + 60_000,
    });

    const res = await app.request("/auth/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId,
        credential: {},
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects missing challengeId → UNAUTHORIZED 401", async () => {
    const res = await app.request("/auth/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: {
          id: TEST_CREDENTIAL_ID,
          rawId: TEST_CREDENTIAL_ID,
          type: "public-key",
          response: {},
        },
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects invalid request body → UNAUTHORIZED 401", async () => {
    const res = await app.request("/auth/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
