import { Effect } from "effect";
import { initializePool, type CreateMarketRequest } from "@wpm/shared";
import { GolfAdapter, parseScore, type Competitor } from "./adapters/golf.js";
import { WebClient } from "./web-client.js";
import { OracleError } from "./errors.js";

const SEED_AMOUNT = 100;
const BETTING_WINDOW_MS = 4 * 60 * 60 * 1000;
const FINAL_ROUND = 4;
const DECAY_K = 0.5;

export function scoreToProbabilities(competitors: Competitor[]): Map<string, number> {
  const probs = new Map<string, number>();
  if (competitors.length === 0) return probs;

  const parsed = competitors
    .map((c) => ({ espnId: c.espnId, numericScore: parseScore(c.score) }))
    .filter((c) => !Number.isNaN(c.numericScore));

  if (parsed.length === 0) return probs;

  const leaderScore = Math.min(...parsed.map((c) => c.numericScore));

  const weights = parsed.map((c) => ({
    espnId: c.espnId,
    weight: Math.exp(-DECAY_K * (c.numericScore - leaderScore)),
  }));

  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);

  for (const w of weights) {
    probs.set(w.espnId, w.weight / totalWeight);
  }

  return probs;
}

export const golfIngest = Effect.gen(function* () {
  const golf = yield* GolfAdapter;
  const web = yield* WebClient;

  const tournaments = yield* golf.getUpcomingTournaments;
  const finalRound = tournaments.filter(
    (t) => t.status === "in_progress" && t.round === FINAL_ROUND,
  );

  let created = 0;
  let skipped = 0;

  for (const tournament of finalRound) {
    const probabilities = scoreToProbabilities(tournament.competitors);

    for (const competitor of tournament.competitors) {
      const marketId = `golf-pga-${tournament.espnId}-${competitor.espnId}`;
      const initialProbabilityA = probabilities.get(competitor.espnId);
      const pool = initializePool(marketId, SEED_AMOUNT, initialProbabilityA);
      const closesAt = new Date(Date.now() + BETTING_WINDOW_MS).toISOString();

      const params: CreateMarketRequest = {
        id: marketId,
        sport: "golf-pga",
        name: `${competitor.name} to win ${tournament.name}`,
        teamA: "Yes",
        teamB: "No",
        leagueLogo: tournament.leagueLogo || undefined,
        closesAt,
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
  }

  yield* Effect.logInfo(`Golf ingest complete: ${created} created, ${skipped} skipped`);
  return { created, skipped };
}).pipe(
  Effect.mapError((e) =>
    e instanceof OracleError ? e : new OracleError({ message: `Golf ingest failed: ${e}` }),
  ),
);
