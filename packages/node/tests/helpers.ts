import { Layer, Effect } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpServer } from "@effect/platform";
import { generateKeyPair } from "@wpm/shared";
import { ChainState } from "../src/chain-state.js";
import { EventBus } from "../src/event-bus.js";
import { Persistence } from "../src/persistence.js";
import { Mempool } from "../src/mempool.js";
import { Keys } from "../src/keys.js";
import { createGenesisBlock } from "../src/genesis.js";
import { makeRouter } from "../src/router.js";

export const testKeys = {
  node: generateKeyPair(),
  user: generateKeyPair(),
  user2: generateKeyPair(),
};

const KeysTest = Layer.succeed(Keys, {
  poaPublicKey: testKeys.node.publicKey,
  poaPrivateKey: testKeys.node.privateKey,
});

const BaseServices = Layer.mergeAll(ChainState.Live, EventBus.Live, Persistence.Test, KeysTest);

const NodeTestServices = Mempool.Live.pipe(Layer.provideMerge(BaseServices));

export const NodeTestLayer = NodeHttpServer.layerTest.pipe(Layer.provideMerge(NodeTestServices));

export const serveNodeForTest = Effect.gen(function* () {
  const chainState = yield* ChainState;
  const keys = yield* Keys;
  const genesis = createGenesisBlock(keys);
  yield* chainState.applyBlock(genesis);
  const router = yield* makeRouter;
  yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
});

export { produceBlock } from "../src/producer.js";
