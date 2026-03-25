import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Schedule } from "effect";

const MARKET = {
  id: "chiefs-vs-eagles-2026",
  name: "Chiefs vs Eagles - Super Bowl LXI",
  outcomes: ["Chiefs", "Eagles"],
  closesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  seedAmount: 1000,
};

const program = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  // Wait for node
  yield* client
    .get("http://localhost:4100/internal/health")
    .pipe(
      Effect.retry(Schedule.fixed("1 second").pipe(Schedule.intersect(Schedule.recurs(30)))),
      Effect.scoped,
    );

  // Check if market exists
  const res = yield* client.get("http://localhost:4100/internal/markets").pipe(Effect.scoped);
  const markets = (yield* res.json) as any[];
  if (markets.some((m: any) => m.market.id === MARKET.id)) {
    yield* Effect.logInfo("Market already exists, idling");
    return yield* Effect.never;
  }

  // Create market — node handles signing and treasury funding
  yield* HttpClientRequest.post("http://localhost:4100/internal/create-market").pipe(
    HttpClientRequest.bodyUnsafeJson(MARKET),
    client.execute,
    Effect.scoped,
  );
  yield* Effect.logInfo(`Created market: ${MARKET.name}`);

  // Simulate game result after a delay (tracer bullet: hardcoded resolution)
  yield* Effect.sleep("10 seconds");
  yield* HttpClientRequest.post("http://localhost:4100/internal/resolve-market").pipe(
    HttpClientRequest.bodyUnsafeJson({ id: MARKET.id, result: "A" }),
    client.execute,
    Effect.scoped,
  );
  yield* Effect.logInfo(`Resolved market: ${MARKET.name} → Chiefs win`);
  yield* Effect.never; // idle
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeHttpClient.layer)));
