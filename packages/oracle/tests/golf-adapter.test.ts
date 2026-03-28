import { describe, expect } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import {
  parseEspnGolfResponse,
  buildRankingIndex,
  EspnGolfScoreboardResponse,
  EspnGolfRankingsResponse,
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

// Only ranks golfers 1–15, leaving "9999" unranked
const makeRankings = () => ({
  rankings: [
    {
      ranks: Array.from({ length: 15 }, (_, i) => ({ athlete: { id: `${i + 1}` } })),
    },
  ],
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
  rankings: { status: 200, body: makeRankings() },
};

describe("Golf Adapter", () => {
  effectIt.effect(
    "parses scoreboard and returns top-ranked competitors",
    () =>
      Effect.gen(function* () {
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
          Schema.decodeUnknownSync(EspnGolfRankingsResponse)(makeRankings()),
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
          rankings: { status: 200, body: makeRankings() },
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
          rankings: { status: 200, body: makeRankings() },
        }),
      ),
    ),
  );
});
