import type { AMMPool } from "../types/index.js";

export function calculatePrices(pool: AMMPool): {
  priceA: number;
  priceB: number;
} {
  const total = pool.sharesA + pool.sharesB;
  const priceA = pool.sharesB / total;
  const priceB = pool.sharesA / total;
  return { priceA, priceB };
}

export function initializePool(
  marketId: string,
  seedAmount: number,
): AMMPool {
  const half = seedAmount / 2;
  return {
    marketId,
    sharesA: half,
    sharesB: half,
    k: half * half,
    wpmLocked: seedAmount,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const FEE_RATE = 0.01;

type BuyResult = {
  sharesToUser: number;
  pool: AMMPool;
};

export function calculateBuy(
  pool: AMMPool,
  outcome: "A" | "B",
  amount: number,
): BuyResult {
  const fee = round2(amount * FEE_RATE);
  const netAmount = round2(amount - fee);

  // Step 1: Mint netAmount complete pairs
  let sharesA = pool.sharesA + netAmount;
  let sharesB = pool.sharesB + netAmount;

  // Step 2: Swap — user sells netAmount of the opposite side back to the pool
  let sharesToUser: number;
  if (outcome === "A") {
    // Sell netAmount B-shares back
    const poolBAfterSwap = sharesB + netAmount;
    const poolAFinal = round2((sharesA * sharesB) / poolBAfterSwap);
    const additionalA = round2(sharesA - poolAFinal);
    sharesToUser = round2(netAmount + additionalA);
    sharesA = poolAFinal;
    sharesB = poolBAfterSwap;
  } else {
    // Sell netAmount A-shares back
    const poolAAfterSwap = sharesA + netAmount;
    const poolBFinal = round2((sharesA * sharesB) / poolAAfterSwap);
    const additionalB = round2(sharesB - poolBFinal);
    sharesToUser = round2(netAmount + additionalB);
    sharesB = poolBFinal;
    sharesA = poolAAfterSwap;
  }

  // Step 3: Distribute fee equally to both sides
  sharesA = round2(sharesA + fee / 2);
  sharesB = round2(sharesB + fee / 2);

  return {
    sharesToUser,
    pool: {
      marketId: pool.marketId,
      sharesA,
      sharesB,
      k: round2(sharesA * sharesB),
      wpmLocked: round2(pool.wpmLocked + amount),
    },
  };
}
