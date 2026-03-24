import { describe, test, expect } from "vitest";
import { initializePool, calculateBuy, calculatePrices } from "../src/amm/index.js";

describe("AMM", () => {
  test("full CPMM lifecycle: buy, prices, and invariants", () => {
    const pool = initializePool("market-1", 1000);

    // -- Buy 100 WPM of outcome A --
    const { shares, newPool } = calculateBuy(pool, "A", 100);

    // Correct shares returned
    expect(shares).toBeCloseTo(190.91, 1);
    expect(shares).toBeGreaterThan(100);
    expect(shares).toBeLessThan(200);

    // Pool state updated
    expect(newPool.sharesB).toBe(1100);
    expect(newPool.sharesA).toBeCloseTo(909.09, 1);
    expect(newPool.liquidity).toBe(1100);

    // Prices shift toward bought outcome
    const prices = calculatePrices(newPool);
    expect(prices.priceA).toBeGreaterThan(0.5);
    expect(prices.priceB).toBeLessThan(0.5);

    // Invariant: prices always sum to 1
    expect(prices.priceA + prices.priceB).toBeCloseTo(1.0, 10);

    // Invariant: constant product k preserved
    expect(newPool.sharesA * newPool.sharesB).toBeCloseTo(pool.k, 4);

    // -- Multi-trade sweep: invariants hold across varied trades --
    let p = pool;
    const trades: Array<["A" | "B", number]> = [
      ["A", 100],
      ["B", 50],
      ["A", 200],
      ["B", 150],
      ["A", 75],
    ];
    for (const [outcome, amount] of trades) {
      const result = calculateBuy(p, outcome, amount);
      p = result.newPool;
      const pr = calculatePrices(p);
      expect(pr.priceA + pr.priceB).toBeCloseTo(1.0, 10);
      expect(p.sharesA * p.sharesB).toBeCloseTo(pool.k, 4);
    }
  });
});
