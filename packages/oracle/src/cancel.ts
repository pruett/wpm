import { Effect } from "effect";
import { NflAdapter } from "./adapters/nfl.js";
import { MlbAdapter } from "./adapters/mlb.js";
import { WebClient } from "./web-client.js";
import { OracleError } from "./errors.js";
import { extractEspnId } from "./market-ids.js";
import type { Game } from "./types.js";

const cancelPostponedGames = (sport: "nfl" | "mlb", getGames: Effect.Effect<Game[], OracleError>) =>
  Effect.gen(function* () {
    const web = yield* WebClient;
    const allMarkets = yield* web.getMarkets;
    const openMarkets = allMarkets.filter(
      (m) => m.sport === sport && (m.status === "open" || m.status === "closed"),
    );

    if (openMarkets.length === 0) return { cancelled: 0 };

    const games = yield* getGames;
    const gamesByEspnId = new Map(games.map((g) => [g.espnId, g]));

    let cancelled = 0;

    for (const market of openMarkets) {
      const espnId = extractEspnId(market.id);
      if (!espnId) continue;

      const game = gamesByEspnId.get(espnId);
      if (!game || game.status !== "postponed") continue;

      yield* web.cancelMarket(market.id, "postponed");
      cancelled++;
    }

    return { cancelled };
  });

export const cancelAll = Effect.gen(function* () {
  const nfl = yield* NflAdapter;
  const mlb = yield* MlbAdapter;

  const [nflResult, mlbResult] = yield* Effect.all([
    cancelPostponedGames("nfl", nfl.getUpcomingGames).pipe(
      Effect.catchAll((e) => {
        return Effect.logError(`NFL cancel failed: ${e}`).pipe(Effect.as({ cancelled: 0 }));
      }),
    ),
    cancelPostponedGames("mlb", mlb.getUpcomingGames).pipe(
      Effect.catchAll((e) => {
        return Effect.logError(`MLB cancel failed: ${e}`).pipe(Effect.as({ cancelled: 0 }));
      }),
    ),
  ]);

  const total = nflResult.cancelled + mlbResult.cancelled;
  if (total > 0) {
    yield* Effect.logInfo(
      `Cancel complete — NFL: ${nflResult.cancelled}, MLB: ${mlbResult.cancelled}`,
    );
  }

  return { cancelled: total };
});
