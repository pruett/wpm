import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// --- Error envelope type matching spec Section 7 ---

type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

// --- Error catalog constants ---
// Each entry: [code, default HTTP status, default message]

const ERRORS = {
  UNAUTHORIZED: [401, "Authentication required"] as const,
  FORBIDDEN: [403, "Insufficient permissions"] as const,
  NOT_FOUND: [404, "Resource not found"] as const,
  MARKET_NOT_FOUND: [404, "Market not found"] as const,
  RECIPIENT_NOT_FOUND: [404, "Recipient not found"] as const,
  MARKET_CLOSED: [400, "Market betting window has closed"] as const,
  MARKET_ALREADY_RESOLVED: [400, "Market is already resolved"] as const,
  MARKET_HAS_TRADES: [400, "Cannot override market with existing trades"] as const,
  INSUFFICIENT_BALANCE: [400, "Insufficient WPM balance"] as const,
  INSUFFICIENT_SHARES: [400, "Insufficient shares to sell"] as const,
  INVALID_AMOUNT: [400, "Invalid amount"] as const,
  INVALID_OUTCOME: [400, 'Outcome must be "A" or "B"'] as const,
  INVALID_INVITE_CODE: [400, "Invalid or exhausted invite code"] as const,
  DUPLICATE_REGISTRATION: [409, "Email already registered"] as const,
  CHALLENGE_EXPIRED: [400, "Authentication challenge has expired"] as const,
  WEBAUTHN_VERIFICATION_FAILED: [400, "WebAuthn verification failed"] as const,
  INVALID_TRANSFER: [400, "Invalid transfer"] as const,
  VALIDATION_ERROR: [400, "Request validation failed"] as const,
  RATE_LIMITED: [429, "Too many requests"] as const,
  NODE_UNAVAILABLE: [503, "Blockchain node is unreachable"] as const,
  INTERNAL_ERROR: [500, "Internal server error"] as const,
} as const;

type ErrorCode = keyof typeof ERRORS;

// --- Helper to build error response body ---

function apiError(code: ErrorCode, message?: string): ApiErrorBody {
  const [, defaultMessage] = ERRORS[code];
  return {
    error: {
      code,
      message: message ?? defaultMessage,
    },
  };
}

// --- Helper to build and send error response from Hono context ---

function sendError(c: Context, code: ErrorCode, message?: string, status?: ContentfulStatusCode) {
  const [defaultStatus] = ERRORS[code];
  return c.json(apiError(code, message), (status ?? defaultStatus) as ContentfulStatusCode);
}

export { ERRORS, apiError, sendError };
export type { ErrorCode, ApiErrorBody };
