import { HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import { createServer } from "node:http";
import { NodeClient } from "./node-client.js";
import { UserStore } from "./user-store.js";
import { makeRouter } from "./router.js";
import { API_PORT } from "@wpm/shared";

const HttpLive = NodeHttpServer.layer(() => createServer(), { port: API_PORT });

const ServicesLive = Layer.mergeAll(NodeClient.Live, UserStore.Live("users.json")).pipe(
  Layer.provide(NodeHttpClient.layer),
);

const program = Effect.gen(function* () {
  const nodeClient = yield* NodeClient;

  // Wait for node to be healthy
  yield* nodeClient.health.pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("not ready"))),
    Effect.retry(Schedule.fixed("1 second").pipe(Schedule.intersect(Schedule.recurs(30)))),
  );

  const router = yield* makeRouter;
  yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
  yield* Effect.logInfo(`API server listening on port ${API_PORT}`);
  yield* Effect.never;
});

const MainLive = ServicesLive.pipe(Layer.provideMerge(HttpLive));

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(MainLive)));
