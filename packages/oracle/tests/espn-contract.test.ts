import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  EspnNflScoreboardResponse,
  EspnNflOddsResponse,
  ESPN_NFL_SCOREBOARD_URL,
  espnNflOddsUrl,
  extractOdds,
} from "../src/adapters/nfl.js";
import { EspnGolfScoreboardResponse, ESPN_GOLF_SCOREBOARD_URL } from "../src/adapters/golf.js";
import {
  EspnMlbScoreboardResponse,
  EspnMlbOddsResponse,
  ESPN_MLB_SCOREBOARD_URL,
  espnMlbOddsUrl,
  extractOdds as extractMlbOdds,
} from "../src/adapters/mlb.js";

const ENABLED = process.env.ESPN_CONTRACT_TESTS === "true";
const testIf = ENABLED ? it : it.skip;

describe("ESPN API contract", () => {
  testIf("NFL scoreboard → odds full chain resolves end-to-end", { timeout: 30_000 }, async () => {
    // Fetch scoreboard for 2025 Wild Card weekend
    const scoreboardRes = await fetch(`${ESPN_NFL_SCOREBOARD_URL}?dates=20250112`);
    expect(scoreboardRes.status).toBe(200);
    const scoreboard = Schema.decodeUnknownSync(EspnNflScoreboardResponse)(
      await scoreboardRes.json(),
    );
    expect(scoreboard.events.length).toBeGreaterThan(0);

    // Pick first event and fetch its odds
    const eventId = scoreboard.events[0].id;
    const oddsRes = await fetch(espnNflOddsUrl(eventId));
    expect(oddsRes.status).toBe(200);

    const oddsData = Schema.decodeUnknownSync(EspnNflOddsResponse)(await oddsRes.json());
    const odds = extractOdds(oddsData);
    expect(odds).toBeDefined();
    expect(typeof odds!.awayMoneyline).toBe("number");
    expect(typeof odds!.homeMoneyline).toBe("number");
  });

  testIf(
    "Golf scoreboard response matches our schema with order and score",
    { timeout: 15_000 },
    async () => {
      const res = await fetch(ESPN_GOLF_SCOREBOARD_URL);
      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = Schema.decodeUnknownSync(EspnGolfScoreboardResponse)(json);
      expect(parsed.events).toBeDefined();
      expect(Array.isArray(parsed.events)).toBe(true);

      // Verify competitors have order and score fields
      for (const event of parsed.events) {
        for (const comp of event.competitions[0].competitors) {
          expect(typeof comp.order).toBe("number");
          expect(typeof comp.score).toBe("string");
        }
      }
    },
  );

  testIf("MLB scoreboard → odds full chain resolves end-to-end", { timeout: 30_000 }, async () => {
    // Fetch scoreboard for 2024 World Series Game 1
    const scoreboardRes = await fetch(`${ESPN_MLB_SCOREBOARD_URL}?dates=20241025`);
    expect(scoreboardRes.status).toBe(200);
    const scoreboard = Schema.decodeUnknownSync(EspnMlbScoreboardResponse)(
      await scoreboardRes.json(),
    );
    expect(scoreboard.events.length).toBeGreaterThan(0);

    // Pick first event and fetch its odds
    const eventId = scoreboard.events[0].id;
    const oddsRes = await fetch(espnMlbOddsUrl(eventId));
    expect(oddsRes.status).toBe(200);

    const oddsData = Schema.decodeUnknownSync(EspnMlbOddsResponse)(await oddsRes.json());
    const odds = extractMlbOdds(oddsData);
    expect(odds).toBeDefined();
    expect(typeof odds!.awayMoneyline).toBe("number");
    expect(typeof odds!.homeMoneyline).toBe("number");
  });
});
