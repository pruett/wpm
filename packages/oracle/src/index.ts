import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import { NflAdapter } from "./adapters/nfl.js";
import { NodeClient } from "./node-client.js";
import { ingest } from "./ingest.js";

const program = Effect.gen(function* () {
  const node = yield* NodeClient;

  // Wait for node to be healthy
  yield* node.health.pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("not ready"))),
    Effect.retry(Schedule.fixed("1 second").pipe(Schedule.intersect(Schedule.recurs(30)))),
  );
  yield* Effect.logInfo("Node is healthy");

  // Run ingest every 2 hours
  yield* ingest.pipe(
    Effect.tap((result) =>
      Effect.logInfo(
        `Oracle ingest done — ${result.created} markets created, ${result.skipped} skipped`,
      ),
    ),
    Effect.catchAll((e) => Effect.logError(`Ingest failed: ${e}`)),
    Effect.repeat(Schedule.fixed("2 hours")),
  );
});

const ServicesLive = Layer.mergeAll(NflAdapter.Live, NodeClient.Live).pipe(
  Layer.provide(NodeHttpClient.layer),
);

NodeRuntime.runMain(program.pipe(Effect.provide(ServicesLive)));
