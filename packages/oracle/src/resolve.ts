import { Effect } from "effect";
import { NflAdapter } from "./adapters/nfl.js";
import { MlbAdapter } from "./adapters/mlb.js";
import { GolfAdapter } from "./adapters/golf.js";
import { WebClient } from "./web-client.js";
import { OracleError } from "./errors.js";
import { extractEspnId, extractGolfIds } from "./market-ids.js";
import type { Game } from "./types.js";

function determineOutcome(game: Game): "A" | "B" | undefined {
  if (game.status !== "completed" || !game.winner) return undefined;
  return game.winner === "away" ? "A" : "B";
}

const resolveTeamSports = (sport: "nfl" | "mlb", getGames: Effect.Effect<Game[], OracleError>) =>
  Effect.gen(function* () {
    const web = yield* WebClient;
    const allMarkets = yield* web.getMarkets;
    const openMarkets = allMarkets.filter(
      (m) => m.sport === sport && (m.status === "open" || m.status === "closed"),
    );

    if (openMarkets.length === 0) return { resolved: 0, skipped: 0 };

    const games = yield* getGames;
    const gamesByEspnId = new Map(games.map((g) => [g.espnId, g]));

    let resolved = 0;
    let skipped = 0;

    for (const market of openMarkets) {
      const espnId = extractEspnId(market.id);
      if (!espnId) {
        skipped++;
        continue;
      }

      const game = gamesByEspnId.get(espnId);
      if (!game) {
        skipped++;
        continue;
      }

      const outcome = determineOutcome(game);
      if (!outcome) {
        skipped++;
        continue;
      }

      yield* web.resolveMarket(market.id, outcome);
      resolved++;
    }

    return { resolved, skipped };
  });

const resolveGolf = Effect.gen(function* () {
  const web = yield* WebClient;
  const golf = yield* GolfAdapter;

  const allMarkets = yield* web.getMarkets;
  const openGolfMarkets = allMarkets.filter(
    (m) => m.sport === "golf-pga" && (m.status === "open" || m.status === "closed"),
  );

  if (openGolfMarkets.length === 0) return { resolved: 0, skipped: 0 };

  const tournaments = yield* golf.getUpcomingTournaments;
  const completedTournaments = tournaments.filter((t) => t.status === "completed");

  let resolved = 0;
  let skipped = 0;

  for (const market of openGolfMarkets) {
    const ids = extractGolfIds(market.id);
    if (!ids) {
      skipped++;
      continue;
    }

    const tournament = completedTournaments.find((t) => t.espnId === ids.tournamentId);
    if (!tournament) {
      skipped++;
      continue;
    }

    const winner = tournament.competitors.find((c) => c.position === 1);
    if (!winner) {
      skipped++;
      continue;
    }
    const outcome: "A" | "B" = winner.espnId === ids.competitorId ? "A" : "B";

    yield* web.resolveMarket(market.id, outcome);
    resolved++;
  }

  return { resolved, skipped };
});

export const resolveAll = Effect.gen(function* () {
  const nfl = yield* NflAdapter;
  const mlb = yield* MlbAdapter;

  const [nflResult, mlbResult, golfResult] = yield* Effect.all([
    resolveTeamSports("nfl", nfl.getUpcomingGames).pipe(
      Effect.catchAll((e) => {
        return Effect.logError(`NFL resolve failed: ${e}`).pipe(
          Effect.as({ resolved: 0, skipped: 0 }),
        );
      }),
    ),
    resolveTeamSports("mlb", mlb.getUpcomingGames).pipe(
      Effect.catchAll((e) => {
        return Effect.logError(`MLB resolve failed: ${e}`).pipe(
          Effect.as({ resolved: 0, skipped: 0 }),
        );
      }),
    ),
    resolveGolf.pipe(
      Effect.catchAll((e) => {
        return Effect.logError(`Golf resolve failed: ${e}`).pipe(
          Effect.as({ resolved: 0, skipped: 0 }),
        );
      }),
    ),
  ]);

  const total = {
    resolved: nflResult.resolved + mlbResult.resolved + golfResult.resolved,
    skipped: nflResult.skipped + mlbResult.skipped + golfResult.skipped,
  };

  yield* Effect.logInfo(
    `Resolve complete — NFL: ${nflResult.resolved}, MLB: ${mlbResult.resolved}, Golf: ${golfResult.resolved} (${total.skipped} skipped)`,
  );

  return total;
});
