import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EspnNflScoreboardResponse } from "../src/adapters/nfl.js";
import { EspnGolfScoreboardResponse, EspnGolfRankingsResponse } from "../src/adapters/golf.js";

const ESPN_NFL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const ESPN_GOLF_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";
const ESPN_GOLF_RANKINGS =
  "https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/rankings";

const ENABLED = process.env.ESPN_CONTRACT_TESTS === "true";
const testIf = ENABLED ? it : it.skip;

describe("ESPN API contract", () => {
  testIf("NFL scoreboard response matches our schema", { timeout: 15_000 }, async () => {
    const res = await fetch(ESPN_NFL_SCOREBOARD);
    expect(res.status).toBe(200);
    const json = await res.json();
    const parsed = Schema.decodeUnknownSync(EspnNflScoreboardResponse)(json);
    expect(parsed.events).toBeDefined();
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  testIf("Golf scoreboard response matches our schema", { timeout: 15_000 }, async () => {
    const res = await fetch(ESPN_GOLF_SCOREBOARD);
    expect(res.status).toBe(200);
    const json = await res.json();
    const parsed = Schema.decodeUnknownSync(EspnGolfScoreboardResponse)(json);
    expect(parsed.events).toBeDefined();
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  testIf("Golf rankings response matches our schema", { timeout: 15_000 }, async () => {
    const res = await fetch(ESPN_GOLF_RANKINGS);
    expect(res.status).toBe(200);
    const json = await res.json();
    const parsed = Schema.decodeUnknownSync(EspnGolfRankingsResponse)(json);
    expect(parsed.rankings).toBeDefined();
    expect(parsed.rankings.length).toBeGreaterThan(0);
    expect(parsed.rankings[0].ranks.length).toBeGreaterThan(0);
  });
});
