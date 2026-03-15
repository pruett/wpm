import { Effect, Layer, Ref } from "effect"

type RateLimitStore = Map<string, number[]>

export class RateLimiterService extends Effect.Tag("RateLimiter")<
  RateLimiterService,
  {
    readonly checkLimit: (config: {
      key: string
      limit: number
      windowMs: number
    }) => Effect.Effect<void, RateLimitExceeded>
  }
>() {
  static readonly layer = Layer.scoped(
    this,
    Effect.gen(function*() {
      const store = yield* Ref.make<RateLimitStore>(new Map())

      // Periodic cleanup every 60s
      yield* Effect.gen(function*() {
        while (true) {
          yield* Effect.sleep("60 seconds")
          const now = Date.now()
          yield* Ref.update(store, (s) => {
            const next = new Map<string, number[]>()
            for (const [key, timestamps] of s) {
              const valid = timestamps.filter((t) => t > now - 120_000)
              if (valid.length > 0) {
                next.set(key, valid)
              }
            }
            return next
          })
        }
      }).pipe(Effect.forkScoped)

      return {
        checkLimit: ({ key, limit, windowMs }) =>
          Effect.gen(function*() {
            const now = Date.now()
            const windowStart = now - windowMs

            const s = yield* Ref.get(store)
            const next = new Map(s)
            const timestamps = next.get(key) ?? []
            const valid = timestamps.filter((t) => t > windowStart)

            if (valid.length >= limit) {
              const retryAfterMs = valid[0] + windowMs - now
              const retryAfterSec = Math.ceil(retryAfterMs / 1000)
              return yield* Effect.fail(
                new RateLimitExceeded({ retryAfter: retryAfterSec }),
              )
            }

            valid.push(now)
            next.set(key, valid)
            yield* Ref.set(store, next)
          }),
      }
    }),
  )
}

export class RateLimitExceeded {
  readonly _tag = "RateLimitExceeded" as const
  readonly retryAfter: number
  constructor(opts: { retryAfter: number }) {
    this.retryAfter = opts.retryAfter
  }
}
