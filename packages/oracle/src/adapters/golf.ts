import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { OracleError } from "../errors.js";

const ESPN_GOLF_PGA = "https://site.api.espn.com/apis/site/v2/sports/golf/pga";
const ESPN_GOLF_PGA_SCOREBOARD_URL = `${ESPN_GOLF_PGA}/scoreboard`;
const ESPN_GOLF_PGA_RANKINGS_URL =
  "https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/rankings";

/** Only create markets for the top N world-ranked golfers per tournament. */
export const MAX_COMPETITORS = 10;

type TournamentStatus = "scheduled" | "in_progress" | "completed" | "postponed";

export type Competitor = {
  readonly espnId: string;
  readonly name: string;
};

export type Tournament = {
  readonly espnId: string;
  readonly name: string;
  readonly startTime: string;
  readonly status: TournamentStatus;
  readonly competitors: Competitor[];
};

const STATUS_MAP: Record<string, TournamentStatus> = {
  STATUS_SCHEDULED: "scheduled",
  STATUS_IN_PROGRESS: "in_progress",
  STATUS_FINAL: "completed",
  STATUS_POSTPONED: "postponed",
};

// --- Scoreboard schemas ---

const EspnGolfCompetitor = Schema.Struct({
  id: Schema.String,
  athlete: Schema.Struct({
    displayName: Schema.String,
  }),
});

const EspnGolfEvent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  date: Schema.String,
  status: Schema.Struct({
    type: Schema.Struct({
      name: Schema.String,
    }),
  }),
  competitions: Schema.NonEmptyArray(
    Schema.Struct({
      competitors: Schema.Array(EspnGolfCompetitor),
    }),
  ),
});

export const EspnGolfScoreboardResponse = Schema.Struct({
  events: Schema.Array(EspnGolfEvent),
});

export type EspnGolfScoreboardResponse = typeof EspnGolfScoreboardResponse.Type;

// --- Rankings schemas ---

const EspnRankingEntry = Schema.Struct({
  athlete: Schema.Struct({
    id: Schema.String,
  }),
});

const EspnRanking = Schema.Struct({
  // ESPN returns multiple ranking types; we use the first (OWGR)
  ranks: Schema.Array(EspnRankingEntry),
});

export const EspnGolfRankingsResponse = Schema.Struct({
  rankings: Schema.NonEmptyArray(EspnRanking),
});

export type EspnGolfRankingsResponse = typeof EspnGolfRankingsResponse.Type;

// --- Decoders ---

const decodeScoreboard = Schema.decodeUnknown(EspnGolfScoreboardResponse);
const decodeRankings = Schema.decodeUnknown(EspnGolfRankingsResponse);

/**
 * Build a set of athlete IDs ordered by world ranking (OWGR).
 * Returns a Map<athleteId, rank> for O(1) lookup.
 */
export function buildRankingIndex(data: EspnGolfRankingsResponse): Map<string, number> {
  const index = new Map<string, number>();
  const ranks = data.rankings[0].ranks;
  for (let i = 0; i < ranks.length; i++) {
    index.set(ranks[i].athlete.id, i + 1);
  }
  return index;
}

/**
 * Filter and sort competitors by world ranking, keeping only the top N.
 * Unranked players are excluded — if fewer than N are ranked, return all ranked.
 */
export function topRankedCompetitors(
  competitors: Competitor[],
  rankings: Map<string, number>,
  limit: number,
): Competitor[] {
  return competitors
    .filter((c) => rankings.has(c.espnId))
    .sort((a, b) => rankings.get(a.espnId)! - rankings.get(b.espnId)!)
    .slice(0, limit);
}

export function parseEspnGolfResponse(
  data: EspnGolfScoreboardResponse,
  rankings: Map<string, number>,
): Tournament[] {
  return data.events.map((event) => {
    const competition = event.competitions[0];
    const statusName = event.status.type.name;
    const allCompetitors = competition.competitors.map((c) => ({
      espnId: c.id,
      name: c.athlete.displayName,
    }));
    return {
      espnId: event.id,
      name: event.name,
      startTime: event.date,
      status: STATUS_MAP[statusName] ?? "scheduled",
      competitors: topRankedCompetitors(allCompetitors, rankings, MAX_COMPETITORS),
    };
  });
}

export class GolfAdapter extends Context.Tag("GolfAdapter")<
  GolfAdapter,
  {
    readonly getUpcomingTournaments: Effect.Effect<Tournament[], OracleError>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;

      const fetchJson = (url: string, label: string) =>
        HttpClientRequest.get(url).pipe(
          baseClient.execute,
          Effect.flatMap((res) => {
            if (res.status !== 200) {
              return Effect.fail(
                new OracleError({ message: `ESPN Golf ${label} returned HTTP ${res.status}` }),
              );
            }
            return res.json;
          }),
          Effect.mapError((e) =>
            e instanceof OracleError
              ? e
              : new OracleError({ message: `ESPN Golf ${label} fetch failed: ${e}` }),
          ),
          Effect.scoped,
        );

      return {
        getUpcomingTournaments: Effect.gen(function* () {
          const [scoreboardData, rankingsData] = yield* Effect.all([
            fetchJson(ESPN_GOLF_PGA_SCOREBOARD_URL, "scoreboard").pipe(
              Effect.flatMap((data) =>
                decodeScoreboard(data).pipe(
                  Effect.mapError(
                    (e) =>
                      new OracleError({
                        message: `ESPN Golf scoreboard validation failed: ${e.message}`,
                      }),
                  ),
                ),
              ),
            ),
            fetchJson(ESPN_GOLF_PGA_RANKINGS_URL, "rankings").pipe(
              Effect.flatMap((data) =>
                decodeRankings(data).pipe(
                  Effect.mapError(
                    (e) =>
                      new OracleError({
                        message: `ESPN Golf rankings validation failed: ${e.message}`,
                      }),
                  ),
                ),
              ),
            ),
          ]);

          const rankings = buildRankingIndex(rankingsData);
          return parseEspnGolfResponse(scoreboardData, rankings);
        }),
      };
    }),
  );
}
