import { Effect } from "effect";
import { initializePool, type CreateMarketRequest } from "@wpm/shared";
import { MlbAdapter } from "./adapters/mlb.js";
import { moneylineToFairProbability } from "./adapters/nfl.js";
import { WebClient } from "./web-client.js";
import { OracleError } from "./errors.js";

const SEED_AMOUNT = 1000;

export const mlbIngest = Effect.gen(function* () {
  const mlb = yield* MlbAdapter;
  const web = yield* WebClient;

  const games = yield* mlb.getUpcomingGames;
  const scheduled = games.filter((g) => g.status === "scheduled");

  let created = 0;
  let skipped = 0;

  for (const game of scheduled) {
    const marketId = `mlb-${game.espnId}`;

    let initialProbabilityA: number | undefined;
    if (game.awayMoneyline !== undefined && game.homeMoneyline !== undefined) {
      const { awayProb } = moneylineToFairProbability(game.awayMoneyline, game.homeMoneyline);
      initialProbabilityA = awayProb;
    }

    const pool = initializePool(marketId, SEED_AMOUNT, initialProbabilityA);

    const params: CreateMarketRequest = {
      id: marketId,
      sport: "mlb",
      name: game.name,
      teamA: game.awayTeam,
      teamB: game.homeTeam,
      logoA: game.awayLogo || undefined,
      logoB: game.homeLogo || undefined,
      leagueLogo: game.leagueLogo || undefined,
      startTime: game.startTime,
      bettingClosesAt: game.startTime,
      seedAmount: SEED_AMOUNT,
      initialProbabilityA,
      reserveA: pool.sharesA,
      reserveB: pool.sharesB,
      wpmReserve: pool.liquidity,
    };

    const result = yield* web.createMarket(params);
    if (result.created) created++;
    else skipped++;
  }

  yield* Effect.logInfo(`MLB ingest complete: ${created} created, ${skipped} skipped`);
  return { created, skipped };
}).pipe(
  Effect.mapError((e) =>
    e instanceof OracleError ? e : new OracleError({ message: `MLB ingest failed: ${e}` }),
  ),
);
