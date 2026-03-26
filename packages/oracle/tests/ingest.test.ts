import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { NflAdapter } from "../src/adapters/nfl.js";
import { NodeClient, type CreateMarketParams } from "../src/node-client.js";
import { ingest } from "../src/ingest.js";
import type { Game } from "../src/types.js";
import type { Market, AMMPool } from "@wpm/shared";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    espnId: "401547417",
    name: "Kansas City Chiefs vs Philadelphia Eagles",
    homeTeam: "Philadelphia Eagles",
    awayTeam: "Kansas City Chiefs",
    startTime: "2026-02-08T23:30Z",
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
      closesAt: "2026-02-08T23:30Z",
      status: "open",
    },
    pool: { marketId: id, sharesA: 1000, sharesB: 1000, k: 1_000_000, liquidity: 1000 },
  };
}

function makeFakeNfl(games: Game[]) {
  return Layer.succeed(NflAdapter, {
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

describe("Ingest", () => {
  it.effect("creates markets from ESPN schedule", () =>
    Effect.gen(function* () {
      const result = yield* ingest;
      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(3);
      expect(markets.map((m) => m.market.id)).toEqual(["nfl-100", "nfl-200", "nfl-300"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeNfl([
            makeGame({ espnId: "100", name: "Chiefs vs Eagles" }),
            makeGame({ espnId: "200", name: "Cowboys vs Giants" }),
            makeGame({ espnId: "300", name: "Bills vs Dolphins" }),
          ]),
          makeFakeNode(),
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

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(3);
    }).pipe(
      Effect.provide(
        Layer.merge(
          makeFakeNfl([
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
      const result = yield* ingest;
      expect(result.created).toBe(2);

      const node = yield* NodeClient;
      const markets = yield* node.getMarkets;
      expect(markets).toHaveLength(2);
      expect(markets.map((m) => m.market.id)).toEqual(["nfl-100", "nfl-200"]);
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
          makeFakeNode(),
        ),
      ),
    ),
  );
});
