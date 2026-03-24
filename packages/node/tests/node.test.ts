import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Fiber, Stream, Chunk } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeTestLayer, serveNodeForTest, testKeys, produceBlock } from "./helpers.js";
import { sign, serializeTx, calculatePrices, addressOf } from "@wpm/shared";
import { EventBus } from "../src/event-bus.js";

describe("Node", () => {
  it.scoped("full flow: genesis → fund → market → bet → SSE", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const eventBus = yield* EventBus;

      // -- Genesis: treasury holds initial supply --
      const treasuryRes = yield* client.get(
        `/internal/balance/${addressOf(testKeys.node.publicKey)}`,
      );
      const { balance: treasuryBalance } = (yield* treasuryRes.json) as { balance: number };
      expect(treasuryBalance).toBe(10_000_000);

      // -- Fund user with 100,000 WPM --
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user.publicKey,
          amount: 100_000,
          reason: "fund_user",
        }),
        client.execute,
      );
      yield* produceBlock;

      // -- Create market with 1000 WPM seed --
      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-1",
          name: "Chiefs vs Eagles",
          outcomes: ["Chiefs", "Eagles"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      // Verify market queryable with 50/50 pool
      const mktsRes = yield* client.get("/internal/markets");
      const markets = (yield* mktsRes.json) as Array<{ market: any; pool: any }>;
      expect(markets).toHaveLength(1);
      expect(markets[0].market.name).toBe("Chiefs vs Eagles");
      expect(markets[0].pool.sharesA).toBe(1000);
      expect(markets[0].pool.sharesB).toBe(1000);

      // -- Subscribe to EventBus directly before placing bet --
      const sseStream = yield* eventBus.subscribe;
      const eventFiber = yield* sseStream.pipe(Stream.take(1), Stream.runCollect, Effect.fork);
      yield* Effect.yieldNow();

      // -- Place bet: 100 WPM on outcome A --
      const betTx = {
        type: "PlaceBet" as const,
        marketId: "market-1",
        outcome: "A" as const,
        amount: 100,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      betTx.signature = sign(serializeTx(betTx), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(betTx),
        client.execute,
      );
      yield* produceBlock;

      // -- Verify odds shifted --
      const mktRes = yield* client.get("/internal/market/market-1");
      const { pool } = (yield* mktRes.json) as { market: any; pool: any };
      const prices = calculatePrices(pool);
      expect(prices.priceA).toBeGreaterThan(0.5);
      expect(prices.priceB).toBeLessThan(0.5);

      // -- Verify balance decreased --
      const userBalRes = yield* client.get(
        `/internal/balance/${addressOf(testKeys.user.publicKey)}`,
      );
      const { balance: userBalance } = (yield* userBalRes.json) as { balance: number };
      expect(userBalance).toBe(100_000 - 100);

      // -- Verify position created --
      const posRes = yield* client.get(`/internal/positions/${addressOf(testKeys.user.publicKey)}`);
      const positions = (yield* posRes.json) as Array<{ outcome: string; shares: number }>;
      expect(positions).toHaveLength(1);
      expect(positions[0].outcome).toBe("A");
      expect(positions[0].shares).toBeGreaterThan(0);

      // -- Verify SSE: trade:executed event received --
      const events = Chunk.toArray(yield* Fiber.join(eventFiber));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("trade:executed");
      expect(events[0].marketId).toBe("market-1");
      expect(events[0].pool.sharesA).not.toBe(events[0].pool.sharesB);
    }).pipe(Effect.provide(NodeTestLayer)),
  );
});
