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

  it("produces integer YES/NO reserves whose implied probability tracks the seed within one unit", () => {
    // The implied YES probability is reserveNo / (reserveYes + reserveNo).
    // Integer truncation of (total * (1 - p)) costs at most one unit, so the
    // implied probability differs from the requested one by at most 1 / total.
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const pool = initializePool(MARKET, 1000n, p);
      expect(pool.reserveYes + pool.reserveNo).toBe(2000n);
      const impliedYes = Number(pool.reserveNo) / Number(pool.reserveYes + pool.reserveNo);
      expect(Math.abs(impliedYes - p)).toBeLessThanOrEqual(1 / 2000);
    }
  });
});

describe("calculateBuy", () => {
  it("preserves the constant product invariant (k never shrinks)", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, 100n);
    expect(newPool.reserveYes * newPool.reserveNo).toBeGreaterThanOrEqual(pool.k);
  });

  it("increases priceYes when YES is bought (monotonicity)", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, 200n);
    expect(calculatePrices(newPool).priceYes).toBeGreaterThan(calculatePrices(pool).priceYes);
  });

  it("credits liquidity by exactly the amount deposited", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, 100n);
    expect(newPool.liquidity - pool.liquidity).toBe(100n);
  });

  it("rounds against the trader: shares received ≤ float-math fair value", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { shares } = calculateBuy(pool, 100n);
    // Float math: newReserveNo=1100, newReserveYes=1000000/1100=909.09..., swap=90.909..., total=190.909...
    const floatFair = 100 + (1000 - 1_000_000 / 1100);
    expect(Number(shares)).toBeLessThanOrEqual(floatFair + 1e-9);
  });

  it("handles extreme skew (p=0.99) without losing the invariant", () => {
    const pool = initializePool(MARKET, 1000n, 0.99);
    const { newPool } = calculateBuy(pool, 500n);
    expect(newPool.reserveYes * newPool.reserveNo).toBeGreaterThanOrEqual(pool.k);
  });

  it("handles large trades relative to liquidity", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, 10000n);
    expect(newPool.reserveYes * newPool.reserveNo).toBeGreaterThanOrEqual(pool.k);
    expect(newPool.reserveYes).toBeGreaterThan(0n);
    expect(newPool.reserveNo).toBeGreaterThan(0n);
  });

  it("does not under-pay or panic when the YES reserve is already at the floor", () => {
    // Seed at the maximum-clamped probability (0.99) so the YES reserve is at
    // its floor (~20 of 2000). Then sweep the remaining YES inventory with a
    // huge buy and make sure: (a) the trader still receives strictly more
    // shares than the deposit (i.e. the AMM honors the swap), (b) the new YES
    // reserve stays positive, and (c) the constant-product invariant holds.
    const pool = initializePool(MARKET, 1000n, 0.99);
    const startingYes = pool.reserveYes;
    expect(startingYes).toBeGreaterThan(0n);

    const { shares, newPool } = calculateBuy(pool, 100_000n);

    expect(shares).toBeGreaterThan(100_000n);
    expect(newPool.reserveYes).toBeGreaterThan(0n);
    expect(newPool.reserveYes).toBeLessThan(startingYes);
    expect(newPool.reserveYes * newPool.reserveNo).toBeGreaterThanOrEqual(pool.k);
  });
});

describe("calculatePrices", () => {
  it("returns priceYes + priceNo = 1 within float tolerance across seeded skews", () => {
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      const pool = initializePool(MARKET, 1000n, p);
      const { priceYes, priceNo } = calculatePrices(pool);
      expect(priceYes + priceNo).toBeCloseTo(1, 10);
    }
  });

  it("returns priceYes + priceNo = 1 after a trade shifts the reserves", () => {
    const pool = initializePool(MARKET, 1000n, 0.5);
    const { newPool } = calculateBuy(pool, 250n);
    const { priceYes, priceNo } = calculatePrices(newPool);
    expect(priceYes + priceNo).toBeCloseTo(1, 10);
    expect(priceYes).toBeGreaterThan(0.5);
  });
});

describe("calculateOdds", () => {
  it("returns floats in [0, 1] that sum to 1", () => {
    const pool = initializePool(MARKET, 1000n, 0.7);
    const { priceYes, priceNo } = calculateOdds(pool);
    expect(priceYes + priceNo).toBeCloseTo(1, 10);
    expect(priceYes).toBeGreaterThan(0);
    expect(priceNo).toBeGreaterThan(0);
  });

  it("reflects the seeded probability", () => {
    const pool = initializePool(MARKET, 1000n, 0.7);
    const { priceYes } = calculateOdds(pool);
    expect(priceYes).toBeCloseTo(0.7, 2);
  });
});
