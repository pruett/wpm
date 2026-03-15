import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import { WpmApi } from "../Api"
import { Unauthorized } from "../errors"
import { AuthService } from "../services/AuthService"
import { SseRelayService } from "../services/SseRelay"

export const EventsHandlersLive = HttpApiBuilder.group(WpmApi, "events", (handlers) =>
  Effect.gen(function*() {
    const auth = yield* AuthService
    const relay = yield* SseRelayService

    return handlers
      .handleRaw("stream", ({ urlParams, request }) =>
        Effect.gen(function*() {
          const token = urlParams.token
          if (!token) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Missing token query parameter" }),
            )
          }

          const payload = yield* auth.verifyJwt(token).pipe(
            Effect.catchAll(() =>
              Effect.fail(
                new Unauthorized({ message: "Invalid or expired token" }),
              ),
            ),
          )

          const lastEventId =
            urlParams.lastEventId ??
            request.headers["last-event-id"] ??
            undefined

          const stream = yield* relay.subscribe(payload.sub, lastEventId)

          return HttpServerResponse.raw(stream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          })
        }),
      )
  }),
)
