import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { MlbAdapter } from "../src/adapters/mlb.js";
import { NodeClient, type CreateMarketParams } from "../src/node-client.js";
import { mlbIngest } from "../src/mlb-ingest.js";
import type { Game } from "../src/types.js";
import type { Market, AMMPool } from "@wpm/shared";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    espnId: "401581121",
    name: "New York Yankees vs Los Angeles Dodgers",
    homeTeam: "Los Angeles Dodgers",
    awayTeam: "New York Yankees",
    homeLogo: "https://a.espn.com/i/teamlogos/mlb/500/lad.png",
    awayLogo: "https://a.espn.com/i/teamlogos/mlb/500/nyy.png",
    startTime: "2026-04-01T20:10Z",
    status: "scheduled",
    ...overrides,
  };
}

function makeMarketEntry(id: string, name: string): { market: Market; pool: AMMPool } {
  return {
    market: {
      id,
      name,
      outcomes: ["Away", "Home"],
      closesAt: "2026-04-01T20:10Z",
      status: "open",
    },
    pool: { marketId: id, sharesA: 1000, sharesB: 1000, k: 1_000_000, liquidity: 1000 },
  };
}

function makeFakeMlb(games: Game[]) {
  return Layer.succeed(MlbAdapter, {
    getUpcomingGames: Effect.succeed(games),
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

describe("MLB Ingest", () => {
  it.effect("creates markets from ESPN schedule", () =>
    Effect.gen(function* () {
      const result = yield* mlbIngest;
      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(3);
      expect(markets.map((m) => m.market.id)).toEqual(["mlb-100", "mlb-200", "mlb-300"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeMlb([
            makeGame({ espnId: "100", name: "Yankees vs Dodgers" }),
            makeGame({ espnId: "200", name: "Red Sox vs Cubs" }),
            makeGame({ espnId: "300", name: "Mets vs Braves" }),
          ]),
          makeFakeNode(),
        ),
      ),
    ),
  );

  it.effect("is idempotent: no duplicates on re-run", () =>
    Effect.gen(function* () {
      const r1 = yield* mlbIngest;
      expect(r1.created).toBe(3);

      const r2 = yield* mlbIngest;
      expect(r2.created).toBe(0);
      expect(r2.skipped).toBe(3);

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(3);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeMlb([
            makeGame({ espnId: "100" }),
            makeGame({ espnId: "200" }),
            makeGame({ espnId: "300" }),
          ]),
          makeFakeNode(),
        ),
      ),
    ),
  );

  it.effect("filters to scheduled games only", () =>
    Effect.gen(function* () {
      const result = yield* mlbIngest;
      expect(result.created).toBe(2);

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(2);
      expect(markets.map((m) => m.market.id)).toEqual(["mlb-100", "mlb-200"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeMlb([
            makeGame({ espnId: "100", status: "scheduled" }),
            makeGame({ espnId: "200", status: "scheduled" }),
            makeGame({ espnId: "300", status: "in_progress" }),
            makeGame({ espnId: "400", status: "completed" }),
            makeGame({ espnId: "500", status: "postponed" }),
          ]),
          makeFakeNode(),
        ),
      ),
    ),
  );

  it.effect("seeds market with odds-derived probability", () =>
    Effect.gen(function* () {
      const created: CreateMarketParams[] = [];
      const result = yield* mlbIngest;
      expect(result.created).toBe(1);

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(1);
      expect(markets[0].market.id).toBe("mlb-100");
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeMlb([
            makeGame({
              espnId: "100",
              awayMoneyline: 150,
              homeMoneyline: -180,
            }),
          ]),
          Layer.effect(
            NodeClient,
            Effect.gen(function* () {
              const marketsRef = yield* Ref.make<Array<{ market: Market; pool: AMMPool }>>([]);
              const paramsRef = yield* Ref.make<CreateMarketParams[]>([]);
              return {
                getMarkets: Ref.get(marketsRef),
                createMarket: (params: CreateMarketParams) =>
                  Effect.gen(function* () {
                    yield* Ref.update(paramsRef, (p) => [...p, params]);
                    yield* Ref.update(marketsRef, (markets) => [
                      ...markets,
                      makeMarketEntry(params.id, params.name),
                    ]);
                    // Verify initialProbabilityA was set from odds
                    expect(params.initialProbabilityA).toBeDefined();
                    expect(params.initialProbabilityA).toBeGreaterThan(0);
                    expect(params.initialProbabilityA).toBeLessThan(1);
                  }).pipe(Effect.asVoid),
                health: Effect.succeed(true as boolean),
              };
            }),
          ),
        ),
      ),
    ),
  );
});
