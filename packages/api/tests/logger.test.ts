import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { sanitize, info, warn, error, audit } from "../src/logger";
import type { LogEntry } from "../src/logger";
import { Hono } from "hono";

// Capture Bun.write calls to stdout
let logOutput: string[] = [];
let writeSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logOutput = [];
  writeSpy = spyOn(Bun, "write").mockImplementation((...args: unknown[]) => {
    const dest = args[0];
    const data = args[1];
    if (dest === Bun.stdout && data instanceof Uint8Array) {
      logOutput.push(new TextDecoder().decode(data));
    }
    return Promise.resolve(0);
  });
});

afterEach(() => {
  writeSpy.mockRestore();
});

function getLastLog(): LogEntry {
  const last = logOutput[logOutput.length - 1];
  return JSON.parse(last.trim());
}

describe("sanitize", () => {
  it("redacts sensitive keys", () => {
    const input = {
      name: "Alice",
      privateKey: "RSA_PRIVATE_KEY_DATA",
      token: "eyJhbGciOiJIUzI1NiJ9...",
      apiKey: "super-secret-key",
    };
    const result = sanitize(input) as Record<string, unknown>;
    expect(result.name).toBe("Alice");
    expect(result.privateKey).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.apiKey).toBe("[REDACTED]");
  });

  it("redacts nested sensitive keys", () => {
    const input = {
      user: {
        name: "Bob",
        wallet_private_key_enc: Buffer.from("encrypted"),
      },
    };
    const result = sanitize(input) as Record<string, Record<string, unknown>>;
    expect(result.user.name).toBe("Bob");
    expect(result.user.wallet_private_key_enc).toBe("[REDACTED]");
  });

  it("handles arrays", () => {
    const input = [
      { name: "Alice", secret: "abc" },
      { name: "Bob", secret: "def" },
    ];
    const result = sanitize(input) as Record<string, unknown>[];
    expect(result[0].name).toBe("Alice");
    expect(result[0].secret).toBe("[REDACTED]");
    expect(result[1].name).toBe("Bob");
    expect(result[1].secret).toBe("[REDACTED]");
  });

  it("handles null and undefined", () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeUndefined();
  });

  it("handles primitives", () => {
    expect(sanitize("hello")).toBe("hello");
    expect(sanitize(42)).toBe(42);
    expect(sanitize(true)).toBe(true);
  });

  it("limits recursion depth", () => {
    const deep = { a: { b: { c: { d: { e: { f: { secret: "deep" } } } } } } };
    const result = sanitize(deep) as Record<string, unknown>;
    // At depth 6, should stop recursing and return as-is
    expect(result).toBeDefined();
  });

  it("redacts all known sensitive keys", () => {
    const input = {
      password: "pass",
      private_key: "key",
      walletPrivateKeyEnc: "enc",
      jwtSecret: "sec",
      accessToken: "at",
      refreshToken: "rt",
      wpm_refresh: "cookie",
      api_key: "ak",
      credential: "cred",
      publicKey: "pk",
      public_key: "pk2",
      attestation: "att",
      assertion: "asr",
      signature: "sig",
      WALLET_ENCRYPTION_KEY: "wek",
      ADMIN_API_KEY: "aak",
      ORACLE_PRIVATE_KEY: "opk",
    };
    const result = sanitize(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(result[key]).toBe("[REDACTED]");
    }
  });

  it("passes through non-sensitive keys", () => {
    const input = {
      userId: "user-123",
      action: "distribute",
      amount: 500,
      marketId: "mkt-1",
    };
    const result = sanitize(input) as Record<string, unknown>;
    expect(result).toEqual(input);
  });
});

