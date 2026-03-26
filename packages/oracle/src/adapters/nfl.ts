import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { Game, GameStatus } from "../types.js";
import { OracleError } from "../errors.js";

const ESPN_NFL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ESPN_NFL_INGEST_URL = `${ESPN_NFL}/scoreboard`;
const ESPN_NFL_RESOLUTION_URL = (eventId: string) => `${ESPN_NFL}/summary?event=${eventId}`;

const STATUS_MAP: Record<string, GameStatus> = {
  STATUS_SCHEDULED: "scheduled",
  STATUS_IN_PROGRESS: "in_progress",
  STATUS_FINAL: "completed",
  STATUS_POSTPONED: "postponed",
};

// Narrow schema: only the fields we extract from ESPN's scoreboard response
const EspnNflCompetitor = Schema.Struct({
  homeAway: Schema.String,
  team: Schema.Struct({
    displayName: Schema.String,
  }),
});

const EspnNflEvent = Schema.Struct({
  id: Schema.String,
  date: Schema.String,
  status: Schema.Struct({
    type: Schema.Struct({
      name: Schema.String,
    }),
  }),
  competitions: Schema.NonEmptyArray(
    Schema.Struct({
      competitors: Schema.NonEmptyArray(EspnNflCompetitor),
    }),
  ),
});

export const EspnNflScoreboardResponse = Schema.Struct({
  events: Schema.Array(EspnNflEvent),
});

export type EspnNflScoreboardResponse = typeof EspnNflScoreboardResponse.Type;

const decodeResponse = Schema.decodeUnknown(EspnNflScoreboardResponse);

export function parseEspnNflResponse(data: EspnNflScoreboardResponse): Game[] {
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

export class NflAdapter extends Context.Tag("NflAdapter")<
  NflAdapter,
  {
    readonly getUpcomingGames: Effect.Effect<Game[], OracleError>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      return {
        getUpcomingGames: HttpClientRequest.get(ESPN_NFL_INGEST_URL).pipe(
          baseClient.execute,
          Effect.flatMap((res) => {
            if (res.status !== 200) {
              return Effect.fail(
                new OracleError({
                  message: `ESPN API returned HTTP ${res.status}`,
                }),
              );
            }
            return res.json;
          }),
          Effect.flatMap((data) =>
            decodeResponse(data).pipe(
              Effect.mapError(
                (e) =>
                  new OracleError({
                    message: `ESPN response validation failed: ${e.message}`,
                  }),
              ),
            ),
          ),
          Effect.map(parseEspnNflResponse),
          Effect.mapError((e) =>
            e instanceof OracleError ? e : new OracleError({ message: `ESPN fetch failed: ${e}` }),
          ),
          Effect.scoped,
        ),
      };
    }),
  );
}
