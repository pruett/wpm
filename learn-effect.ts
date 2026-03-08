/**
 * ============================================================
 * Effect.ts Tutorial — Learn by Example
 * ============================================================
 *
 * Effect is a TypeScript library for building type-safe,
 * composable, and concurrent programs. Think of it as a
 * "better Promise" that also tracks errors and dependencies
 * in the type system.
 *
 * Run any section:  bun run learn-effect.ts
 */

import { Console, Effect, pipe, Layer, Context, Schedule, Stream } from "effect"

// ============================================================
// 1. THE CORE TYPE: Effect<Success, Error, Requirements>
// ============================================================
//
// An Effect<A, E, R> is a lazy, immutable description of a
// program that:
//   - Succeeds with a value of type A
//   - Can fail with an error of type E
//   - Needs dependencies of type R to run
//
// Compare to Promise<A> which only tracks the success type.
// Effect tracks ALL THREE at the type level.

// A simple effect that succeeds with a number
const succeed: Effect.Effect<number> = Effect.succeed(42)
//                                     ^^^ Error = never, Requirements = never

// A simple effect that fails
const fail: Effect.Effect<never, string> = Effect.fail("something went wrong")

// An effect built from a sync function (lazy — won't run until executed)
const lazy: Effect.Effect<number> = Effect.sync(() => {
  console.log("  [1] This only runs when the effect is executed")
  return Math.random()
})

console.log("=== 1. Core Type ===")
console.log("Effects are lazy descriptions. Nothing has run yet.")

// To actually run an effect, use Effect.runPromise or Effect.runSync
const result1 = await Effect.runPromise(succeed)
console.log("  succeed:", result1) // 42

const result2 = Effect.runSync(lazy)
console.log("  lazy:", result2)

// ============================================================
// 2. PIPE & COMPOSITION
// ============================================================
//
// `pipe` threads a value through a series of functions.
// This is how you compose effects — like chaining .then()
// on promises, but more flexible.

console.log("\n=== 2. Pipe & Composition ===")

const composed = pipe(
  Effect.succeed(10),
  // map: transform the success value (like .then on a promise)
  Effect.map((n) => n * 2),
  // tap: do something with the value without changing it
  Effect.tap((n) => Console.log(`  tapped: ${n}`)),
  // flatMap: chain to another effect (like .then that returns a promise)
  Effect.flatMap((n) => Effect.succeed(n + 5)),
)

const result3 = await Effect.runPromise(composed)
console.log("  composed result:", result3) // 25

// You can also use generator syntax for more readable code:
const withGenerator = Effect.gen(function* () {
  const a = yield* Effect.succeed(10)
  const b = yield* Effect.succeed(20)
  return a + b
})

console.log("  generator result:", await Effect.runPromise(withGenerator)) // 30

// ============================================================
// 3. ERROR HANDLING — Typed Errors
// ============================================================
//
// Unlike Promise, Effect tracks the error type. You can
// pattern match on errors, recover from specific ones, etc.

console.log("\n=== 3. Error Handling ===")

// Define error types
type NotFoundError = { readonly _tag: "NotFoundError"; readonly id: string }
type ValidationError = {
  readonly _tag: "ValidationError"
  readonly message: string
}

const findUser = (
  id: string,
): Effect.Effect<{ name: string }, NotFoundError> => {
  if (id === "1") return Effect.succeed({ name: "Alice" })
  return Effect.fail({ _tag: "NotFoundError", id })
}

const validateAge = (
  age: number,
): Effect.Effect<number, ValidationError> => {
  if (age >= 0 && age <= 150) return Effect.succeed(age)
  return Effect.fail({ _tag: "ValidationError", message: `Invalid age: ${age}` })
}

// Both error types are tracked in the Effect type!
const program = Effect.gen(function* () {
  const user = yield* findUser("1")
  const age = yield* validateAge(25)
  return { ...user, age }
})
// program: Effect<{name: string, age: number}, NotFoundError | ValidationError>

