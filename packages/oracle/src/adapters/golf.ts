import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { OracleError } from "../errors.js";

const ESPN_GOLF_PGA = "https://site.api.espn.com/apis/site/v2/sports/golf/pga";

export const ESPN_GOLF_SCOREBOARD_URL = `${ESPN_GOLF_PGA}/scoreboard`;

/** Build OWGR (Official World Golf Ranking) URL for a given season year. */
export const espnGolfOwgrUrl = (year: number) =>
  `https://sports.core.api.espn.com/v2/sports/golf/leagues/all/seasons/${year}/rankings/1`;

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

// OWGR ranking type: returns weekly date snapshots as $ref links
export const EspnGolfOwgrResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  rankings: Schema.NonEmptyArray(Schema.Struct({ $ref: Schema.String })),
});

export type EspnGolfOwgrResponse = typeof EspnGolfOwgrResponse.Type;

// Weekly ranks: individual rank entries with athlete $ref links
const EspnRankEntry = Schema.Struct({
  current: Schema.Number,
  athlete: Schema.Struct({ $ref: Schema.String }),
});

export const EspnGolfRanksResponse = Schema.Struct({
  ranks: Schema.NonEmptyArray(EspnRankEntry),
});

export type EspnGolfRanksResponse = typeof EspnGolfRanksResponse.Type;

// --- Decoders ---

const decodeScoreboard = Schema.decodeUnknown(EspnGolfScoreboardResponse);
const decodeOwgr = Schema.decodeUnknown(EspnGolfOwgrResponse);
const decodeRanks = Schema.decodeUnknown(EspnGolfRanksResponse);

const ATHLETE_ID_RE = /\/athletes\/(\d+)/;

/**
 * Build a set of athlete IDs ordered by world ranking (OWGR).
 * Returns a Map<athleteId, rank> for O(1) lookup.
 * Extracts athlete IDs from $ref URLs in each rank entry.
 */
export function buildRankingIndex(data: EspnGolfRanksResponse): Map<string, number> {
  const index = new Map<string, number>();
  for (const entry of data.ranks) {
    const match = entry.athlete.$ref.match(ATHLETE_ID_RE);
    if (match) {
      index.set(match[1], entry.current);
    }
  }
  return index;
}

/**
 * Filter and sort competitors by world ranking, keeping only the top N.
 * Unranked players are excluded — if fewer than N are ranked, return all ranked.
 * When no ranking data is available, returns the first N in scoreboard order.
 */
export function topRankedCompetitors(
  competitors: Competitor[],
  rankings: Map<string, number>,
  limit: number,
): Competitor[] {
  if (rankings.size === 0) {
    return competitors.slice(0, limit);
  }
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
            return Effect.mapError(
              res.json,
              (e) => new OracleError({ message: `ESPN Golf ${label} JSON parse failed: ${e}` }),
            );
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
          // Fetch scoreboard and OWGR ranking type in parallel
          const [scoreboardData, owgrData] = yield* Effect.all([
            fetchJson(ESPN_GOLF_SCOREBOARD_URL, "scoreboard").pipe(
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
            fetchJson(espnGolfOwgrUrl(new Date().getFullYear()), "OWGR").pipe(
              Effect.flatMap((data) =>
                decodeOwgr(data).pipe(
                  Effect.mapError(
                    (e) =>
                      new OracleError({
                        message: `ESPN Golf OWGR validation failed: ${e.message}`,
                      }),
                  ),
                ),
              ),
            ),
          ]);

          // Follow the first (most recent) date ref to get actual ranks
          const latestDateRef = owgrData.rankings[0].$ref;
          const ranksUrl = latestDateRef.includes("?")
            ? `${latestDateRef}&limit=500`
            : `${latestDateRef}?limit=500`;

          const ranksData = yield* fetchJson(ranksUrl, "ranks").pipe(
            Effect.flatMap((data) =>
              decodeRanks(data).pipe(
                Effect.mapError(
                  (e) =>
                    new OracleError({
                      message: `ESPN Golf ranks validation failed: ${e.message}`,
                    }),
                ),
              ),
            ),
          );

          const rankings = buildRankingIndex(ranksData);
          return parseEspnGolfResponse(scoreboardData, rankings);
        }),
      };
    }),
  );
}
