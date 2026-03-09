import type { ErrorCode } from "./errors";

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

export { validateAmount, validateOutcome, validateMarketTradeable };
