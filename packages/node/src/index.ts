import { HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import { createServer } from "node:http";
import { NODE_PORT } from "@wpm/shared";
import { ChainState } from "./chain-state.js";
import { EventBus } from "./event-bus.js";
import { Persistence } from "./persistence.js";
import { Mempool } from "./mempool.js";
import { Keys } from "./keys.js";
import { createGenesisBlock } from "./genesis.js";
import { makeRouter } from "./router.js";
import { produceBlock } from "./producer.js";

const HttpLive = NodeHttpServer.layer(() => createServer(), { port: NODE_PORT });

const BaseServices = Layer.mergeAll(ChainState.Live, EventBus.Live, Persistence.Live, Keys.Live);

const ServicesLive = Mempool.Live.pipe(Layer.provideMerge(BaseServices));

const program = Effect.gen(function* () {
  const persistence = yield* Persistence;
  const chainState = yield* ChainState;
  const keys = yield* Keys;

  const blocks = yield* persistence.loadChain;
  if (blocks.length === 0) {
    const genesis = createGenesisBlock(keys);
    yield* persistence.appendBlock(genesis);
    yield* chainState.applyBlock(genesis);
    yield* Effect.logInfo("Created genesis block");
  } else {
    for (const block of blocks) yield* chainState.applyBlock(block);
    yield* Effect.logInfo(`Replayed ${blocks.length} blocks`);
  }

  // Block producer — runs every 5 seconds
  yield* produceBlock.pipe(
    Effect.tap(() => Effect.logDebug("Block production tick")),
    Effect.catchAll((e) => Effect.logError(`Block production error: ${e}`)),
    Effect.repeat(Schedule.fixed("5 seconds")),
    Effect.forkScoped,
  );
  yield* Effect.logInfo("Block producer started");

  const router = yield* makeRouter;
  yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
  yield* Effect.logInfo(`Node server listening on port ${NODE_PORT}`);
  yield* Effect.never;
});

const MainLive = ServicesLive.pipe(Layer.provideMerge(HttpLive));

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(MainLive)));
