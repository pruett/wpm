import { Context, Effect, Layer, Redacted } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "@effect/platform"
import { Unauthorized } from "../errors"
import { AuthService } from "../services/AuthService"
import type { JwtUserPayload } from "../services/AuthService"

export class CurrentUser extends Context.Tag("CurrentUser")<CurrentUser, JwtUserPayload>() {}

export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()(
  "AuthMiddleware",
  {
    provides: CurrentUser,
    failure: Unauthorized,
    security: { bearer: HttpApiSecurity.bearer },
  },
) {}

export const AuthMiddlewareLive = Layer.effect(
  AuthMiddleware,
  Effect.gen(function*() {
    const auth = yield* AuthService

    return AuthMiddleware.of({
      bearer: (token) =>
        auth.verifyJwt(Redacted.value(token)).pipe(
          Effect.catchAll(() =>
            Effect.fail(new Unauthorized({ message: "Invalid or expired token" })),
          ),
        ),
    })
  }),
)
