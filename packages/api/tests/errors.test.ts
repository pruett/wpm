import { describe, expect, it } from "bun:test";
import { ERRORS, apiError, sendError } from "../src/errors";
import type { ErrorCode, ApiErrorBody } from "../src/errors";
import { Hono } from "hono";

describe("apiError", () => {
  it("returns error envelope with default message", () => {
    const result = apiError("UNAUTHORIZED");
    expect(result).toEqual({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });

  it("returns error envelope with custom message", () => {
    const result = apiError("MARKET_NOT_FOUND", "Market abc123 does not exist");
    expect(result).toEqual({
      error: { code: "MARKET_NOT_FOUND", message: "Market abc123 does not exist" },
    });
  });

  it("returns correct structure for every error code", () => {
    for (const code of Object.keys(ERRORS) as ErrorCode[]) {
      const result = apiError(code);
      expect(result.error.code).toBe(code);
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("ERRORS catalog", () => {
  it("contains all 20 error codes from spec", () => {
    const expectedCodes: ErrorCode[] = [
      "UNAUTHORIZED",
      "FORBIDDEN",
      "MARKET_NOT_FOUND",
      "RECIPIENT_NOT_FOUND",
      "MARKET_CLOSED",
      "MARKET_ALREADY_RESOLVED",
      "MARKET_HAS_TRADES",
      "INSUFFICIENT_BALANCE",
      "INSUFFICIENT_SHARES",
      "INVALID_AMOUNT",
      "INVALID_OUTCOME",
      "INVALID_INVITE_CODE",
      "DUPLICATE_REGISTRATION",
      "CHALLENGE_EXPIRED",
      "WEBAUTHN_VERIFICATION_FAILED",
      "INVALID_TRANSFER",
      "VALIDATION_ERROR",
      "RATE_LIMITED",
      "NODE_UNAVAILABLE",
      "INTERNAL_ERROR",
    ];
    expect(Object.keys(ERRORS).sort()).toEqual([...expectedCodes].sort());
  });

  it("maps correct HTTP status codes", () => {
    const statusMap: Record<string, number> = {
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      MARKET_NOT_FOUND: 404,
      RECIPIENT_NOT_FOUND: 404,
      MARKET_CLOSED: 400,
      MARKET_ALREADY_RESOLVED: 400,
      MARKET_HAS_TRADES: 400,
      INSUFFICIENT_BALANCE: 400,
      INSUFFICIENT_SHARES: 400,
      INVALID_AMOUNT: 400,
      INVALID_OUTCOME: 400,
      INVALID_INVITE_CODE: 400,
      DUPLICATE_REGISTRATION: 409,
      CHALLENGE_EXPIRED: 400,
      WEBAUTHN_VERIFICATION_FAILED: 400,
      INVALID_TRANSFER: 400,
      RATE_LIMITED: 429,
      NODE_UNAVAILABLE: 503,
      INTERNAL_ERROR: 500,
    };

    for (const [code, expectedStatus] of Object.entries(statusMap)) {
      const [status] = ERRORS[code as ErrorCode];
      expect(status).toBe(expectedStatus);
    }
  });
});

describe("sendError", () => {
  it("sends JSON response with correct status and body", async () => {
    const app = new Hono();
    app.get("/test", (c) => sendError(c, "MARKET_NOT_FOUND"));

    const res = await app.request("/test");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
    expect(body.error.message).toBe("Market not found");
  });

  it("allows custom message override", async () => {
    const app = new Hono();
    app.get("/test", (c) => sendError(c, "INSUFFICIENT_BALANCE", "Need 500 WPM, have 100"));

    const res = await app.request("/test");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.message).toBe("Need 500 WPM, have 100");
  });

  it("allows status override", async () => {
    const app = new Hono();
    app.get("/test", (c) => sendError(c, "NODE_UNAVAILABLE", undefined, 502));

    const res = await app.request("/test");
    expect(res.status).toBe(502);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.code).toBe("NODE_UNAVAILABLE");
  });
});