// Recover from specific errors using catchTag
const recovered = pipe(
  findUser("999"),
  Effect.catchTag("NotFoundError", (err) =>
    Effect.succeed({ name: `Unknown (${err.id})` }),
  ),
)

console.log("  found:", await Effect.runPromise(program))
console.log("  recovered:", await Effect.runPromise(recovered))

// catchAll: recover from any error
const withFallback = pipe(
  findUser("999"),
  Effect.catchAll(() => Effect.succeed({ name: "Fallback" })),
)
console.log("  fallback:", await Effect.runPromise(withFallback))

// ============================================================
// 4. SERVICES & DEPENDENCY INJECTION (the "R" in Effect<A,E,R>)
// ============================================================
//
// This is one of Effect's most powerful features. You declare
// what services your program needs, and the type system
// ensures they're provided before running.

console.log("\n=== 4. Services & Dependency Injection ===")

// Step 1: Define a service using Context.Tag
class Random extends Context.Tag("Random")<
  Random,
  { readonly next: () => Effect.Effect<number> }
>() {}

class Logger extends Context.Tag("Logger")<
  Logger,
  { readonly log: (msg: string) => Effect.Effect<void> }
>() {}

// Step 2: Write code that uses the service
const programWithDeps = Effect.gen(function* () {
  const random = yield* Random
  const logger = yield* Logger

  const n = yield* random.next()
  yield* logger.log(`  Got random number: ${n}`)
  return n
})
// Type: Effect<number, never, Random | Logger>
// The compiler knows this needs Random AND Logger!

// Step 3: Create implementations (Layers)
const RandomLive = Layer.succeed(Random, {
  next: () => Effect.sync(() => Math.random()),
})

const LoggerLive = Layer.succeed(Logger, {
  log: (msg: string) => Effect.sync(() => console.log(msg)),
})

// Step 4: Provide dependencies and run
const runnable = pipe(
  programWithDeps,
  Effect.provide(Layer.merge(RandomLive, LoggerLive)),
)
// Type: Effect<number, never, never> — all deps satisfied!

await Effect.runPromise(runnable)

// ============================================================
// 5. CONCURRENCY
// ============================================================
//
// Effect has built-in concurrency primitives that are much
// more powerful than Promise.all.

console.log("\n=== 5. Concurrency ===")

const task = (name: string, ms: number) =>
  pipe(
    Effect.sleep(ms),
    Effect.as(name),
    Effect.tap(() => Console.log(`  ${name} done (${ms}ms)`)),
  )

// Run effects in parallel (like Promise.all)
const parallel = Effect.all([task("A", 100), task("B", 50), task("C", 75)], {
  concurrency: "unbounded",
})

console.log(
  "  parallel results:",
  await Effect.runPromise(parallel),
)

// Control concurrency level
const limited = Effect.all(
  [task("X", 100), task("Y", 50), task("Z", 75), task("W", 60)],
  { concurrency: 2 }, // max 2 at a time
)
console.log(
  "  limited (2) results:",
  await Effect.runPromise(limited),
)

// Race: first to complete wins
const raced = Effect.race(task("Fast", 50), task("Slow", 200))
console.log("  race winner:", await Effect.runPromise(raced))

// ============================================================
// 6. RETRY & SCHEDULING
// ============================================================
//
// Built-in retry with composable schedules.

console.log("\n=== 6. Retry & Scheduling ===")

let attempt = 0
const flaky = Effect.gen(function* () {
  attempt++
  if (attempt < 3) {
    yield* Console.log(`  attempt ${attempt}: failing...`)
    return yield* Effect.fail("transient error")
  }
  yield* Console.log(`  attempt ${attempt}: success!`)
  return "ok"
})

const retried = pipe(
  flaky,
  // Retry up to 4 times with exponential backoff
  Effect.retry(
    Schedule.exponential("50 millis").pipe(Schedule.compose(Schedule.recurs(4))),
  ),
)

