import { sign, verify } from "hono/jwt";
import { setCookie, getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";

const ALG = "HS256";
const DEFAULT_ACCESS_TTL = 15 * 60; // 15 minutes
const REFRESH_TTL = 7 * 24 * 60 * 60; // 7 days
const REFRESH_COOKIE_NAME = "wpm_refresh";

type JwtUserPayload = {
  sub: string;
  role: "user" | "admin";
  walletAddress?: string;
  email?: string;
  iat: number;
  exp: number;
};

type RefreshTokenPayload = {
  sub: string;
  type: "refresh";
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

async function signRefreshToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: RefreshTokenPayload = {
    sub: userId,
    type: "refresh",
    iat: now,
    exp: now + REFRESH_TTL,
  };
  return sign(payload, getJwtSecret(), ALG);
}

async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const payload = await verify(token, getJwtSecret(), ALG);
  const typed = payload as unknown as RefreshTokenPayload;
  if (typed.type !== "refresh") {
    throw new Error("Not a refresh token");
  }
  return typed;
}

function setRefreshCookie(c: Context, token: string): void {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: REFRESH_TTL,
    path: "/",
  });
}

function getRefreshCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE_NAME);
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

export {
  signJwt,
  verifyJwt,
  signRefreshToken,
  verifyRefreshToken,
  setRefreshCookie,
  getRefreshCookie,
  authMiddleware,
  REFRESH_COOKIE_NAME,
};
export type { JwtUserPayload, RefreshTokenPayload };
