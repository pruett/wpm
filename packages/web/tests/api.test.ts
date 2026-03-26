import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarketWithOdds } from "@wpm/shared";
import { fetchMarkets, register, fetchBalance, fetchPositions, placeBet } from "$lib/api.js";

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

describe("register", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends name and returns token, address, balance", async () => {
    const regResponse = { token: "tok-123", address: "addr-abc", balance: 100000 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(regResponse),
      }),
    );

    const result = await register("Alice");
    expect(result).toEqual(regResponse);
    expect(fetch).toHaveBeenCalledWith("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
  });

  it("throws on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Name required" }),
      }),
    );

    await expect(register("")).rejects.toThrow("Name required");
  });
});

describe("fetchBalance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns balance number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ balance: 99000 }),
      }),
    );

    const balance = await fetchBalance();
    expect(balance).toBe(99000);
  });
});

describe("placeBet", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends bet with auth header and waits for balance change", async () => {
    // Set up auth state
    const { auth } = await import("$lib/stores/auth.svelte.js");
    auth.login("test-token", "test-addr");

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (url === "/api/balance") {
          // First balance call returns 1000 (before bet), second returns 900 (after block)
          const bal = callCount <= 1 ? 1000 : 900;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ balance: bal }),
          });
        }
        // POST /api/bet
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }),
    );

    await placeBet("m1", "A", 100);
    expect(fetch).toHaveBeenCalledWith("/api/bet", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ marketId: "m1", outcome: "A", amount: 100 }),
    });

    auth.logout();
  });
});
