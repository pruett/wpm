import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import {
  parseEspnNflResponse,
  EspnNflScoreboardResponse,
  NflAdapter,
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

function decode(data: unknown): EspnNflScoreboardResponse {
  return Schema.decodeUnknownSync(EspnNflScoreboardResponse)(data);
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

describe("NFL Adapter — HTTP validation", () => {
  function makeHttpLayer(status: number, body: unknown) {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(req, new Response(JSON.stringify(body), { status })),
        ),
      ),
    );
  }

  effectIt.effect("succeeds with valid 200 response", () =>
    Effect.gen(function* () {
      const adapter = yield* NflAdapter;
      const games = yield* adapter.getUpcomingGames;
      expect(games).toHaveLength(1);
      expect(games[0].espnId).toBe("401547417");
    }).pipe(
      Effect.provide(NflAdapter.Live),
      Effect.provide(makeHttpLayer(200, { events: [makeEvent()] })),
    ),
  );

  effectIt.effect("fails on non-200 HTTP status", () =>
    Effect.gen(function* () {
      const adapter = yield* NflAdapter;
      const result = yield* adapter.getUpcomingGames.pipe(Effect.flip);
      expect(result).toBeInstanceOf(OracleError);
      expect(result.message).toContain("HTTP 500");
    }).pipe(
      Effect.provide(NflAdapter.Live),
      Effect.provide(makeHttpLayer(500, { error: "Internal Server Error" })),
    ),
  );

  effectIt.effect("fails on malformed response body", () =>
    Effect.gen(function* () {
      const adapter = yield* NflAdapter;
      const result = yield* adapter.getUpcomingGames.pipe(Effect.flip);
      expect(result).toBeInstanceOf(OracleError);
      expect(result.message).toContain("validation failed");
    }).pipe(
      Effect.provide(NflAdapter.Live),
      Effect.provide(makeHttpLayer(200, { totally: "wrong shape" })),
    ),
  );
});
