import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import type { OracleJob } from "@wpm/shared";
import { NflAdapter } from "./adapters/nfl.js";
import { GolfAdapter } from "./adapters/golf.js";
import { MlbAdapter } from "./adapters/mlb.js";
import { WebClient } from "./web-client.js";
import { ingest } from "./ingest.js";
import { golfIngest } from "./golf-ingest.js";
import { mlbIngest } from "./mlb-ingest.js";
import { resolveAll } from "./resolve.js";
import { cancelAll } from "./cancel.js";

type JobResult = "ok" | "error";

const track = <A, E, R>(
  name: string,
  eff: Effect.Effect<A, E, R>,
  describe: (a: A) => string,
): Effect.Effect<JobResult, never, R> =>
  eff.pipe(
    Effect.tap((r) => Effect.logInfo(describe(r))),
    Effect.as<JobResult>("ok"),
    Effect.catchAll((e) =>
      Effect.logError(`${name} failed: ${e}`).pipe(Effect.as<JobResult>("error")),
    ),
  );

const sendHeartbeat = (job: OracleJob, results: readonly JobResult[]) =>
  Effect.gen(function* () {
    const web = yield* WebClient;
    const status = results.includes("error") ? "error" : "ok";
    yield* web
      .heartbeat({ job, status })
      .pipe(Effect.catchAll((e) => Effect.logError(`heartbeat(${job}) failed: ${e}`)));
  });

const runIngestCycle = Effect.gen(function* () {
  const results = yield* Effect.all(
    [
      track(
        "NFL ingest",
        ingest,
        (r) => `NFL ingest done — ${r.created} created, ${r.skipped} skipped`,
      ),
      track(
        "Golf ingest",
        golfIngest,
        (r) => `Golf ingest done — ${r.created} created, ${r.skipped} skipped`,
      ),
      track(
        "MLB ingest",
        mlbIngest,
        (r) => `MLB ingest done — ${r.created} created, ${r.skipped} skipped`,
      ),
    ],
    { concurrency: "unbounded" },
  );
  yield* sendHeartbeat("ingest", results);
});

const runLivenessTick = Effect.gen(function* () {
  const web = yield* WebClient;
  yield* web
    .heartbeat({ job: "liveness", status: "ok" })
    .pipe(Effect.catchAll((e) => Effect.logError(`heartbeat(liveness) failed: ${e}`)));
});

const runResolveCycle = Effect.gen(function* () {
  const results = yield* Effect.all(
    [
      track(
        "Resolve cycle",
        resolveAll,
        (r) => `Resolve cycle done — ${r.resolved} resolved, ${r.skipped} skipped`,
      ),
      track("Cancel cycle", cancelAll, (r) => `Cancel cycle done — ${r.cancelled} cancelled`),
    ],
    { concurrency: "unbounded" },
  );
  yield* sendHeartbeat("resolve", results);
});

const program = Effect.gen(function* () {
  const web = yield* WebClient;

  yield* web.health.pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("not ready"))),
    Effect.retry(Schedule.fixed("1 second").pipe(Schedule.intersect(Schedule.recurs(30)))),
  );
  yield* Effect.logInfo("Web app is healthy");

  yield* Effect.all(
    [
      runLivenessTick.pipe(Effect.repeat(Schedule.fixed("1 minute"))),
      runIngestCycle.pipe(Effect.repeat(Schedule.fixed("2 hours"))),
      runResolveCycle.pipe(Effect.repeat(Schedule.fixed("30 minutes"))),
    ],
    { concurrency: "unbounded" },
  );
});

const ServicesLive = Layer.mergeAll(
  NflAdapter.Live,
  GolfAdapter.Live,
  MlbAdapter.Live,
  WebClient.Live,
).pipe(Layer.provide(NodeHttpClient.layer));

NodeRuntime.runMain(program.pipe(Effect.provide(ServicesLive)));
