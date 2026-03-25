import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeClient } from "../src/node-client.js";
import { UserKeys } from "../src/user-keys.js";
import { makeRouter } from "../src/router.js";
import { calculateBuy } from "@wpm/shared";
import { Stream } from "effect";

function makeStatefulMock() {
  const basePool = { marketId: "m1", sharesA: 1000, sharesB: 1000, k: 1_000_000, liquidity: 1000 };
  let pool = { ...basePool };
  const market = {
    id: "m1",
    name: "Chiefs vs Eagles",
    outcomes: ["Chiefs", "Eagles"] as [string, string],
    closesAt: "2026-04-01T00:00:00Z",
    status: "open" as const,
  };
  return Layer.succeed(NodeClient, {
    submitTransaction: (tx) =>
      Effect.sync(() => {
        if (tx.type === "PlaceBet") {
          pool = calculateBuy(pool, tx.outcome, tx.amount).newPool;
        }
      }),
    distribute: () => Effect.void,
    getMarkets: Effect.sync(() => [{ market, pool }]),
    getMarket: () => Effect.sync(() => ({ market, pool })),
    getBalance: () => Effect.succeed(100_000),
    health: Effect.succeed(true),
    eventStream: Effect.succeed(Stream.empty),
  });
}

function makeResolvedMock() {
  const pool = { marketId: "m1", sharesA: 900, sharesB: 1100, k: 1_000_000, liquidity: 1100 };
  const market = {
    id: "m1",
    name: "Chiefs vs Eagles",
    outcomes: ["Chiefs", "Eagles"] as [string, string],
    closesAt: "2026-04-01T00:00:00Z",
    status: "resolved" as const,
    result: "A" as const,
  };
  return Layer.succeed(NodeClient, {
    submitTransaction: () => Effect.void,
    distribute: () => Effect.void,
    getMarkets: Effect.succeed([{ market, pool }]),
    getMarket: () => Effect.succeed({ market, pool }),
    getBalance: () => Effect.succeed(100_000),
    health: Effect.succeed(true),
    eventStream: Effect.succeed(Stream.empty),
  });
}

describe("API", () => {
  it.scoped("enrichment and bet flow: prices, multipliers, bet, odds shift", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      // -- GET /api/markets: enrichment with prices and multipliers --
      const res1 = yield* client.get("/api/markets");
      const markets1 = (yield* res1.json) as any[];
      expect(markets1).toHaveLength(1);
      const m1 = markets1[0];
      expect(m1.priceA).toBeCloseTo(0.5);
      expect(m1.priceB).toBeCloseTo(0.5);
      expect(m1.multiplierA).toBeCloseTo(2.0);
      expect(m1.multiplierB).toBeCloseTo(2.0);
      expect(m1.pool).toBeDefined();

      // Invariant: multiplier = 1/price
      expect(m1.multiplierA).toBeCloseTo(1 / m1.priceA, 6);
      expect(m1.multiplierB).toBeCloseTo(1 / m1.priceB, 6);

      // -- POST /api/bet: place bet on outcome A --
      const betRes = yield* HttpClientRequest.post("/api/bet").pipe(
        HttpClientRequest.bodyUnsafeJson({ marketId: "m1", outcome: "A", amount: 100 }),
        client.execute,
      );
      expect(betRes.status).toBe(200);
      const betBody = (yield* betRes.json) as { success: boolean };
      expect(betBody.success).toBe(true);

      // -- GET /api/markets: odds shifted after bet --
      const res2 = yield* client.get("/api/markets");
      const m2 = ((yield* res2.json) as any[])[0];
      expect(m2.priceA).toBeGreaterThan(0.5);
      expect(m2.priceB).toBeLessThan(0.5);

      // Invariant still holds after the shift
      expect(m2.multiplierA).toBeCloseTo(1 / m2.priceA, 6);
      expect(m2.multiplierB).toBeCloseTo(1 / m2.priceB, 6);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(makeStatefulMock(), UserKeys.Live).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ),
    ),
  );

  it.scoped("resolved market enrichment: terminal prices 1.0/0.0", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const res = yield* client.get("/api/markets");
      const markets = (yield* res.json) as any[];
      expect(markets).toHaveLength(1);
      const m = markets[0];
      expect(m.status).toBe("resolved");
      expect(m.result).toBe("A");
      expect(m.priceA).toBe(1.0);
      expect(m.priceB).toBe(0.0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(makeResolvedMock(), UserKeys.Live).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ),
    ),
  );
});
