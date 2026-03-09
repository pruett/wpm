import type { Context } from "hono";
import type { ErrorCode } from "./errors";
import { sendError } from "./errors";

/**
 * Round to 2 decimal places.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parse and clamp pagination query params.
 */
function parsePagination(
  c: Context,
  defaults?: { limit?: number; maxLimit?: number },
): { limit: number; offset: number } {
  const defaultLimit = defaults?.limit ?? 20;
  const maxLimit = defaults?.maxLimit ?? 100;
  const limitParam = Number(c.req.query("limit") ?? String(defaultLimit));
  const limit = Math.min(
    maxLimit,
    Math.max(1, Number.isFinite(limitParam) ? limitParam : defaultLimit),
  );
  const offsetParam = Number(c.req.query("offset") ?? "0");
  const offset = Math.max(0, Number.isFinite(offsetParam) ? offsetParam : 0);
  return { limit, offset };
}

/**
 * Parse JSON body, returning a VALIDATION_ERROR on failure.
 */
async function parseJsonBody(c: Context): Promise<Record<string, unknown> | Response> {
  try {
    return await c.req.json();
  } catch {
    return sendError(c, "VALIDATION_ERROR", "Invalid request body");
  }
}

/**
 * Validates a trading amount: must be a positive finite number with at most 2 decimal places.
 * Returns null if valid, or the appropriate ErrorCode if invalid.
 */
function validateAmount(n: unknown): ErrorCode | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return "INVALID_AMOUNT";
  }

  const parts = n.toString().split(".");
  if (parts[1] && parts[1].length > 2) {
    return "INVALID_AMOUNT";
  }

  return null;
}

/**
 * Validates a trading outcome: must be "A" or "B".
 * Returns null if valid, or the appropriate ErrorCode if invalid.
 */
function validateOutcome(o: unknown): o is "A" | "B" {
  return o === "A" || o === "B";
}

/**
 * Validates that a market is tradeable: must exist, be open, and not past eventStartTime.
 * Returns null if tradeable, or the appropriate ErrorCode if not.
 */
function validateMarketTradeable(market: {
  status: string;
  eventStartTime: number;
}): ErrorCode | null {
  if (market.status !== "open") {
    if (market.status === "resolved") {
      return "MARKET_ALREADY_RESOLVED";
    }
    return "MARKET_CLOSED";
  }

  if (Date.now() >= market.eventStartTime) {
    return "MARKET_CLOSED";
  }

  return null;
}

/**
 * Checks for unknown/extra fields in a request body.
 * Returns a descriptive string if extra fields are found, null if clean.
 */
function validateExtraFields(
  body: Record<string, unknown>,
  allowedFields: string[],
): string | null {
  const allowed = new Set(allowedFields);
  const extra = Object.keys(body).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    return `Unknown fields: ${extra.join(", ")}`;
  }
  return null;
}

/**
 * Validates that a market is open (without eventStartTime check, for admin operations).
 */
function validateMarketOpen(market: { status: string }): ErrorCode | null {
  if (market.status !== "open") {
    if (market.status === "resolved") {
      return "MARKET_ALREADY_RESOLVED";
    }
    return "MARKET_CLOSED";
  }
  return null;
}

export {
  round2,
  parsePagination,
  parseJsonBody,
  validateAmount,
  validateOutcome,
  validateMarketTradeable,
  validateMarketOpen,
  validateExtraFields,
};
