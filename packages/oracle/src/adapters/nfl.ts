import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { Game, GameStatus } from "../types.js";
import { OracleError } from "../errors.js";

const ESPN_NFL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
export const ESPN_NFL_SCOREBOARD_URL = `${ESPN_NFL}/scoreboard`;

export const espnNflOddsUrl = (eventId: string) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${eventId}/competitions/${eventId}/odds`;

const ESPN_BET_PROVIDER_ID = "58";

const STATUS_MAP: Record<string, GameStatus> = {
  STATUS_SCHEDULED: "scheduled",
  STATUS_IN_PROGRESS: "in_progress",
  STATUS_FINAL: "completed",
  STATUS_POSTPONED: "postponed",
};

// --- Moneyline conversion ---

export function moneylineToImpliedProbability(moneyline: number): number {
  return moneyline < 0
    ? Math.abs(moneyline) / (Math.abs(moneyline) + 100)
    : 100 / (moneyline + 100);
}

export function moneylineToFairProbability(
  awayML: number,
  homeML: number,
): { awayProb: number; homeProb: number } {
  const awayImplied = moneylineToImpliedProbability(awayML);
  const homeImplied = moneylineToImpliedProbability(homeML);
  const total = awayImplied + homeImplied;
  return {
    awayProb: awayImplied / total,
    homeProb: homeImplied / total,
  };
}

// --- Scoreboard schemas ---

const EspnNflCompetitor = Schema.Struct({
  homeAway: Schema.String,
  team: Schema.Struct({
    displayName: Schema.String,
    logo: Schema.optionalWith(Schema.String, { default: () => "" }),
  }),
  score: Schema.optionalWith(Schema.String, { default: () => "" }),
  winner: Schema.optionalWith(Schema.Boolean, { default: () => false }),
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

const EspnLeagueLogo = Schema.Struct({
  href: Schema.String,
});

const EspnLeague = Schema.Struct({
  logos: Schema.optionalWith(Schema.Array(EspnLeagueLogo), { default: () => [] }),
});

export const EspnNflScoreboardResponse = Schema.Struct({
  leagues: Schema.optionalWith(Schema.Array(EspnLeague), { default: () => [] }),
  events: Schema.Array(EspnNflEvent),
});

export type EspnNflScoreboardResponse = typeof EspnNflScoreboardResponse.Type;

// --- Odds schemas ---

export const EspnNflOddsItem = Schema.Struct({
  provider: Schema.Struct({ id: Schema.String }),
  awayTeamOdds: Schema.Struct({ moneyLine: Schema.Number }),
  homeTeamOdds: Schema.Struct({ moneyLine: Schema.Number }),
});

export type EspnNflOddsItem = typeof EspnNflOddsItem.Type;

export const EspnNflOddsResponse = Schema.Struct({
  items: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

export type EspnNflOddsResponse = typeof EspnNflOddsResponse.Type;

// --- Decoders ---

const decodeScoreboard = Schema.decodeUnknown(EspnNflScoreboardResponse);
const decodeOddsResponse = Schema.decodeUnknown(EspnNflOddsResponse);
const decodeOddsItem = Schema.decodeUnknownSync(EspnNflOddsItem);

// --- Parsing ---

export function parseEspnNflResponse(data: EspnNflScoreboardResponse): Game[] {
  const leagueLogo = data.leagues[0]?.logos[0]?.href ?? "";
  return data.events.map((event) => {
    const competition = event.competitions[0];
    const home = competition.competitors.find((c) => c.homeAway === "home");
    const away = competition.competitors.find((c) => c.homeAway === "away");
    const statusName = event.status.type.name;
    const homeScore = home?.score ? Number(home.score) : undefined;
    const awayScore = away?.score ? Number(away.score) : undefined;
    const winner = home?.winner ? ("home" as const) : away?.winner ? ("away" as const) : undefined;

    return {
      espnId: event.id,
      name: `${away?.team.displayName ?? "Unknown"} vs ${home?.team.displayName ?? "Unknown"}`,
      homeTeam: home?.team.displayName ?? "Unknown",
      awayTeam: away?.team.displayName ?? "Unknown",
      homeLogo: home?.team.logo ?? "",
      awayLogo: away?.team.logo ?? "",
      leagueLogo,
      startTime: event.date,
      status: STATUS_MAP[statusName] ?? "scheduled",
      homeScore: Number.isFinite(homeScore) ? homeScore : undefined,
      awayScore: Number.isFinite(awayScore) ? awayScore : undefined,
      winner,
    };
  });
}

export function extractOdds(
  data: EspnNflOddsResponse,
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
        fetchJson(espnNflOddsUrl(eventId), `odds/${eventId}`).pipe(
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
          const scoreboardData = yield* fetchJson(ESPN_NFL_SCOREBOARD_URL, "scoreboard").pipe(
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

          const games = parseEspnNflResponse(scoreboardData);

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
