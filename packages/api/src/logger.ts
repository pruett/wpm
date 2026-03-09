// Structured JSON logger using Bun.write(Bun.stdout) for zero-copy output.
// Never logs: private keys, JWT tokens, full WebAuthn credentials.

type LogLevel = "info" | "warn" | "error";

type LogEntry = {
  timestamp: string;
  level: LogLevel;
  requestId?: string;
  userId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
};

// Fields that must never appear in logs
const SENSITIVE_KEYS = new Set([
  "password",
  "private_key",
  "privateKey",
  "wallet_private_key_enc",
  "walletPrivateKeyEnc",
  "secret",
  "jwt_secret",
  "jwtSecret",
  "token",
  "accessToken",
  "refreshToken",
  "wpm_refresh",
  "apiKey",
  "api_key",
  "credential",
  "publicKey",
  "public_key",
  "attestation",
  "assertion",
  "signature",
  "WALLET_ENCRYPTION_KEY",
  "ADMIN_API_KEY",
  "ORACLE_PRIVATE_KEY",
]);

function sanitize(obj: unknown, depth = 0): unknown {
  if (depth > 5 || obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => sanitize(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitize(value, depth + 1);
    }
  }
  return result;
}

const encoder = new TextEncoder();

function writeLog(entry: LogEntry): void {
  const line = JSON.stringify(entry) + "\n";
  Bun.write(Bun.stdout, encoder.encode(line));
}

function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const sanitized = fields ? (sanitize(fields) as Record<string, unknown>) : undefined;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...sanitized,
  };
  writeLog(entry);
}

function info(message: string, fields?: Record<string, unknown>): void {
  log("info", message, fields);
}

function warn(message: string, fields?: Record<string, unknown>): void {
  log("warn", message, fields);
}

function error(message: string, fields?: Record<string, unknown>): void {
  log("error", message, fields);
}

function audit(action: string, fields?: Record<string, unknown>): void {
  log("info", `audit: ${action}`, { audit: true, ...fields });
}

export { info, warn, error, audit, sanitize, writeLog };
export type { LogLevel, LogEntry };
