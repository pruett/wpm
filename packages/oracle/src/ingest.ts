import { Effect } from "effect";
import { NflAdapter, moneylineToFairProbability } from "./adapters/nfl.js";
import { NodeClient } from "./node-client.js";
import { OracleError } from "./errors.js";

const SEED_AMOUNT = 1000;

export const ingest = Effect.gen(function* () {
  const nfl = yield* NflAdapter;
  const node = yield* NodeClient;

  const games = yield* nfl.getUpcomingGames;
  const scheduled = games.filter((g) => g.status === "scheduled");

  const existing = yield* node.getMarkets;
  const existingIds = new Set(existing.map((e) => e.market.id));

  let created = 0;
  let skipped = 0;

  for (const game of scheduled) {
    const marketId = `nfl-${game.espnId}`;
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
    });
    created++;
  }

  yield* Effect.logInfo(`Ingest complete: ${created} created, ${skipped} skipped`);
  return { created, skipped };
}).pipe(
  Effect.mapError((e) =>
    e instanceof OracleError ? e : new OracleError({ message: `Ingest failed: ${e}` }),
  ),
);
