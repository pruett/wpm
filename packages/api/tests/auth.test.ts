import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { signJwt, verifyJwt, authMiddleware } from "../src/middleware/auth";
import type { JwtUserPayload } from "../src/middleware/auth";

const TEST_SECRET = "test-secret-key-for-jwt-testing-only";

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

describe("signJwt / verifyJwt", () => {
  test("round-trip: sign then verify returns original payload", async () => {
    const token = await signJwt({
      sub: "user-123",
      role: "user",
      walletAddress: "0xabc",
      email: "test@example.com",
    });

    const payload = await verifyJwt(token);
    expect(payload.sub).toBe("user-123");
    expect(payload.role).toBe("user");
    expect(payload.walletAddress).toBe("0xabc");
    expect(payload.email).toBe("test@example.com");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  test("admin token with custom expiry", async () => {
    const customExp = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const token = await signJwt({
      sub: "admin",
      role: "admin",
      exp: customExp,
    });

    const payload = await verifyJwt(token);
    expect(payload.sub).toBe("admin");
    expect(payload.role).toBe("admin");
    expect(payload.exp).toBe(customExp);
  });

  test("expired token is rejected", async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const token = await signJwt({
      sub: "user-456",
      role: "user",
      exp: pastExp,
    });

    await expect(verifyJwt(token)).rejects.toThrow();
  });

  test("tampered token is rejected", async () => {
    const token = await signJwt({ sub: "user-789", role: "user" });
    const tampered = token.slice(0, -4) + "XXXX";
    await expect(verifyJwt(tampered)).rejects.toThrow();
  });

  test("wrong secret rejects token", async () => {
    const token = await signJwt({ sub: "user-000", role: "user" });
    process.env.JWT_SECRET = "different-secret";
    await expect(verifyJwt(token)).rejects.toThrow();
    process.env.JWT_SECRET = TEST_SECRET;
  });

  test("missing JWT_SECRET throws", async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    await expect(signJwt({ sub: "x", role: "user" })).rejects.toThrow(
      "JWT_SECRET environment variable is required",
    );
    process.env.JWT_SECRET = saved;
  });
});

describe("authMiddleware", () => {
  const app = new Hono<{ Variables: { user: JwtUserPayload } }>();
  app.use("/protected/*", authMiddleware);
  app.get("/protected/me", (c) => {
    const user = c.get("user");
    return c.json({ sub: user.sub, role: user.role });
  });

  test("valid token sets user on context", async () => {
    const token = await signJwt({
      sub: "user-abc",
      role: "user",
      walletAddress: "0x123",
      email: "a@b.com",
    });

    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sub).toBe("user-abc");
    expect(body.role).toBe("user");
  });

  test("missing authorization header returns 401", async () => {
    const res = await app.request("/protected/me");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("Missing");
  });

  test("malformed authorization header returns 401", async () => {
    const res = await app.request("/protected/me", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("Invalid authorization format");
  });

  test("invalid token returns 401", async () => {
    const res = await app.request("/protected/me", {
      headers: { Authorization: "Bearer not.a.valid.token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("Invalid or expired");
  });

  test("expired token returns 401", async () => {
    const expiredToken = await signJwt({
      sub: "user-exp",
      role: "user",
      exp: Math.floor(Date.now() / 1000) - 10,
    });

    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    expect(res.status).toBe(401);
  });
});
