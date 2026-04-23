import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { MlbAdapter } from "../src/adapters/mlb.js";
import { WebClient } from "../src/web-client.js";
import { mlbIngest } from "../src/mlb-ingest.js";
import type { Game } from "../src/types.js";
import type { CreateMarketRequest, OracleMarket } from "@wpm/shared";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    espnId: "401581121",
    name: "New York Yankees vs Los Angeles Dodgers",
    homeTeam: "Los Angeles Dodgers",
    awayTeam: "New York Yankees",
    homeLogo: "https://a.espn.com/i/teamlogos/mlb/500/lad.png",
    awayLogo: "https://a.espn.com/i/teamlogos/mlb/500/nyy.png",
    leagueLogo: "https://a.espn.com/i/teamlogos/leagues/500/mlb.png",
    startTime: "2026-04-01T20:10Z",
    status: "scheduled",
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
    closesAt: new Date(params.closesAt).getTime(),
    status: "open",
  };
}

function makeFakeMlb(games: Game[]) {
  return Layer.succeed(MlbAdapter, {
    getUpcomingGames: Effect.succeed(games),
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

describe("MLB Ingest", () => {
  it.effect("creates markets from ESPN schedule", () =>
    Effect.gen(function* () {
      const result = yield* mlbIngest;
      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);

      const web = yield* WebClient;
      const markets = yield* web.getMarkets;
      expect(markets).toHaveLength(3);
      expect(markets.map((m) => m.id)).toEqual(["mlb-100", "mlb-200", "mlb-300"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeMlb([
            makeGame({ espnId: "100", name: "Yankees vs Dodgers" }),
            makeGame({ espnId: "200", name: "Red Sox vs Cubs" }),
            makeGame({ espnId: "300", name: "Mets vs Braves" }),
          ]),
          makeFakeWeb(),
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

      const web = yield* WebClient;
      const markets = yield* web.getMarkets;
      expect(markets).toHaveLength(3);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeMlb([
            makeGame({ espnId: "100" }),
            makeGame({ espnId: "200" }),
            makeGame({ espnId: "300" }),
          ]),
          makeFakeWeb(),
        ),
      ),
    ),
  );

  it.effect("filters to scheduled games only", () =>
    Effect.gen(function* () {
      const result = yield* mlbIngest;
      expect(result.created).toBe(2);

      const web = yield* WebClient;
      const markets = yield* web.getMarkets;
      expect(markets).toHaveLength(2);
      expect(markets.map((m) => m.id)).toEqual(["mlb-100", "mlb-200"]);
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
          makeFakeWeb(),
        ),
      ),
    ),
  );

  it.effect("seeds market with odds-derived probability", () => {
    const captured: CreateMarketRequest[] = [];
    return Effect.gen(function* () {
      const result = yield* mlbIngest;
      expect(result.created).toBe(1);
      expect(captured).toHaveLength(1);
      expect(captured[0].initialProbabilityA).toBeDefined();
      expect(captured[0].initialProbabilityA!).toBeGreaterThan(0);
      expect(captured[0].initialProbabilityA!).toBeLessThan(1);
      expect(captured[0].reserveA).toBeGreaterThan(0);
      expect(captured[0].reserveB).toBeGreaterThan(0);
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
          makeFakeWeb({ onCreateMarket: (p) => captured.push(p) }),
        ),
      ),
    );
  });
});
