import { describe, test, expect } from "vitest";
import { initializePool, calculateBuy, calculateSell, calculatePrices } from "../src/amm/index.js";

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

  test("calculateSell: returns correct WPM and preserves k", () => {
    const pool = initializePool("market-1", 1000);

    // Buy 100 WPM of A first to create shares
    const { shares, newPool: poolAfterBuy } = calculateBuy(pool, "A", 100);

    // Sell half the shares back
    const halfShares = shares / 2;
    const { wpmReturned, newPool: poolAfterSell } = calculateSell(poolAfterBuy, "A", halfShares);

    // WPM returned is positive
    expect(wpmReturned).toBeGreaterThan(0);

    // Constant product preserved
    expect(poolAfterSell.sharesA * poolAfterSell.sharesB).toBeCloseTo(pool.k, 4);

    // Prices sum to 1.0
    const prices = calculatePrices(poolAfterSell);
    expect(prices.priceA + prices.priceB).toBeCloseTo(1.0, 10);

    // Prices shifted back toward 50/50 (but not all the way — only sold half)
    expect(prices.priceA).toBeGreaterThan(0.5);
    expect(prices.priceA).toBeLessThan(calculatePrices(poolAfterBuy).priceA);
  });

  test("full buy-sell round trip: AMM is reversible", () => {
    const pool = initializePool("market-1", 1000);

    // Buy 100 WPM of A
    const { shares, newPool: poolAfterBuy } = calculateBuy(pool, "A", 100);

    // Sell ALL shares back
    const { wpmReturned, newPool: poolAfterSell } = calculateSell(poolAfterBuy, "A", shares);

    // Full roundtrip returns exactly what was put in (no fees in this AMM)
    expect(wpmReturned).toBeCloseTo(100, 6);

    // Pool returns to original state
    expect(poolAfterSell.sharesA).toBeCloseTo(pool.sharesA, 6);
    expect(poolAfterSell.sharesB).toBeCloseTo(pool.sharesB, 6);
    expect(poolAfterSell.liquidity).toBeCloseTo(pool.liquidity, 6);

    // k preserved
    expect(poolAfterSell.sharesA * poolAfterSell.sharesB).toBeCloseTo(pool.k, 4);
  });
});
