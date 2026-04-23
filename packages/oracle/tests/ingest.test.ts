import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { NflAdapter } from "../src/adapters/nfl.js";
import { WebClient } from "../src/web-client.js";
import { ingest } from "../src/ingest.js";
import type { Game } from "../src/types.js";
import type { CreateMarketRequest, OracleMarket } from "@wpm/shared";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    espnId: "401547417",
    name: "Kansas City Chiefs vs Philadelphia Eagles",
    homeTeam: "Philadelphia Eagles",
    awayTeam: "Kansas City Chiefs",
    homeLogo: "https://a.espn.com/i/teamlogos/nfl/500/phi.png",
    awayLogo: "https://a.espn.com/i/teamlogos/nfl/500/kc.png",
    leagueLogo: "https://a.espn.com/i/teamlogos/leagues/500/nfl.png",
    startTime: "2026-02-08T23:30Z",
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

function makeFakeNfl(games: Game[]) {
  return Layer.succeed(NflAdapter, {
    getUpcomingGames: Effect.succeed(games),
  });
}

function makeFakeWeb() {
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

describe("Ingest", () => {
  it.effect("creates markets from ESPN schedule", () =>
    Effect.gen(function* () {
      const result = yield* ingest;
      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);

      const web = yield* WebClient;
      const markets = yield* web.getMarkets;
      expect(markets).toHaveLength(3);
      expect(markets.map((m) => m.id)).toEqual(["nfl-100", "nfl-200", "nfl-300"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeNfl([
            makeGame({ espnId: "100", name: "Chiefs vs Eagles" }),
            makeGame({ espnId: "200", name: "Cowboys vs Giants" }),
            makeGame({ espnId: "300", name: "Bills vs Dolphins" }),
          ]),
          makeFakeWeb(),
        ),
      ),
    ),
  );

  it.effect("is idempotent: no duplicates on re-run", () =>
    Effect.gen(function* () {
      const r1 = yield* ingest;
      expect(r1.created).toBe(3);

      const r2 = yield* ingest;
      expect(r2.created).toBe(0);
      expect(r2.skipped).toBe(3);

      const web = yield* WebClient;
      const markets = yield* web.getMarkets;
      expect(markets).toHaveLength(3);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeNfl([
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
      const result = yield* ingest;
      expect(result.created).toBe(2);

      const web = yield* WebClient;
      const markets = yield* web.getMarkets;
      expect(markets).toHaveLength(2);
      expect(markets.map((m) => m.id)).toEqual(["nfl-100", "nfl-200"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeNfl([
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
});
