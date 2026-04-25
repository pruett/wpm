import { describe, expect, it } from "vitest";

import {
  calculateBuy,
  calculateOdds,
  calculatePrices,
  calculateSell,
  initializePool,
  isqrt,
} from "./amm";

const MARKET = "m1";

describe("isqrt", () => {
  it("returns 0 and 1 correctly", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
  });

  it("returns the integer floor of sqrt for perfect squares", () => {
    expect(isqrt(4n)).toBe(2n);
    expect(isqrt(9n)).toBe(3n);
    expect(isqrt(10000n)).toBe(100n);
    expect(isqrt(1_000_000n)).toBe(1000n);
  });

  it("returns the integer floor of sqrt for non-squares", () => {
    expect(isqrt(2n)).toBe(1n);
    expect(isqrt(3n)).toBe(1n);
    expect(isqrt(8n)).toBe(2n);
    expect(isqrt(99n)).toBe(9n);
    expect(isqrt(10n ** 18n)).toBe(10n ** 9n);
  });

  it("throws on negative input", () => {
    expect(() => isqrt(-1n)).toThrow();
  });
});

describe("initializePool", () => {
  it("seeds a 50/50 pool symmetrically", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    expect(pool.sharesA).toBe(1000n);
    expect(pool.sharesB).toBe(1000n);
    expect(pool.liquidity).toBe(1000n);
    expect(pool.k).toBe(1_000_000n);
  });

  it("seeds skewed pools with fewer shares on the favored side", () => {
    const pool = initializePool(MARKET, 1000n, 0.7);
    // probA = 0.7 → sharesA < sharesB
    expect(pool.sharesA).toBeLessThan(pool.sharesB);
    expect(pool.sharesA + pool.sharesB).toBe(2000n);
  });

  it("clamps probabilities to [0.01, 0.99]", () => {
    const low = initializePool(MARKET, 1000n, 0);
    const high = initializePool(MARKET, 1000n, 1);
    expect(low.sharesA).toBeGreaterThan(0n);
    expect(low.sharesB).toBeGreaterThan(0n);
    expect(high.sharesA).toBeGreaterThan(0n);
    expect(high.sharesB).toBeGreaterThan(0n);
  });

  it("defaults to 0.5 when no probability is provided", () => {
    const pool = initializePool(MARKET, 500n);
    expect(pool.sharesA).toBe(500n);
    expect(pool.sharesB).toBe(500n);
  });
});

describe("calculateBuy", () => {
  it("preserves the constant product invariant (k never shrinks)", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, "A", 100n);
    expect(newPool.sharesA * newPool.sharesB).toBeGreaterThanOrEqual(pool.k);
  });

  it("increases priceA when A is bought (monotonicity)", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, "A", 200n);
    expect(calculatePrices(newPool).priceA).toBeGreaterThan(calculatePrices(pool).priceA);
  });

  it("credits liquidity by exactly the amount deposited", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, "A", 100n);
    expect(newPool.liquidity - pool.liquidity).toBe(100n);
  });

  it("rounds against the trader: shares received ≤ float-math fair value", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { shares } = calculateBuy(pool, "A", 100n);
    // Float math: newOther=1100, newTarget=1000000/1100=909.09..., swap=90.909..., total=190.909...
    const floatFair = 100 + (1000 - 1_000_000 / 1100);
    expect(Number(shares)).toBeLessThanOrEqual(floatFair + 1e-9);
  });

  it("handles extreme skew (p=0.99) without losing the invariant", () => {
    const pool = initializePool(MARKET, 1000n, 0.99);
    const { newPool } = calculateBuy(pool, "A", 500n);
    expect(newPool.sharesA * newPool.sharesB).toBeGreaterThanOrEqual(pool.k);
  });

  it("handles large trades relative to liquidity", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, "B", 10000n);
    expect(newPool.sharesA * newPool.sharesB).toBeGreaterThanOrEqual(pool.k);
    expect(newPool.sharesA).toBeGreaterThan(0n);
    expect(newPool.sharesB).toBeGreaterThan(0n);
  });
});

describe("calculateSell", () => {
  it("preserves the constant product invariant (k never shrinks)", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const bought = calculateBuy(pool, "A", 100n);
    const { newPool } = calculateSell(bought.newPool, "A", bought.shares);
    expect(newPool.sharesA * newPool.sharesB).toBeGreaterThanOrEqual(bought.newPool.k);
  });

  it("returns ≤ the original WPM across a buy-then-sell round trip", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const amount = 100n;
    const { shares, newPool: afterBuy } = calculateBuy(pool, "A", amount);
    const { wpmReturned } = calculateSell(afterBuy, "A", shares);
    expect(wpmReturned).toBeLessThanOrEqual(amount);
  });

  it("decreases pool liquidity by exactly wpmReturned", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const bought = calculateBuy(pool, "A", 100n);
    const { wpmReturned, newPool } = calculateSell(bought.newPool, "A", bought.shares);
    expect(bought.newPool.liquidity - newPool.liquidity).toBe(wpmReturned);
  });

  it("handles extreme skew sells without violating invariant", () => {
    const pool = initializePool(MARKET, 1000n, 0.01);
    const { shares, newPool: afterBuy } = calculateBuy(pool, "A", 50n);
    const { newPool } = calculateSell(afterBuy, "A", shares);
    expect(newPool.sharesA * newPool.sharesB).toBeGreaterThanOrEqual(afterBuy.k);
  });
});

describe("calculateOdds", () => {
  it("returns floats in [0, 1] that sum to 1", () => {
    const pool = initializePool(MARKET, 1000n, 0.7);
    const { priceA, priceB } = calculateOdds(pool);
    expect(priceA + priceB).toBeCloseTo(1, 10);
    expect(priceA).toBeGreaterThan(0);
    expect(priceB).toBeGreaterThan(0);
  });

  it("reflects the seeded probability", () => {
    const pool = initializePool(MARKET, 1000n, 0.7);
    const { priceA } = calculateOdds(pool);
    expect(priceA).toBeCloseTo(0.7, 2);
  });
});