console.log("  retried result:", await Effect.runPromise(retried))

// ============================================================
// 7. STREAMS — Processing sequences of values
// ============================================================
//
// Stream is like an async iterable, but with all the
// composability and error tracking of Effect.

console.log("\n=== 7. Streams ===")

const numberStream = pipe(
  Stream.range(1, 10),
  Stream.map((n) => n * n),
  Stream.filter((n) => n % 2 === 0),
  Stream.tap((n) => Console.log(`  stream value: ${n}`)),
)

const collected = await Effect.runPromise(Stream.runCollect(numberStream))
console.log("  stream collected:", Array.from(collected))

// ============================================================
// 8. REAL-WORLD PATTERN — Wiring it together
// ============================================================
//
// Here's a pattern you might use in your prediction market:
// a service that fetches data, validates it, and handles errors.

console.log("\n=== 8. Real-World Pattern ===")

type FetchError = { readonly _tag: "FetchError"; readonly reason: string }
type ParseError = { readonly _tag: "ParseError"; readonly input: string }

type Market = {
  readonly id: string
  readonly question: string
  readonly probability: number
}

const fetchMarket = (
  id: string,
): Effect.Effect<Market, FetchError | ParseError> =>
  Effect.gen(function* () {
    // Simulate fetching
    if (id === "bad") {
      return yield* Effect.fail<FetchError>({
        _tag: "FetchError",
        reason: "Network timeout",
      })
    }

    const raw = { id, question: "Will BTC > 100k?", probability: 0.65 }

    // Simulate validation
    if (raw.probability < 0 || raw.probability > 1) {
      return yield* Effect.fail<ParseError>({
        _tag: "ParseError",
        input: JSON.stringify(raw),
      })
    }

    return raw
  })

const getMarketSafe = (id: string) =>
  pipe(
    fetchMarket(id),
    // Handle specific error types differently
    Effect.catchTag("FetchError", (e) => {
      console.log(`  Fetch failed: ${e.reason}, using cached data`)
      return Effect.succeed<Market>({
        id,
        question: "cached",
        probability: 0.5,
      })
    }),
    // Let ParseError propagate — that's a real bug
  )

const market = await Effect.runPromise(getMarketSafe("mkt-1"))
console.log("  market:", market)

const cached = await Effect.runPromise(getMarketSafe("bad"))
console.log("  cached fallback:", cached)

// ============================================================
// SUMMARY / CHEAT SHEET
// ============================================================
//
// Effect<A, E, R>          The core type: success A, error E, deps R
//
// Creating effects:
//   Effect.succeed(value)   Pure success value
//   Effect.fail(error)      Pure failure
//   Effect.sync(() => ...)  Lazy sync computation
//   Effect.promise(() =>)   Wrap a promise
//   Effect.gen(function*{}) Generator syntax (recommended!)
//
// Transforming:
//   Effect.map              Transform success value
//   Effect.flatMap           Chain to another effect
//   Effect.tap              Side effect without changing value
//   pipe(value, fn1, fn2)   Thread through functions
//
// Errors:
//   Effect.catchAll          Catch all errors
//   Effect.catchTag          Catch by _tag discriminant
//   Effect.either            Convert to Either (no more error channel)
//
// Concurrency:
//   Effect.all([...], opts)  Run effects with concurrency control
//   Effect.race              First to complete wins
//
// Services:
//   Context.Tag              Define a service interface
//   Layer.succeed             Create a service implementation
//   Effect.provide            Supply dependencies
//
// Running:
//   Effect.runPromise         Run and get a Promise
//   Effect.runSync            Run synchronously
//
// Next steps:
//   - Schema: runtime validation + serialization
//   - Ref: mutable state in a functional way
//   - Queue/PubSub: concurrent messaging
//   - Platform/HttpClient: HTTP with Effect integration
//

console.log("\n=== Tutorial complete! ===")
console.log("Read through learn-effect.ts for the full annotated guide.")
