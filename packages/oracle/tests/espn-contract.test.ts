import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EspnNflScoreboardResponse, ESPN_NFL_SCOREBOARD_URL } from "../src/adapters/nfl.js";
import {
  EspnGolfScoreboardResponse,
  EspnGolfOwgrResponse,
  EspnGolfRanksResponse,
  ESPN_GOLF_SCOREBOARD_URL,
  espnGolfOwgrUrl,
} from "../src/adapters/golf.js";

const ENABLED = process.env.ESPN_CONTRACT_TESTS === "true";
const testIf = ENABLED ? it : it.skip;

describe("ESPN API contract", () => {
  testIf("NFL scoreboard response matches our schema", { timeout: 15_000 }, async () => {
    const res = await fetch(ESPN_NFL_SCOREBOARD_URL);
    expect(res.status).toBe(200);
    const json = await res.json();
    const parsed = Schema.decodeUnknownSync(EspnNflScoreboardResponse)(json);
    expect(parsed.events).toBeDefined();
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  testIf("Golf scoreboard response matches our schema", { timeout: 15_000 }, async () => {
    const res = await fetch(ESPN_GOLF_SCOREBOARD_URL);
    expect(res.status).toBe(200);
    const json = await res.json();
    const parsed = Schema.decodeUnknownSync(EspnGolfScoreboardResponse)(json);
    expect(parsed.events).toBeDefined();
    expect(Array.isArray(parsed.events)).toBe(true);
  });

  testIf("Golf OWGR → ranks → athlete chain resolves end-to-end", { timeout: 15_000 }, async () => {
    // Step 1: OWGR ranking type returns weekly date refs
    const owgrRes = await fetch(espnGolfOwgrUrl(new Date().getFullYear()));
    expect(owgrRes.status).toBe(200);
    const owgr = Schema.decodeUnknownSync(EspnGolfOwgrResponse)(await owgrRes.json());
    expect(owgr.type).toBe("WORLDRANK");
    expect(owgr.rankings.length).toBeGreaterThan(0);
    expect(owgr.rankings[0].$ref).toContain("/dates/");

    // Step 2: Latest date ref returns ranked athletes
    const latestDateRef = owgr.rankings[0].$ref;
    const ranksUrl = latestDateRef.includes("?")
      ? `${latestDateRef}&limit=1`
      : `${latestDateRef}?limit=1`;
    const ranksRes = await fetch(ranksUrl);
    expect(ranksRes.status).toBe(200);
    const ranks = Schema.decodeUnknownSync(EspnGolfRanksResponse)(await ranksRes.json());
    expect(ranks.ranks.length).toBeGreaterThan(0);
    expect(ranks.ranks[0].current).toBe(1);
    expect(ranks.ranks[0].athlete.$ref).toMatch(/\/athletes\/\d+/);

    // Step 3: Athlete $ref resolves to a profile with id and displayName
    const athleteRes = await fetch(ranks.ranks[0].athlete.$ref);
    expect(athleteRes.status).toBe(200);
    const athlete = await athleteRes.json();
    expect(typeof athlete.id).toBe("string");
    expect(typeof athlete.displayName).toBe("string");
    expect(athlete.displayName.length).toBeGreaterThan(0);
  });
});
