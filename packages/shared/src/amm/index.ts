import type { AMMPool } from "../types/index.js";

export function initializePool(marketId: string, seedAmount: number): AMMPool {
  return {
    marketId,
    sharesA: seedAmount,
    sharesB: seedAmount,
    k: seedAmount * seedAmount,
    liquidity: seedAmount,
  };
}

export function calculateBuy(
  pool: AMMPool,
  outcome: "A" | "B",
  amount: number,
): { shares: number; newPool: AMMPool } {
  const [target, other] =
    outcome === "A" ? [pool.sharesA, pool.sharesB] : [pool.sharesB, pool.sharesA];

  const newOther = other + amount;
  const newTarget = pool.k / newOther;
  const swapOut = target - newTarget;

  const totalShares = amount + swapOut;

  const newPool: AMMPool = {
    marketId: pool.marketId,
    sharesA: outcome === "A" ? newTarget : newOther,
    sharesB: outcome === "A" ? newOther : newTarget,
    k: pool.k,
    liquidity: pool.liquidity + amount,
  };

  return { shares: totalShares, newPool };
}

export function calculatePrices(pool: AMMPool): { priceA: number; priceB: number } {
  const total = pool.sharesA + pool.sharesB;
  return {
    priceA: pool.sharesB / total,
    priceB: pool.sharesA / total,
  };
}

export function calculateOdds(pool: AMMPool): {
  priceA: number;
  priceB: number;
  multiplierA: number;
  multiplierB: number;
} {
  const { priceA, priceB } = calculatePrices(pool);
  return { priceA, priceB, multiplierA: 1 / priceA, multiplierB: 1 / priceB };
}
