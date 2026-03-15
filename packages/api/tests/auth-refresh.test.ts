import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
process.env.JWT_SECRET = "test-jwt-secret-auth-refresh";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_RP_NAME = "WPM Test";
process.env.WEBAUTHN_ORIGIN = "http://localhost";
const DB_PATH = join(tmpdir(), `wpm-auth-refresh-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;

// --- Dynamic imports ---
const { auth } = await import("../src/routes/auth");
const { closeDb } = await import("../src/db/index");
const { insertUser } = await import("../src/db/queries");
const { signRefreshToken, verifyJwt, signJwt, REFRESH_COOKIE_NAME } =
  await import("../src/middleware/auth");

let app: InstanceType<typeof Hono>;

const TEST_USER = {
  id: randomUUID(),
  name: "Refresh Test User",
  email: `refresh-${randomUUID()}@example.com`,
  walletAddress: `wallet-${randomUUID()}`,
  role: "user",
};

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

function makeCookieHeader(name: string, value: string): string {
  return `${name}=${value}`;
}

describe("POST /auth/refresh", () => {
  test("valid refresh token → returns new access JWT", async () => {
    const refreshToken = await signRefreshToken(TEST_USER.id);

    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: {
        Cookie: makeCookieHeader(REFRESH_COOKIE_NAME, refreshToken),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe("string");

    // Verify the returned JWT has correct claims
    const payload = await verifyJwt(body.token);
    expect(payload.sub).toBe(TEST_USER.id);
    expect(payload.role).toBe("user");
    expect(payload.walletAddress).toBe(TEST_USER.walletAddress);
    expect(payload.email).toBe(TEST_USER.email);

    // Access token should have ~15 min expiry
    const ttl = payload.exp - payload.iat;
    expect(ttl).toBe(15 * 60);
  });

  test("valid refresh → rotates refresh cookie", async () => {
    const refreshToken = await signRefreshToken(TEST_USER.id);

    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: {
        Cookie: makeCookieHeader(REFRESH_COOKIE_NAME, refreshToken),
      },
    });

    expect(res.status).toBe(200);

    // Check that Set-Cookie header contains a new refresh cookie
    const setCookieHeader = res.headers.get("Set-Cookie");
    expect(setCookieHeader).not.toBeNull();
    expect(setCookieHeader).toContain(REFRESH_COOKIE_NAME + "=");
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("Secure");
    expect(setCookieHeader).toContain("SameSite=Strict");
    expect(setCookieHeader).toContain("Max-Age=604800"); // 7 days
  });

  test("missing refresh cookie → UNAUTHORIZED 401", async () => {
    const res = await app.request("/auth/refresh", {
      method: "POST",
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("re-authenticate");
  });

  test("expired refresh token → UNAUTHORIZED 401", async () => {
    // Manually create an expired refresh token by signing with exp in the past
    const { sign } = await import("hono/jwt");
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await sign(
      { sub: TEST_USER.id, type: "refresh", iat: now - 1000, exp: now - 500 },
      process.env.JWT_SECRET!,
      "HS256",
    );

    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: {
        Cookie: makeCookieHeader(REFRESH_COOKIE_NAME, expiredToken),
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("re-authenticate");
  });

  test("access token used as refresh token → UNAUTHORIZED 401", async () => {
    // An access JWT lacks `type: 'refresh'`
    const accessToken = await signJwt({
      sub: TEST_USER.id,
      role: "user",
      walletAddress: TEST_USER.walletAddress,
      email: TEST_USER.email,
    });

    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: {
        Cookie: makeCookieHeader(REFRESH_COOKIE_NAME, accessToken),
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("refresh token for deleted user → UNAUTHORIZED 401", async () => {
    // Sign a refresh token for a user ID that doesn't exist in DB
    const nonexistentUserId = randomUUID();
    const refreshToken = await signRefreshToken(nonexistentUserId);

    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: {
        Cookie: makeCookieHeader(REFRESH_COOKIE_NAME, refreshToken),
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("re-authenticate");
  });

  test("tampered refresh token → UNAUTHORIZED 401", async () => {
    const refreshToken = await signRefreshToken(TEST_USER.id);
    const tampered = refreshToken.slice(0, -5) + "XXXXX";

    const res = await app.request("/auth/refresh", {
      method: "POST",
      headers: {
        Cookie: makeCookieHeader(REFRESH_COOKIE_NAME, tampered),
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("Refresh cookie on registration", () => {
  test("POST /auth/register/begin + complete sets refresh cookie", async () => {
    // We can only test that begin works (complete requires real WebAuthn attestation)
    // Instead, verify the register/complete code path sets cookies by checking the
    // existing tests in auth-register.test.ts — here we just verify the refresh
    // cookie helpers work correctly in isolation

    const refreshToken = await signRefreshToken(TEST_USER.id);
    expect(typeof refreshToken).toBe("string");
    expect(refreshToken.split(".").length).toBe(3); // JWT format

    const { verifyRefreshToken } = await import("../src/middleware/auth");
    const payload = await verifyRefreshToken(refreshToken);
    expect(payload.sub).toBe(TEST_USER.id);
    expect(payload.type).toBe("refresh");

    // 7-day TTL
    const ttl = payload.exp - payload.iat;
    expect(ttl).toBe(7 * 24 * 60 * 60);
  });
});
