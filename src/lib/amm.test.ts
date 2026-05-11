import { describe, expect, it } from "vitest";

import { calculateBuy, calculateOdds, calculatePrices, initializePool } from "./amm";

const MARKET = "m1";

describe("initializePool", () => {
  it("seeds a 50/50 pool symmetrically", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    expect(pool.reserveYes).toBe(1000n);
    expect(pool.reserveNo).toBe(1000n);
    expect(pool.liquidity).toBe(1000n);
    expect(pool.k).toBe(1_000_000n);
  });

  it("seeds skewed pools with fewer YES shares when YES is favored", () => {
    const pool = initializePool(MARKET, 1000n, 0.7);
    // priceYes = reserveNo/total → favoring YES (0.7) means reserveYes < reserveNo.
    expect(pool.reserveYes).toBeLessThan(pool.reserveNo);
    expect(pool.reserveYes + pool.reserveNo).toBe(2000n);
  });

  it("clamps probabilities to [0.01, 0.99]", () => {
    const low = initializePool(MARKET, 1000n, 0);
    const high = initializePool(MARKET, 1000n, 1);
    expect(low.reserveYes).toBeGreaterThan(0n);
    expect(low.reserveNo).toBeGreaterThan(0n);
    expect(high.reserveYes).toBeGreaterThan(0n);
    expect(high.reserveNo).toBeGreaterThan(0n);
  });

  it("defaults to 0.5 when no probability is provided", () => {
    const pool = initializePool(MARKET, 500n);
    expect(pool.reserveYes).toBe(500n);
    expect(pool.reserveNo).toBe(500n);
  });
});

describe("calculateBuy", () => {
  it("preserves the constant product invariant (k never shrinks)", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, "A", 100n);
    expect(newPool.reserveYes * newPool.reserveNo).toBeGreaterThanOrEqual(pool.k);
  });

  it("increases priceA (YES price) when A is bought (monotonicity)", () => {
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
    expect(newPool.reserveYes * newPool.reserveNo).toBeGreaterThanOrEqual(pool.k);
  });

  it("handles large trades relative to liquidity", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, "B", 10000n);
    expect(newPool.reserveYes * newPool.reserveNo).toBeGreaterThanOrEqual(pool.k);
    expect(newPool.reserveYes).toBeGreaterThan(0n);
    expect(newPool.reserveNo).toBeGreaterThan(0n);
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
