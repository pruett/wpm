import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarketWithOdds } from "@wpm/shared";
import { fetchMarkets, placeBet } from "$lib/api.js";

const mockMarket: MarketWithOdds = {
  id: "market-1",
  name: "Eagles vs Chiefs",
  outcomes: ["Eagles", "Chiefs"] as [string, string],
  closesAt: "2026-02-09T23:00:00Z",
  status: "open",
  priceA: 0.55,
  priceB: 0.45,
  multiplierA: 1.82,
  multiplierB: 2.22,
  pool: {
    marketId: "market-1",
    sharesA: 4500,
    sharesB: 5500,
    k: 24750000,
    liquidity: 10000,
  },
};

describe("fetchMarkets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns typed MarketWithOdds[] from API", async () => {
    const mockResponse = [mockMarket];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const markets = await fetchMarkets();

    expect(markets).toEqual(mockResponse);
    expect(markets[0].priceA).toBe(0.55);
    expect(markets[0].pool.k).toBe(24750000);
    expect(fetch).toHaveBeenCalledWith("/api/markets");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(fetchMarkets()).rejects.toThrow("Failed to fetch markets: 500");
  });
});

describe("placeBet", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends bet to proxy endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      }),
    );

    await placeBet("m1", "A", 100);
    expect(fetch).toHaveBeenCalledWith("/api/bet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: "m1", outcome: "A", amount: 100 }),
    });
  });

  it("throws on failure with error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Insufficient balance" }),
      }),
    );

    await expect(placeBet("m1", "A", 999999)).rejects.toThrow("Insufficient balance");
  });
});
