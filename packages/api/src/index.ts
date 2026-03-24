import { HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { createServer } from "node:http";
import { NodeClient } from "./node-client.js";
import { UserKeys } from "./user-keys.js";
import { makeRouter } from "./router.js";

const HttpLive = NodeHttpServer.layer(() => createServer(), { port: 4101 });

const ServicesLive = Layer.mergeAll(NodeClient.Live, UserKeys.Live).pipe(
  Layer.provide(NodeHttpClient.layer),
);

const program = Effect.gen(function* () {
  const router = yield* makeRouter;
  yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
  yield* Effect.logInfo("API server listening on port 4101");
  yield* Effect.never;
});

const MainLive = ServicesLive.pipe(Layer.provideMerge(HttpLive));

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(MainLive)));
