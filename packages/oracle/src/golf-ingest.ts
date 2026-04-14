import { Effect } from "effect";
import { GolfAdapter, parseScore, type Competitor } from "./adapters/golf.js";
import { NodeClient } from "./node-client.js";
import { OracleError } from "./errors.js";

/**
 * Golf tournaments have many possible winners, but each market must be binary.
 * Following Kalshi/Polymarket's proven pattern: decompose each tournament into
 * independent per-golfer contracts — "Will [Golfer] win [Tournament]?" → Yes / No.
 *
 * Each golfer becomes a standalone binary market. The Yes outcome pays out if
 * that golfer wins; No pays out otherwise. This lets the existing constant-product
 * AMM price each golfer's probability independently, and traders can build
 * multi-golfer positions by combining individual contracts.
 *
 * Markets are only created once the final round (round 4) is in progress,
 * giving users a betting window on Sunday morning with three rounds of
 * leaderboard context.
 */
const SEED_AMOUNT = 100;

/** Betting window from market creation until close (4 hours). */
const BETTING_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Standard PGA final round number. */
const FINAL_ROUND = 4;

/** Exponential decay constant — each stroke back roughly halves win probability. */
const DECAY_K = 0.5;

/**
 * Compute win probabilities from leaderboard scores using exponential decay.
 *
 * weight(golfer) = e^(-k * strokes_behind_leader)
 * probability(golfer) = weight(golfer) / sum(all_weights)
 *
 * Returns a Map<espnId, probability>.
 */
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
  const node = yield* NodeClient;

  const tournaments = yield* golf.getUpcomingTournaments;
  const finalRound = tournaments.filter(
    (t) => t.status === "in_progress" && t.round === FINAL_ROUND,
  );

  const existing = yield* node.getMarkets;
  const existingIds = new Set(existing.map((e) => e.market.id));

  let created = 0;
  let skipped = 0;

  for (const tournament of finalRound) {
    const probabilities = scoreToProbabilities(tournament.competitors);

    for (const competitor of tournament.competitors) {
      const marketId = `golf-pga-${tournament.espnId}-${competitor.espnId}`;
      if (existingIds.has(marketId)) {
        skipped++;
        continue;
      }

      yield* node.createMarket({
        id: marketId,
        name: `${competitor.name} to win ${tournament.name}`,
        outcomes: ["Yes", "No"],
        closesAt: new Date(Date.now() + BETTING_WINDOW_MS).toISOString(),
        seedAmount: SEED_AMOUNT,
        initialProbabilityA: probabilities.get(competitor.espnId),
        leagueLogo: tournament.leagueLogo || undefined,
      });
      created++;
    }
  }

  yield* Effect.logInfo(`Golf ingest complete: ${created} created, ${skipped} skipped`);
  return { created, skipped };
}).pipe(
  Effect.mapError((e) =>
    e instanceof OracleError ? e : new OracleError({ message: `Golf ingest failed: ${e}` }),
  ),
);
