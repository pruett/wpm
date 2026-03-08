import { sign, verify } from "hono/jwt";
import type { MiddlewareHandler } from "hono";

const ALG = "HS256";
const DEFAULT_ACCESS_TTL = 15 * 60; // 15 minutes

type JwtUserPayload = {
  sub: string;
  role: "user" | "admin";
  walletAddress?: string;
  email?: string;
  iat: number;
  exp: number;
};

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required");
  }
  return secret;
}

async function signJwt(
  payload: Omit<JwtUserPayload, "iat" | "exp"> & { exp?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtUserPayload = {
    ...payload,
    iat: now,
    exp: payload.exp ?? now + DEFAULT_ACCESS_TTL,
  };
  return sign(fullPayload, getJwtSecret(), ALG);
}

async function verifyJwt(token: string): Promise<JwtUserPayload> {
  const payload = await verify(token, getJwtSecret(), ALG);
  return payload as unknown as JwtUserPayload;
}

const authMiddleware: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header) {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Missing authorization header" } },
      401,
    );
  }

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid authorization format" } },
      401,
    );
  }

  try {
    const payload = await verifyJwt(parts[1]);
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } }, 401);
  }
};

export { signJwt, verifyJwt, authMiddleware };
export type { JwtUserPayload };
