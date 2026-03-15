import { Effect, Layer, Redacted } from "effect"
import { AppConfigService } from "../Config"

const ALG = "HS256"
const DEFAULT_ACCESS_TTL = 15 * 60 // 15 minutes
const REFRESH_TTL = 7 * 24 * 60 * 60 // 7 days

export type JwtUserPayload = {
  sub: string
  role: "user" | "admin"
  walletAddress?: string
  email?: string
  iat: number
  exp: number
}

export type RefreshTokenPayload = {
  sub: string
  type: "refresh"
  iat: number
  exp: number
}

export class AuthService extends Effect.Tag("AuthService")<
  AuthService,
  {
    readonly signJwt: (
      payload: Omit<JwtUserPayload, "iat" | "exp"> & { exp?: number },
    ) => Effect.Effect<string>
    readonly verifyJwt: (token: string) => Effect.Effect<JwtUserPayload, JwtVerifyError>
    readonly signRefreshToken: (userId: string) => Effect.Effect<string>
    readonly verifyRefreshToken: (
      token: string,
    ) => Effect.Effect<RefreshTokenPayload, JwtVerifyError>
    readonly jwtSecret: string
  }
>() {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function*() {
      const config = yield* AppConfigService
      const secret = Redacted.value(config.jwtSecret)

      // Use Bun's native JWT support for HMAC-SHA256
      const signJwt = (
        payload: Omit<JwtUserPayload, "iat" | "exp"> & { exp?: number },
      ): Effect.Effect<string> =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000)
          const fullPayload: JwtUserPayload = {
            ...payload,
            iat: now,
            exp: payload.exp ?? now + DEFAULT_ACCESS_TTL,
          }
          const header = btoa(JSON.stringify({ alg: ALG, typ: "JWT" }))
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
          const body = btoa(JSON.stringify(fullPayload))
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
          const data = `${header}.${body}`
          const hasher = new Bun.CryptoHasher("sha256", secret)
          hasher.update(data)
          const sig = Buffer.from(hasher.digest()).toString("base64url")
          return `${data}.${sig}`
        })

      const verifyJwt = (token: string): Effect.Effect<JwtUserPayload, JwtVerifyError> =>
        Effect.try({
          try: () => {
            const parts = token.split(".")
            if (parts.length !== 3) throw new Error("Invalid JWT format")

            const [headerB64, bodyB64, sigB64] = parts
            const data = `${headerB64}.${bodyB64}`
            const hasher = new Bun.CryptoHasher("sha256", secret)
            hasher.update(data)
            const expectedSig = Buffer.from(hasher.digest()).toString("base64url")

            if (expectedSig !== sigB64) throw new Error("Invalid signature")

            // Pad base64url for atob
            const pad = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4)
            const payload = JSON.parse(atob(pad(bodyB64))) as JwtUserPayload

            const now = Math.floor(Date.now() / 1000)
            if (payload.exp && payload.exp < now) throw new Error("Token expired")

            return payload
          },
          catch: () => new JwtVerifyError(),
        })

      const signRefreshToken = (userId: string): Effect.Effect<string> =>
        Effect.sync(() => {
          const now = Math.floor(Date.now() / 1000)
          const payload: RefreshTokenPayload = {
            sub: userId,
            type: "refresh",
            iat: now,
            exp: now + REFRESH_TTL,
          }
          const header = btoa(JSON.stringify({ alg: ALG, typ: "JWT" }))
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
          const body = btoa(JSON.stringify(payload))
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
          const data = `${header}.${body}`
          const hasher = new Bun.CryptoHasher("sha256", secret)
          hasher.update(data)
          const sig = Buffer.from(hasher.digest()).toString("base64url")
          return `${data}.${sig}`
        })

      const verifyRefreshToken = (
        token: string,
      ): Effect.Effect<RefreshTokenPayload, JwtVerifyError> =>
        verifyJwt(token).pipe(
          Effect.flatMap((payload) => {
            const typed = payload as unknown as RefreshTokenPayload
            if (typed.type !== "refresh") {
              return Effect.fail(new JwtVerifyError())
            }
            return Effect.succeed(typed)
          }),
        )

      return {
        signJwt,
        verifyJwt,
        signRefreshToken,
        verifyRefreshToken,
        jwtSecret: secret,
      }
    }),
  )
}

export class JwtVerifyError {
  readonly _tag = "JwtVerifyError" as const
}

export const REFRESH_TTL_SECONDS = REFRESH_TTL
export const REFRESH_COOKIE_NAME = "wpm_refresh"
