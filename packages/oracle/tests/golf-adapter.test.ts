import { describe, expect } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import {
  parseEspnGolfResponse,
  buildRankingIndex,
  EspnGolfScoreboardResponse,
  EspnGolfRanksResponse,
  GolfAdapter,
  MAX_COMPETITORS,
} from "../src/adapters/golf.js";
import { OracleError } from "../src/errors.js";

const makeCompetitor = (id: string, name: string) => ({
  id,
  athlete: { displayName: name },
});

// 20 competitors — more than MAX_COMPETITORS, includes one unranked player
const makeEvent = (overrides: Record<string, any> = {}) => ({
  id: "401580337",
  name: "The Masters",
  date: "2026-04-10T13:00Z",
  status: { type: { name: "STATUS_SCHEDULED", completed: false } },
  competitions: [
    {
      competitors: [
        ...Array.from({ length: 15 }, (_, i) => makeCompetitor(`${i + 1}`, `Golfer ${i + 1}`)),
        makeCompetitor("9999", "Unranked Amateur"),
      ],
    },
  ],
  ...overrides,
});

const makeOwgrResponse = () => ({
  id: "1",
  name: "World Rankings",
  type: "WORLDRANK",
  rankings: [{ $ref: "http://espn.test/rankings/1/dates/20260322" }],
});

// Only ranks golfers 1–15, leaving "9999" unranked
const makeRanksResponse = () => ({
  ranks: Array.from({ length: 15 }, (_, i) => ({
    current: i + 1,
    athlete: { $ref: `http://espn.test/athletes/${i + 1}` },
  })),
});

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

const validRoutes = {
  scoreboard: { status: 200, body: { events: [makeEvent()] } },
  // More specific pattern first so /dates/ matches before /rankings/
  "/dates/": { status: 200, body: makeRanksResponse() },
  "/rankings/": { status: 200, body: makeOwgrResponse() },
};

describe("Golf Adapter", () => {
  effectIt.effect("parses scoreboard and returns top-ranked competitors", () =>
    Effect.sync(() => {
      const scoreboard = Schema.decodeUnknownSync(EspnGolfScoreboardResponse)({
        events: [
          makeEvent(),
          makeEvent({
            id: "401580338",
            name: "PGA Championship",
            status: { type: { name: "STATUS_FINAL" } },
          }),
        ],
      });
      const rankings = buildRankingIndex(
        Schema.decodeUnknownSync(EspnGolfRanksResponse)(makeRanksResponse()),
      );
      const tournaments = parseEspnGolfResponse(scoreboard, rankings);

      // Parses both events
      expect(tournaments).toHaveLength(2);

      // Caps at MAX_COMPETITORS, excludes unranked, sorts by rank
      const masters = tournaments[0];
      expect(masters.espnId).toBe("401580337");
      expect(masters.name).toBe("The Masters");
      expect(masters.status).toBe("scheduled");
      expect(masters.competitors).toHaveLength(MAX_COMPETITORS);
      expect(masters.competitors[0]).toEqual({ espnId: "1", name: "Golfer 1" });
      expect(masters.competitors[9]).toEqual({ espnId: "10", name: "Golfer 10" });
      expect(masters.competitors.find((c) => c.name === "Unranked Amateur")).toBeUndefined();

      // Maps status correctly
      expect(tournaments[1].status).toBe("completed");
    }),
  );

  effectIt.effect("succeeds with valid HTTP responses", () =>
    Effect.gen(function* () {
      const adapter = yield* GolfAdapter;
      const tournaments = yield* adapter.getUpcomingTournaments;
      expect(tournaments).toHaveLength(1);
      expect(tournaments[0].name).toBe("The Masters");
      expect(tournaments[0].competitors).toHaveLength(MAX_COMPETITORS);
      expect(tournaments[0].competitors[0]).toEqual({ espnId: "1", name: "Golfer 1" });
    }).pipe(Effect.provide(GolfAdapter.Live), Effect.provide(makeHttpLayer(validRoutes))),
  );

  effectIt.effect("fails on ESPN API errors", () =>
    Effect.gen(function* () {
      const adapter = yield* GolfAdapter;

      // Scoreboard 500
      const r1 = yield* adapter.getUpcomingTournaments.pipe(Effect.flip);
      expect(r1).toBeInstanceOf(OracleError);
      expect(r1.message).toContain("HTTP 500");
    }).pipe(
      Effect.provide(GolfAdapter.Live),
      Effect.provide(
        makeHttpLayer({
          scoreboard: { status: 500, body: {} },
          "/dates/": { status: 200, body: makeRanksResponse() },
          "/rankings/": { status: 200, body: makeOwgrResponse() },
        }),
      ),
    ),
  );

  effectIt.effect("fails on malformed response body", () =>
    Effect.gen(function* () {
      const adapter = yield* GolfAdapter;
      const result = yield* adapter.getUpcomingTournaments.pipe(Effect.flip);
      expect(result).toBeInstanceOf(OracleError);
      expect(result.message).toContain("validation failed");
    }).pipe(
      Effect.provide(GolfAdapter.Live),
      Effect.provide(
        makeHttpLayer({
          scoreboard: { status: 200, body: { wrong: "shape" } },
          "/dates/": { status: 200, body: makeRanksResponse() },
          "/rankings/": { status: 200, body: makeOwgrResponse() },
        }),
      ),
    ),
  );
});
