import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { GolfAdapter, type Tournament } from "../src/adapters/golf.js";
import { NodeClient, type CreateMarketParams } from "../src/node-client.js";
import { golfIngest, scoreToProbabilities } from "../src/golf-ingest.js";
import { parseScore } from "../src/adapters/golf.js";
import type { Market, AMMPool } from "@wpm/shared";

function makeTournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    espnId: "401580337",
    name: "The Masters",
    startTime: "2026-04-10T13:00Z",
    status: "in_progress",
    round: 4,
    competitors: [
      { espnId: "9780", name: "Scottie Scheffler", position: 1, score: "-11" },
      { espnId: "3702", name: "Rory McIlroy", position: 2, score: "-8" },
      { espnId: "10046", name: "Jon Rahm", position: 3, score: "-5" },
    ],
    leagueLogo: "https://a.espn.com/i/teamlogos/leagues/500/pga.png",
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
      const paramsRef = yield* Ref.make<CreateMarketParams[]>([]);
      return {
        getMarkets: Ref.get(marketsRef),
        createMarket: (params: CreateMarketParams) =>
          Effect.all([
            Ref.update(marketsRef, (markets) => [
              ...markets,
              makeMarketEntry(params.id, params.name),
            ]),
            Ref.update(paramsRef, (all) => [...all, params]),
          ]).pipe(Effect.asVoid),
        health: Effect.succeed(true as boolean),
        /** Exposed for test assertions — not part of NodeClient interface. */
        _getCreateParams: Ref.get(paramsRef),
      };
    }),
  );
}

describe("Golf Ingest", () => {
  it.effect("creates binary markets only for final-round tournaments", () =>
    Effect.gen(function* () {
      const result = yield* golfIngest;

      // 2 golfers from final-round Masters + 2 from final-round Open = 4
      // Scheduled, early-round, and completed tournaments are filtered out
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
              status: "in_progress",
              round: 4,
              competitors: [
                { espnId: "1", name: "Golfer A", position: 1, score: "-10" },
                { espnId: "2", name: "Golfer B", position: 2, score: "-7" },
              ],
            }),
            makeTournament({
              espnId: "200",
              name: "The Open",
              status: "in_progress",
              round: 4,
              competitors: [
                { espnId: "3", name: "Golfer C", position: 1, score: "-5" },
                { espnId: "4", name: "Golfer D", position: 2, score: "-3" },
              ],
            }),
            makeTournament({ espnId: "300", status: "scheduled", round: 0 }),
            makeTournament({ espnId: "400", status: "in_progress", round: 2 }),
            makeTournament({ espnId: "500", status: "completed", round: 4 }),
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
        Layer.merge(makeFakeGolf([makeTournament({ competitors: [] })]), makeFakeNode()),
      ),
    ),
  );

  it.effect("passes initialProbabilityA to createMarket", () =>
    Effect.gen(function* () {
      yield* golfIngest;

      const node = yield* NodeClient;
      // Access the captured params via the extended fake
      const params: CreateMarketParams[] = yield* (node as any)._getCreateParams;

      expect(params).toHaveLength(3);

      // All should have initialProbabilityA defined
      for (const p of params) {
        expect(p.initialProbabilityA).toBeDefined();
        expect(p.initialProbabilityA).toBeGreaterThan(0);
        expect(p.initialProbabilityA).toBeLessThan(1);
      }

      // Leader should have highest probability
      const leaderProb = params[0].initialProbabilityA!;
      const trailerProb = params[2].initialProbabilityA!;
      expect(leaderProb).toBeGreaterThan(trailerProb);

      // Probabilities should sum to ≈ 1.0
      const sum = params.reduce((s, p) => s + p.initialProbabilityA!, 0);
      expect(sum).toBeCloseTo(1.0, 5);
    }).pipe(Effect.provide(Layer.merge(makeFakeGolf([makeTournament()]), makeFakeNode()))),
  );
});

describe("scoreToProbabilities", () => {
  it("leader gets highest probability", () => {
    const probs = scoreToProbabilities([
      { espnId: "1", name: "Leader", position: 1, score: "-11" },
      { espnId: "2", name: "Middle", position: 2, score: "-8" },
      { espnId: "3", name: "Trailer", position: 3, score: "-5" },
    ]);

    expect(probs.get("1")!).toBeGreaterThan(probs.get("2")!);
    expect(probs.get("2")!).toBeGreaterThan(probs.get("3")!);
  });

  it("tied scores get equal probabilities", () => {
    const probs = scoreToProbabilities([
      { espnId: "1", name: "A", position: 1, score: "-8" },
      { espnId: "2", name: "B", position: 2, score: "-8" },
    ]);

    expect(probs.get("1")).toBeCloseTo(probs.get("2")!, 10);
  });

  it("probabilities sum to 1.0", () => {
    const probs = scoreToProbabilities([
      { espnId: "1", name: "A", position: 1, score: "-11" },
      { espnId: "2", name: "B", position: 2, score: "-8" },
      { espnId: "3", name: "C", position: 3, score: "-5" },
      { espnId: "4", name: "D", position: 4, score: "E" },
      { espnId: "5", name: "E", position: 5, score: "+3" },
    ]);

    const sum = [...probs.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("returns empty map for empty competitors", () => {
    expect(scoreToProbabilities([]).size).toBe(0);
  });

  it("handles single competitor", () => {
    const probs = scoreToProbabilities([{ espnId: "1", name: "Solo", position: 1, score: "-5" }]);

    expect(probs.get("1")).toBeCloseTo(1.0, 10);
  });
});

describe("parseScore", () => {
  it("parses under par", () => {
    expect(parseScore("-11")).toBe(-11);
    expect(parseScore("-1")).toBe(-1);
  });

  it("parses over par", () => {
    expect(parseScore("+3")).toBe(3);
    expect(parseScore("+12")).toBe(12);
  });

  it("parses even par", () => {
    expect(parseScore("E")).toBe(0);
  });

  it("returns NaN for unparseable", () => {
    expect(parseScore("--")).toBeNaN();
    expect(parseScore("WD")).toBeNaN();
    expect(parseScore("")).toBeNaN();
  });
});
