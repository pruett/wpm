import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { GolfAdapter, type Tournament } from "../src/adapters/golf.js";
import { NodeClient, type CreateMarketParams } from "../src/node-client.js";
import { golfIngest } from "../src/golf-ingest.js";
import type { Market, AMMPool } from "@wpm/shared";

function makeTournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    espnId: "401580337",
    name: "The Masters",
    startTime: "2026-04-10T13:00Z",
    status: "scheduled",
    competitors: [
      { espnId: "9780", name: "Scottie Scheffler" },
      { espnId: "3702", name: "Rory McIlroy" },
      { espnId: "10046", name: "Jon Rahm" },
    ],
    ...overrides,
  };
}

function makeMarketEntry(id: string, name: string): { market: Market; pool: AMMPool } {
  return {
    market: {
      id,
      name,
      outcomes: ["Yes", "No"],
      closesAt: "2026-04-10T13:00Z",
      status: "open",
    },
    pool: { marketId: id, sharesA: 100, sharesB: 100, k: 10_000, liquidity: 100 },
  };
}

function makeFakeGolf(tournaments: Tournament[]) {
  return Layer.succeed(GolfAdapter, {
    getUpcomingTournaments: Effect.succeed(tournaments),
  });
}

function makeFakeNode(initialMarkets: Array<{ market: Market; pool: AMMPool }> = []) {
  return Layer.effect(
    NodeClient,
    Effect.gen(function* () {
      const marketsRef = yield* Ref.make(initialMarkets);
      return {
        getMarkets: Ref.get(marketsRef),
        createMarket: (params: CreateMarketParams) =>
          Ref.update(marketsRef, (markets) => [
            ...markets,
            makeMarketEntry(params.id, params.name),
          ]).pipe(Effect.asVoid),
        health: Effect.succeed(true as boolean),
      };
    }),
  );
}

describe("Golf Ingest", () => {
  it.effect("creates binary markets for scheduled tournaments", () =>
    Effect.gen(function* () {
      const result = yield* golfIngest;

      // 2 golfers from scheduled Masters + 2 from scheduled Open = 4
      // In-progress and completed tournaments are filtered out
      expect(result.created).toBe(4);
      expect(result.skipped).toBe(0);

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(4);

      // Correct market IDs across both tournaments
      expect(markets.map((m) => m.market.id)).toEqual([
        "golf-pga-100-1",
        "golf-pga-100-2",
        "golf-pga-200-3",
        "golf-pga-200-4",
      ]);

      // Market names follow "Golfer to win Tournament" pattern
      expect(markets[0].market.name).toBe("Golfer A to win The Masters");
      expect(markets[2].market.name).toBe("Golfer C to win The Open");

      // All golf markets are binary Yes/No
      for (const m of markets) {
        expect(m.market.outcomes).toEqual(["Yes", "No"]);
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeGolf([
            makeTournament({
              espnId: "100",
              name: "The Masters",
              status: "scheduled",
              competitors: [
                { espnId: "1", name: "Golfer A" },
                { espnId: "2", name: "Golfer B" },
              ],
            }),
            makeTournament({
              espnId: "200",
              name: "The Open",
              status: "scheduled",
              competitors: [
                { espnId: "3", name: "Golfer C" },
                { espnId: "4", name: "Golfer D" },
              ],
            }),
            makeTournament({ espnId: "300", status: "in_progress" }),
            makeTournament({ espnId: "400", status: "completed" }),
          ]),
          makeFakeNode(),
        ),
      ),
    ),
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      const r1 = yield* golfIngest;
      expect(r1.created).toBe(3);

      const r2 = yield* golfIngest;
      expect(r2.created).toBe(0);
      expect(r2.skipped).toBe(3);

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(3);
    }).pipe(Effect.provide(Layer.merge(makeFakeGolf([makeTournament()]), makeFakeNode()))),
  );

  it.effect("handles empty field gracefully", () =>
    Effect.gen(function* () {
      const result = yield* golfIngest;
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeGolf([makeTournament({ competitors: [] })]),
          makeFakeNode(),
        ),
      ),
    ),
  );
});