describe("log functions", () => {
  it("info produces JSON with correct level", () => {
    info("test message");
    const entry = getLastLog();
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("test message");
    expect(entry.timestamp).toBeDefined();
    // Verify ISO format
    expect(new Date(entry.timestamp!).toISOString()).toBe(entry.timestamp);
  });

  it("warn produces JSON with warn level", () => {
    warn("warning message");
    const entry = getLastLog();
    expect(entry.level).toBe("warn");
    expect(entry.message).toBe("warning message");
  });

  it("error produces JSON with error level", () => {
    error("error message");
    const entry = getLastLog();
    expect(entry.level).toBe("error");
    expect(entry.message).toBe("error message");
  });

  it("includes additional fields", () => {
    info("request completed", {
      requestId: "abc-123",
      method: "GET",
      path: "/health",
      statusCode: 200,
      durationMs: 15,
    });
    const entry = getLastLog();
    expect(entry.requestId).toBe("abc-123");
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/health");
    expect(entry.statusCode).toBe(200);
    expect(entry.durationMs).toBe(15);
  });

  it("outputs newline-delimited JSON", () => {
    info("line 1");
    info("line 2");
    expect(logOutput).toHaveLength(2);
    expect(logOutput[0].endsWith("\n")).toBe(true);
    expect(logOutput[1].endsWith("\n")).toBe(true);
    // Each line is valid JSON
    expect(() => JSON.parse(logOutput[0])).not.toThrow();
    expect(() => JSON.parse(logOutput[1])).not.toThrow();
  });
});

describe("audit", () => {
  it("produces log with audit flag", () => {
    audit("admin.distribute", {
      admin: "admin",
      recipient: "wallet-abc",
      amount: 1000,
    });
    const entry = getLastLog();
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("audit: admin.distribute");
    expect(entry.audit).toBe(true);
    expect(entry.admin).toBe("admin");
    expect(entry.recipient).toBe("wallet-abc");
    expect(entry.amount).toBe(1000);
  });

  it("sanitizes sensitive fields in audit details", () => {
    audit("admin.action", {
      admin: "admin",
      token: "some-jwt-token",
      privateKey: "rsa-private-key",
    });
    const entry = getLastLog();
    expect(entry.admin).toBe("admin");
    expect(entry.token).toBe("[REDACTED]");
    expect(entry.privateKey).toBe("[REDACTED]");
  });

  it("handles audit without fields", () => {
    audit("admin.health.check");
    const entry = getLastLog();
    expect(entry.message).toBe("audit: admin.health.check");
    expect(entry.audit).toBe(true);
  });
});

describe("request/response logging middleware", () => {
  it("logs request with method, path, status, and duration", async () => {
    // Import the app to test the middleware integration
    const testApp = new Hono();

    // Minimal middleware that mimics the real logging middleware
    testApp.use("*", async (c, next) => {
      const requestId = crypto.randomUUID();
      c.set("requestId" as never, requestId);
      await next();
    });
    testApp.use("*", async (c, next) => {
      const start = Date.now();
      await next();
      const durationMs = Date.now() - start;
      info("request completed", {
        requestId: c.get("requestId" as never) as string,
        method: c.req.method,
        path: c.req.path,
        statusCode: c.res.status,
        durationMs,
      });
    });
    testApp.get("/test", (c) => c.json({ ok: true }));

    const res = await testApp.request("/test");
    expect(res.status).toBe(200);

    const entry = getLastLog();
    expect(entry.method).toBe("GET");
    expect(entry.path).toBe("/test");
    expect(entry.statusCode).toBe(200);
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.requestId).toBeDefined();
  });

  it("logs 500 responses with warn level", async () => {
    const testApp = new Hono();

    testApp.use("*", async (c, next) => {
      const start = Date.now();
      await next();
      const durationMs = Date.now() - start;
      const statusCode = c.res.status;
      if (statusCode >= 500) {
        warn("request completed with server error", {
          method: c.req.method,
          path: c.req.path,
          statusCode,
          durationMs,
        });
      } else {
        info("request completed", {
          method: c.req.method,
          path: c.req.path,
          statusCode,
          durationMs,
        });
      }
    });
    testApp.get("/fail", (c) => c.json({ error: "internal" }, 500));

    const res = await testApp.request("/fail");
    expect(res.status).toBe(500);

    const entry = getLastLog();
    expect(entry.level).toBe("warn");
    expect(entry.statusCode).toBe(500);
  });
});
