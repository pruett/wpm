import { expect, test } from "@playwright/test";
import type { CreateMarketRequest, OracleMarket } from "@wpm/shared";
import { ORACLE_TOKEN } from "../../playwright.config";

const authHeaders = { authorization: `Bearer ${ORACLE_TOKEN}` };

test("oracle creates a market and it appears in the oracle market list", async ({ request }) => {
  const marketId = `e2e-market-${Date.now()}`;
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const bettingClosesAt = startTime;

  const payload: CreateMarketRequest = {
    id: marketId,
    sport: "nfl",
    name: "Packers @ Bears",
    teamA: "Green Bay Packers",
    teamB: "Chicago Bears",
    startTime,
    bettingClosesAt,
    seedAmount: 1000,
    reserveA: 500,
    reserveB: 500,
    wpmReserve: 1000,
  };

  const createRes = await request.post("/api/oracle/markets", {
    headers: authHeaders,
    data: payload,
  });
  expect(createRes.status()).toBe(201);
  expect(await createRes.json()).toEqual({ created: true });

  const listRes = await request.get("/api/oracle/markets", { headers: authHeaders });
  expect(listRes.ok()).toBe(true);

  const markets = (await listRes.json()) as OracleMarket[];
  const created = markets.find((m) => m.id === marketId);
  expect(created).toMatchObject({
    id: marketId,
    sport: "nfl",
    teamA: "Green Bay Packers",
    teamB: "Chicago Bears",
    status: "open",
  });

  const unauth = await request.get("/api/oracle/markets");
  expect(unauth.status()).toBe(401);
});
