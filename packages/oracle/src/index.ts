import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import { NflAdapter } from "./adapters/nfl.js";
import { GolfAdapter } from "./adapters/golf.js";
import { MlbAdapter } from "./adapters/mlb.js";
import { WebClient } from "./web-client.js";
import { ingest } from "./ingest.js";
import { golfIngest } from "./golf-ingest.js";
import { mlbIngest } from "./mlb-ingest.js";
import { resolveAll } from "./resolve.js";
import { cancelAll } from "./cancel.js";

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

const runResolveCycle = Effect.all([
  resolveAll.pipe(
    Effect.tap((r) =>
      Effect.logInfo(`Resolve cycle done — ${r.resolved} resolved, ${r.skipped} skipped`),
    ),
    Effect.catchAll((e) => Effect.logError(`Resolve cycle failed: ${e}`)),
  ),
  cancelAll.pipe(
    Effect.tap((r) => Effect.logInfo(`Cancel cycle done — ${r.cancelled} cancelled`)),
    Effect.catchAll((e) => Effect.logError(`Cancel cycle failed: ${e}`)),
  ),
]);

const program = Effect.gen(function* () {
  const web = yield* WebClient;

  yield* web.health.pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("not ready"))),
    Effect.retry(Schedule.fixed("1 second").pipe(Schedule.intersect(Schedule.recurs(30)))),
  );
  yield* Effect.logInfo("Web app is healthy");

  yield* Effect.all([
    runIngestCycle.pipe(Effect.repeat(Schedule.fixed("2 hours"))),
    runResolveCycle.pipe(Effect.repeat(Schedule.fixed("30 minutes"))),
  ]);
});

const ServicesLive = Layer.mergeAll(
  NflAdapter.Live,
  GolfAdapter.Live,
  MlbAdapter.Live,
  WebClient.Live,
).pipe(Layer.provide(NodeHttpClient.layer));

NodeRuntime.runMain(program.pipe(Effect.provide(ServicesLive)));
