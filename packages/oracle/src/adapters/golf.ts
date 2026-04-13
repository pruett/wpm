import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { OracleError } from "../errors.js";

const ESPN_GOLF_PGA = "https://site.api.espn.com/apis/site/v2/sports/golf/pga";

export const ESPN_GOLF_SCOREBOARD_URL = `${ESPN_GOLF_PGA}/scoreboard`;

/** Only create markets for the top N leaderboard competitors per tournament. */
export const MAX_COMPETITORS = 15;

type TournamentStatus = "scheduled" | "in_progress" | "completed" | "postponed";

export type Competitor = {
  readonly espnId: string;
  readonly name: string;
  readonly position: number;
  readonly score: string;
};

export type Tournament = {
  readonly espnId: string;
  readonly name: string;
  readonly startTime: string;
  readonly status: TournamentStatus;
  readonly round: number;
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
  order: Schema.Number,
  score: Schema.String,
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
      status: Schema.Struct({
        period: Schema.optionalWith(Schema.Number, { default: () => 0 }),
      }),
      competitors: Schema.Array(EspnGolfCompetitor),
    }),
  ),
});

export const EspnGolfScoreboardResponse = Schema.Struct({
  events: Schema.Array(EspnGolfEvent),
});

export type EspnGolfScoreboardResponse = typeof EspnGolfScoreboardResponse.Type;

// --- Decoders ---

const decodeScoreboard = Schema.decodeUnknown(EspnGolfScoreboardResponse);

/**
 * Parse a golf score string into a numeric value.
 * "-11" → -11, "E" → 0, "+3" → 3. Returns NaN for unparseable values.
 */
export function parseScore(score: string): number {
  const trimmed = score.trim();
  if (trimmed === "E") return 0;
  if (trimmed === "") return NaN;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Sort competitors by leaderboard position and return the top N.
 */
export function topLeaderboardCompetitors(competitors: Competitor[], limit: number): Competitor[] {
  return [...competitors].sort((a, b) => a.position - b.position).slice(0, limit);
}

export function parseEspnGolfResponse(data: EspnGolfScoreboardResponse): Tournament[] {
  return data.events.map((event) => {
    const competition = event.competitions[0];
    const statusName = event.status.type.name;
    const allCompetitors: Competitor[] = competition.competitors.map((c) => ({
      espnId: c.id,
      name: c.athlete.displayName,
      position: c.order,
      score: c.score,
    }));
    return {
      espnId: event.id,
      name: event.name,
      startTime: event.date,
      status: STATUS_MAP[statusName] ?? "scheduled",
      round: competition.status.period,
      competitors: topLeaderboardCompetitors(allCompetitors, MAX_COMPETITORS),
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
          const scoreboardData = yield* fetchJson(ESPN_GOLF_SCOREBOARD_URL, "scoreboard").pipe(
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
          );

          return parseEspnGolfResponse(scoreboardData);
        }),
      };
    }),
  );
}
