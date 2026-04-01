import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import { NflAdapter } from "./adapters/nfl.js";
import { GolfAdapter } from "./adapters/golf.js";
import { MlbAdapter } from "./adapters/mlb.js";
import { NodeClient } from "./node-client.js";
import { ingest } from "./ingest.js";
import { golfIngest } from "./golf-ingest.js";
import { mlbIngest } from "./mlb-ingest.js";

const runIngestCycle = Effect.all([
  ingest.pipe(
    Effect.tap((r) =>
      Effect.logInfo(`NFL ingest done — ${r.created} created, ${r.skipped} skipped`),
    ),
    Effect.catchAll((e) => Effect.logError(`NFL ingest failed: ${e}`)),
  ),
  golfIngest.pipe(
    Effect.tap((r) =>
      Effect.logInfo(`Golf ingest done — ${r.created} created, ${r.skipped} skipped`),
    ),
    Effect.catchAll((e) => Effect.logError(`Golf ingest failed: ${e}`)),
  ),
  mlbIngest.pipe(
    Effect.tap((r) =>
      Effect.logInfo(`MLB ingest done — ${r.created} created, ${r.skipped} skipped`),
    ),
    Effect.catchAll((e) => Effect.logError(`MLB ingest failed: ${e}`)),
  ),
]);

const program = Effect.gen(function* () {
  const node = yield* NodeClient;

  // Wait for node to be healthy
  yield* node.health.pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("not ready"))),
    Effect.retry(Schedule.fixed("1 second").pipe(Schedule.intersect(Schedule.recurs(30)))),
  );
  yield* Effect.logInfo("Node is healthy");

  // Run all adapter ingests every 2 hours
  yield* runIngestCycle.pipe(Effect.repeat(Schedule.fixed("2 hours")));
});

const ServicesLive = Layer.mergeAll(
  NflAdapter.Live,
  GolfAdapter.Live,
  MlbAdapter.Live,
  NodeClient.Live,
).pipe(Layer.provide(NodeHttpClient.layer));

NodeRuntime.runMain(program.pipe(Effect.provide(ServicesLive)));
