import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { Game, GameStatus } from "../types.js";
import { OracleError } from "../errors.js";

const ESPN_MLB = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb";
export const ESPN_MLB_SCOREBOARD_URL = `${ESPN_MLB}/scoreboard`;

export const espnMlbOddsUrl = (eventId: string) =>
  `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/${eventId}/competitions/${eventId}/odds`;

const ESPN_BET_PROVIDER_ID = "58";

const STATUS_MAP: Record<string, GameStatus> = {
  STATUS_SCHEDULED: "scheduled",
  STATUS_IN_PROGRESS: "in_progress",
  STATUS_FINAL: "completed",
  STATUS_POSTPONED: "postponed",
};

// --- Scoreboard schemas ---

const EspnMlbCompetitor = Schema.Struct({
  homeAway: Schema.String,
  team: Schema.Struct({
    displayName: Schema.String,
  }),
});

const EspnMlbEvent = Schema.Struct({
  id: Schema.String,
  date: Schema.String,
  status: Schema.Struct({
    type: Schema.Struct({
      name: Schema.String,
    }),
  }),
  competitions: Schema.NonEmptyArray(
    Schema.Struct({
      competitors: Schema.NonEmptyArray(EspnMlbCompetitor),
    }),
  ),
});

export const EspnMlbScoreboardResponse = Schema.Struct({
  events: Schema.Array(EspnMlbEvent),
});

export type EspnMlbScoreboardResponse = typeof EspnMlbScoreboardResponse.Type;

// --- Odds schemas ---

export const EspnMlbOddsItem = Schema.Struct({
  provider: Schema.Struct({ id: Schema.String }),
  awayTeamOdds: Schema.Struct({ moneyLine: Schema.Number }),
  homeTeamOdds: Schema.Struct({ moneyLine: Schema.Number }),
});

export type EspnMlbOddsItem = typeof EspnMlbOddsItem.Type;

export const EspnMlbOddsResponse = Schema.Struct({
  items: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

export type EspnMlbOddsResponse = typeof EspnMlbOddsResponse.Type;

// --- Decoders ---

const decodeScoreboard = Schema.decodeUnknown(EspnMlbScoreboardResponse);
const decodeOddsResponse = Schema.decodeUnknown(EspnMlbOddsResponse);
const decodeOddsItem = Schema.decodeUnknownSync(EspnMlbOddsItem);

// --- Parsing ---

export function parseEspnMlbResponse(data: EspnMlbScoreboardResponse): Game[] {
  return data.events.map((event) => {
    const competition = event.competitions[0];
    const home = competition.competitors.find((c) => c.homeAway === "home");
    const away = competition.competitors.find((c) => c.homeAway === "away");
    const statusName = event.status.type.name;
    return {
      espnId: event.id,
      name: `${away?.team.displayName ?? "Unknown"} vs ${home?.team.displayName ?? "Unknown"}`,
      homeTeam: home?.team.displayName ?? "Unknown",
      awayTeam: away?.team.displayName ?? "Unknown",
      startTime: event.date,
      status: STATUS_MAP[statusName] ?? "scheduled",
    };
  });
}

export function extractOdds(
  data: EspnMlbOddsResponse,
): { awayMoneyline: number; homeMoneyline: number } | undefined {
  for (const item of data.items) {
    try {
      const decoded = decodeOddsItem(item);
      if (decoded.provider.id === ESPN_BET_PROVIDER_ID) {
        return {
          awayMoneyline: decoded.awayTeamOdds.moneyLine,
          homeMoneyline: decoded.homeTeamOdds.moneyLine,
        };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

// --- Adapter ---

export class MlbAdapter extends Context.Tag("MlbAdapter")<
  MlbAdapter,
  {
    readonly getUpcomingGames: Effect.Effect<Game[], OracleError>;
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
                new OracleError({ message: `ESPN ${label} returned HTTP ${res.status}` }),
              );
            }
            return Effect.mapError(
              res.json,
              (e) => new OracleError({ message: `ESPN ${label} JSON parse failed: ${e}` }),
            );
          }),
          Effect.mapError((e) =>
            e instanceof OracleError
              ? e
              : new OracleError({ message: `ESPN ${label} fetch failed: ${e}` }),
          ),
          Effect.scoped,
        );

      const fetchOdds = (eventId: string) =>
        fetchJson(espnMlbOddsUrl(eventId), `odds/${eventId}`).pipe(
          Effect.flatMap((data) =>
            decodeOddsResponse(data).pipe(
              Effect.mapError(
                (e) =>
                  new OracleError({
                    message: `ESPN odds validation failed: ${e.message}`,
                  }),
              ),
            ),
          ),
          Effect.map(extractOdds),
          Effect.catchAll(() => Effect.succeed(undefined)),
        );

      return {
        getUpcomingGames: Effect.gen(function* () {
          const scoreboardData = yield* fetchJson(ESPN_MLB_SCOREBOARD_URL, "scoreboard").pipe(
            Effect.flatMap((data) =>
              decodeScoreboard(data).pipe(
                Effect.mapError(
                  (e) =>
                    new OracleError({
                      message: `ESPN response validation failed: ${e.message}`,
                    }),
                ),
              ),
            ),
          );

          const games = parseEspnMlbResponse(scoreboardData);

          const gamesWithOdds = yield* Effect.all(
            games.map((game) =>
              game.status === "scheduled"
                ? fetchOdds(game.espnId).pipe(
                    Effect.map((odds) => (odds ? { ...game, ...odds } : game)),
                  )
                : Effect.succeed(game),
            ),
            { concurrency: 5 },
          );

          return gamesWithOdds;
        }),
      };
    }),
  );
}
