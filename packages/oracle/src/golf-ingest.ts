import { Effect } from "effect";
import { GolfAdapter } from "./adapters/golf.js";
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
 */
const SEED_AMOUNT = 100;

export const golfIngest = Effect.gen(function* () {
  const golf = yield* GolfAdapter;
  const node = yield* NodeClient;

  const tournaments = yield* golf.getUpcomingTournaments;
  const scheduled = tournaments.filter((t) => t.status === "scheduled");

  const existing = yield* node.getMarkets;
  const existingIds = new Set(existing.map((e) => e.market.id));

  let created = 0;
  let skipped = 0;

  for (const tournament of scheduled) {
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
        closesAt: tournament.startTime,
        seedAmount: SEED_AMOUNT,
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
