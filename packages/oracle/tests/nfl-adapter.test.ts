import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import {
  parseEspnNflResponse,
  extractOdds,
  moneylineToImpliedProbability,
  moneylineToFairProbability,
  EspnNflScoreboardResponse,
  EspnNflOddsResponse,
  NflAdapter,
  espnNflOddsUrl,
} from "../src/adapters/nfl.js";
import { OracleError } from "../src/errors.js";

const makeEvent = (overrides: Record<string, any> = {}) => ({
  id: "401547417",
  name: "Kansas City Chiefs at Philadelphia Eagles",
  shortName: "KC @ PHI",
  date: "2026-02-08T23:30Z",
  status: { type: { name: "STATUS_SCHEDULED", completed: false } },
  competitions: [
    {
      competitors: [
        {
          homeAway: "home",
          team: { displayName: "Philadelphia Eagles", abbreviation: "PHI" },
        },
        {
          homeAway: "away",
          team: { displayName: "Kansas City Chiefs", abbreviation: "KC" },
        },
      ],
    },
  ],
  ...overrides,
});

const makeOddsResponse = (awayML: number = 320, homeML: number = -425) => ({
  items: [
    {
      provider: { id: "58", name: "ESPN BET" },
      details: "PHI -7.5",
      overUnder: 48.5,
      spread: -7.5,
      awayTeamOdds: { moneyLine: awayML, favorite: awayML < 0, underdog: awayML > 0 },
      homeTeamOdds: { moneyLine: homeML, favorite: homeML < 0, underdog: homeML > 0 },
    },
    {
      provider: { id: "59", name: "ESPN Bet - Live Odds" },
      awayTeamOdds: { moneyLine: 400 },
      homeTeamOdds: { moneyLine: -550 },
    },
  ],
});

function decode(data: unknown): EspnNflScoreboardResponse {
  return Schema.decodeUnknownSync(EspnNflScoreboardResponse)(data);
}

function makeHttpLayer(routes: Record<string, { status: number; body: unknown }>) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) => {
      const url = req.url;
      for (const [pattern, response] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(JSON.stringify(response.body), { status: response.status }),
            ),
          );
        }
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(req, new Response("Not found", { status: 404 })),
      );
    }),
  );
}

describe("NFL Adapter — parseEspnNflResponse", () => {
  it("normalizes ESPN response to Game objects", () => {
    const games = parseEspnNflResponse(decode({ events: [makeEvent()] }));

    expect(games).toHaveLength(1);
    const game = games[0];
    expect(game.espnId).toBe("401547417");
    expect(game.name).toBe("Kansas City Chiefs vs Philadelphia Eagles");
    expect(game.homeTeam).toBe("Philadelphia Eagles");
    expect(game.awayTeam).toBe("Kansas City Chiefs");
    expect(game.startTime).toBe("2026-02-08T23:30Z");
    expect(game.status).toBe("scheduled");
  });

  it("maps ESPN status types correctly", () => {
    const statuses = [
      { input: "STATUS_SCHEDULED", expected: "scheduled" },
      { input: "STATUS_IN_PROGRESS", expected: "in_progress" },
      { input: "STATUS_FINAL", expected: "completed" },
      { input: "STATUS_POSTPONED", expected: "postponed" },
    ];

    for (const { input, expected } of statuses) {
      const data = decode({
        events: [makeEvent({ status: { type: { name: input, completed: false } } })],
      });
      const games = parseEspnNflResponse(data);
      expect(games[0].status).toBe(expected);
    }
  });
});

describe("NFL Adapter — moneyline conversion", () => {
  it("converts negative moneyline (favorite) to implied probability", () => {
    // -425 → 425 / (425 + 100) = 0.8095
    expect(moneylineToImpliedProbability(-425)).toBeCloseTo(0.8095, 3);
  });

  it("converts positive moneyline (underdog) to implied probability", () => {
    // +320 → 100 / (320 + 100) = 0.2381
    expect(moneylineToImpliedProbability(320)).toBeCloseTo(0.2381, 3);
  });

  it("converts even money correctly", () => {
    expect(moneylineToImpliedProbability(100)).toBeCloseTo(0.5, 3);
    expect(moneylineToImpliedProbability(-100)).toBeCloseTo(0.5, 3);
  });

  it("computes fair probabilities with vig removed", () => {
    const { awayProb, homeProb } = moneylineToFairProbability(320, -425);
    // Raw implied: 0.2381 + 0.8095 = 1.0476 (4.76% vig)
    // Fair: 0.2381 / 1.0476 ≈ 0.2273, 0.8095 / 1.0476 ≈ 0.7727
    expect(awayProb).toBeCloseTo(0.2273, 3);
    expect(homeProb).toBeCloseTo(0.7727, 3);
    expect(awayProb + homeProb).toBeCloseTo(1.0, 10);
  });

  it("computes ~50/50 for even moneylines", () => {
    const { awayProb, homeProb } = moneylineToFairProbability(-110, -110);
    expect(awayProb).toBeCloseTo(0.5, 3);
    expect(homeProb).toBeCloseTo(0.5, 3);
  });
});

