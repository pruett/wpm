import { HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import { createServer } from "node:http";
import { NodeClient } from "./node-client.js";
import { UserKeys } from "./user-keys.js";
import { makeRouter } from "./router.js";
import { addressOf, SIGNUP_AIRDROP } from "@wpm/shared";

const HttpLive = NodeHttpServer.layer(() => createServer(), { port: 4101 });

const ServicesLive = Layer.mergeAll(NodeClient.Live, UserKeys.Live).pipe(
  Layer.provide(NodeHttpClient.layer),
);

const program = Effect.gen(function* () {
  const nodeClient = yield* NodeClient;
  const userKeys = yield* UserKeys;

  // Wait for node to be healthy
  yield* nodeClient.health.pipe(
    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("not ready"))),
    Effect.retry(Schedule.fixed("1 second").pipe(Schedule.intersect(Schedule.recurs(30)))),
  );

  // Fund user wallet if needed
  const balance = yield* nodeClient.getBalance(addressOf(userKeys.publicKey));
  if (balance === 0) {
    yield* nodeClient.distribute(userKeys.publicKey, SIGNUP_AIRDROP, "api_user_fund");
    yield* Effect.logInfo(
      `Funded user ${addressOf(userKeys.publicKey).slice(0, 12)}... with ${SIGNUP_AIRDROP.toLocaleString()} WPM`,
    );
  }

  const router = yield* makeRouter;
  yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
  yield* Effect.logInfo("API server listening on port 4101");
  yield* Effect.never;
});

const MainLive = ServicesLive.pipe(Layer.provideMerge(HttpLive));

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(MainLive)));
