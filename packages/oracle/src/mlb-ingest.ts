import { Effect } from "effect";
import { MlbAdapter } from "./adapters/mlb.js";
import { moneylineToFairProbability } from "./adapters/nfl.js";
import { NodeClient } from "./node-client.js";
import { OracleError } from "./errors.js";

const SEED_AMOUNT = 1000;

export const mlbIngest = Effect.gen(function* () {
  const mlb = yield* MlbAdapter;
  const node = yield* NodeClient;

  const games = yield* mlb.getUpcomingGames;
  const scheduled = games.filter((g) => g.status === "scheduled");

  const existing = yield* node.getMarkets;
  const existingIds = new Set(existing.map((e) => e.market.id));

  let created = 0;
  let skipped = 0;

  for (const game of scheduled) {
    const marketId = `mlb-${game.espnId}`;
    if (existingIds.has(marketId)) {
      skipped++;
      continue;
    }

    let initialProbabilityA: number | undefined;
    if (game.awayMoneyline !== undefined && game.homeMoneyline !== undefined) {
      const { awayProb } = moneylineToFairProbability(game.awayMoneyline, game.homeMoneyline);
      initialProbabilityA = awayProb;
    }

    const logos: [string, string] | undefined =
      game.awayLogo && game.homeLogo ? [game.awayLogo, game.homeLogo] : undefined;

    yield* node.createMarket({
      id: marketId,
      name: game.name,
      outcomes: [game.awayTeam, game.homeTeam],
      closesAt: game.startTime,
      seedAmount: SEED_AMOUNT,
      initialProbabilityA,
      logos,
      leagueLogo: game.leagueLogo || undefined,
    });
    created++;
  }

  yield* Effect.logInfo(`MLB ingest complete: ${created} created, ${skipped} skipped`);
  return { created, skipped };
}).pipe(
  Effect.mapError((e) =>
    e instanceof OracleError ? e : new OracleError({ message: `MLB ingest failed: ${e}` }),
  ),
);
