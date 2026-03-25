import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeClient } from "../src/node-client.js";
import { UserKeys } from "../src/user-keys.js";
import { makeRouter } from "../src/router.js";

const MockNodeClientWithSSE = Layer.succeed(NodeClient, {
  submitTransaction: () => Effect.void,
  distribute: () => Effect.void,
  getMarkets: Effect.succeed([]),
  getMarket: () => Effect.succeed(null),
  getBalance: () => Effect.succeed(0),
  health: Effect.succeed(true),
  eventStream: Effect.succeed(
    Stream.make({
      type: "trade:executed" as const,
      marketId: "m1",
      pool: { marketId: "m1", sharesA: 909, sharesB: 1100, k: 999_900, liquidity: 1100 },
    }),
  ),
});

const SSETestLayer = Layer.mergeAll(MockNodeClientWithSSE, UserKeys.Live).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

describe("API SSE Relay", () => {
  it.scoped("transforms trade:executed into price:update with enriched fields", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const res = yield* client.get("/events/stream");
      const text = yield* res.text;

      // Parse SSE events from response text
      const events = text
        .split("\n\n")
        .filter((block) => block.includes("data: "))
        .map((block) => {
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "))!;
          return JSON.parse(dataLine.slice(6));
        });

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.type).toBe("price:update");
      expect(event.marketId).toBe("m1");
      expect(event.priceA).toBeGreaterThan(0.5);
      expect(event.multiplierA).toBeCloseTo(1 / event.priceA, 4);
      expect(event.multiplierB).toBeCloseTo(1 / event.priceB, 4);
    }).pipe(Effect.provide(SSETestLayer)),
  );
});