describe("NFL Adapter — extractOdds", () => {
  it("extracts moneyline from ESPN BET provider", () => {
    const data = Schema.decodeUnknownSync(EspnNflOddsResponse)(makeOddsResponse(320, -425));
    const odds = extractOdds(data);
    expect(odds).toEqual({ awayMoneyline: 320, homeMoneyline: -425 });
  });

  it("returns undefined when ESPN BET provider is missing", () => {
    const data = Schema.decodeUnknownSync(EspnNflOddsResponse)({
      items: [
        {
          provider: { id: "99" },
          awayTeamOdds: { moneyLine: 100 },
          homeTeamOdds: { moneyLine: -100 },
        },
      ],
    });
    expect(extractOdds(data)).toBeUndefined();
  });

  it("returns undefined when moneyLine fields are missing", () => {
    const data = Schema.decodeUnknownSync(EspnNflOddsResponse)({
      items: [{ provider: { id: "58" }, awayTeamOdds: {}, homeTeamOdds: {} }],
    });
    expect(extractOdds(data)).toBeUndefined();
  });

  it("returns undefined for empty items array", () => {
    const data = Schema.decodeUnknownSync(EspnNflOddsResponse)({ items: [] });
    expect(extractOdds(data)).toBeUndefined();
  });
});

describe("NFL Adapter — HTTP integration", () => {
  const validRoutes = {
    scoreboard: { status: 200, body: { events: [makeEvent()] } },
    "/odds": { status: 200, body: makeOddsResponse() },
  };

  effectIt.effect("fetches games with odds from ESPN", () =>
    Effect.gen(function* () {
      const adapter = yield* NflAdapter;
      const games = yield* adapter.getUpcomingGames;
      expect(games).toHaveLength(1);
      expect(games[0].espnId).toBe("401547417");
      expect(games[0].awayMoneyline).toBe(320);
      expect(games[0].homeMoneyline).toBe(-425);
    }).pipe(Effect.provide(NflAdapter.Live), Effect.provide(makeHttpLayer(validRoutes))),
  );

  effectIt.effect("returns games without odds when odds endpoint fails", () =>
    Effect.gen(function* () {
      const adapter = yield* NflAdapter;
      const games = yield* adapter.getUpcomingGames;
      expect(games).toHaveLength(1);
      expect(games[0].espnId).toBe("401547417");
      expect(games[0].awayMoneyline).toBeUndefined();
      expect(games[0].homeMoneyline).toBeUndefined();
    }).pipe(
      Effect.provide(NflAdapter.Live),
      Effect.provide(
        makeHttpLayer({
          scoreboard: { status: 200, body: { events: [makeEvent()] } },
          "/odds": { status: 500, body: {} },
        }),
      ),
    ),
  );

  effectIt.effect("returns games without odds when odds response is malformed", () =>
    Effect.gen(function* () {
      const adapter = yield* NflAdapter;
      const games = yield* adapter.getUpcomingGames;
      expect(games).toHaveLength(1);
      expect(games[0].awayMoneyline).toBeUndefined();
    }).pipe(
      Effect.provide(NflAdapter.Live),
      Effect.provide(
        makeHttpLayer({
          scoreboard: { status: 200, body: { events: [makeEvent()] } },
          "/odds": { status: 200, body: { wrong: "shape" } },
        }),
      ),
    ),
  );

  effectIt.effect("fails on non-200 scoreboard HTTP status", () =>
    Effect.gen(function* () {
      const adapter = yield* NflAdapter;
      const result = yield* adapter.getUpcomingGames.pipe(Effect.flip);
      expect(result).toBeInstanceOf(OracleError);
      expect(result.message).toContain("HTTP 500");
    }).pipe(
      Effect.provide(NflAdapter.Live),
      Effect.provide(
        makeHttpLayer({
          scoreboard: { status: 500, body: { error: "Internal Server Error" } },
        }),
      ),
    ),
  );

  effectIt.effect("fails on malformed scoreboard response body", () =>
    Effect.gen(function* () {
      const adapter = yield* NflAdapter;
      const result = yield* adapter.getUpcomingGames.pipe(Effect.flip);
      expect(result).toBeInstanceOf(OracleError);
      expect(result.message).toContain("validation failed");
    }).pipe(
      Effect.provide(NflAdapter.Live),
      Effect.provide(
        makeHttpLayer({
          scoreboard: { status: 200, body: { totally: "wrong shape" } },
        }),
      ),
    ),
  );
});
