import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { GolfAdapter, type Tournament } from "../src/adapters/golf.js";
import { WebClient } from "../src/web-client.js";
import { golfIngest, scoreToProbabilities } from "../src/golf-ingest.js";
import { parseScore } from "../src/adapters/golf.js";
import type { CreateMarketRequest, OracleMarket } from "@wpm/shared";

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

function toOracleMarket(params: CreateMarketRequest): OracleMarket {
  return {
    id: params.id,
    sport: params.sport,
    name: params.name,
    teamA: params.teamA,
    teamB: params.teamB,
    startTime: new Date(params.startTime).getTime(),
    bettingClosesAt: new Date(params.bettingClosesAt).getTime(),
    status: "open",
  };
}

function makeFakeGolf(tournaments: Tournament[]) {
  return Layer.succeed(GolfAdapter, {
    getUpcomingTournaments: Effect.succeed(tournaments),
  });
}

function makeFakeWeb(opts?: { onCreateMarket?: (params: CreateMarketRequest) => void }) {
  return Layer.effect(
    WebClient,
    Effect.gen(function* () {
      const marketsRef = yield* Ref.make<OracleMarket[]>([]);
      return {
        health: Effect.succeed(true as boolean),
        getMarkets: Ref.get(marketsRef),
        createMarket: (params: CreateMarketRequest) =>
          Ref.get(marketsRef).pipe(
            Effect.flatMap((markets) => {
              opts?.onCreateMarket?.(params);
              if (markets.some((m) => m.id === params.id)) {
                return Effect.succeed({ created: false });
              }
              return Ref.update(marketsRef, (ms) => [...ms, toOracleMarket(params)]).pipe(
                Effect.as({ created: true }),
              );
            }),
          ),
        resolveMarket: () => Effect.void,
        cancelMarket: () => Effect.void,
      };
    }),
  );
}

describe("Golf Ingest", () => {
  it.effect("creates binary markets only for final-round tournaments", () =>
    Effect.gen(function* () {
      const result = yield* golfIngest;
      expect(result.created).toBe(4);
      expect(result.skipped).toBe(0);

      const web = yield* WebClient;
      const markets = yield* web.getMarkets;
      expect(markets).toHaveLength(4);

      expect(markets.map((m) => m.id)).toEqual([
        "golf-pga-100-1",
        "golf-pga-100-2",
        "golf-pga-200-3",
        "golf-pga-200-4",
      ]);

      expect(markets[0].name).toBe("Golfer A to win The Masters");
      expect(markets[2].name).toBe("Golfer C to win The Open");

      for (const m of markets) {
        expect(m.teamA).toBe("Yes");
        expect(m.teamB).toBe("No");
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
          makeFakeWeb(),
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

      const web = yield* WebClient;
      const markets = yield* web.getMarkets;
      expect(markets).toHaveLength(3);
    }).pipe(Effect.provide(Layer.merge(makeFakeGolf([makeTournament()]), makeFakeWeb()))),
  );

  it.effect("handles empty field gracefully", () =>
    Effect.gen(function* () {
      const result = yield* golfIngest;
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.merge(makeFakeGolf([makeTournament({ competitors: [] })]), makeFakeWeb()),
      ),
    ),
  );

  it.effect("passes initialProbabilityA to createMarket", () => {
    const captured: CreateMarketRequest[] = [];
    return Effect.gen(function* () {
      yield* golfIngest;

      expect(captured).toHaveLength(3);

      for (const p of captured) {
        expect(p.initialProbabilityA).toBeDefined();
        expect(p.initialProbabilityA!).toBeGreaterThan(0);
        expect(p.initialProbabilityA!).toBeLessThan(1);
        expect(p.reserveA).toBeGreaterThan(0);
        expect(p.reserveB).toBeGreaterThan(0);
      }

      const leaderProb = captured[0].initialProbabilityA!;
      const trailerProb = captured[2].initialProbabilityA!;
      expect(leaderProb).toBeGreaterThan(trailerProb);

      const sum = captured.reduce((s, p) => s + p.initialProbabilityA!, 0);
      expect(sum).toBeCloseTo(1.0, 5);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeGolf([makeTournament()]),
          makeFakeWeb({ onCreateMarket: (p) => captured.push(p) }),
        ),
      ),
    );
  });
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
