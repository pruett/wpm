import { Effect, Layer } from "effect"
import { HttpApiMiddleware } from "@effect/platform"
import { Forbidden } from "../errors"

// AdminMiddleware is a marker middleware. The actual admin check is done
// in admin handlers by reading CurrentUser (provided by AuthMiddleware).
// This middleware exists to declare the Forbidden error type on admin endpoints.
export class AdminMiddleware extends HttpApiMiddleware.Tag<AdminMiddleware>()(
  "AdminMiddleware",
  {
    failure: Forbidden,
  },
) {}

export const AdminMiddlewareLive = Layer.succeed(
  AdminMiddleware,
  AdminMiddleware.of(Effect.void),
)
