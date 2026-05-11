import type { AMMPool } from "./types";

const PROB_SCALE = 10_000n;
const MIN_PROB_BPS = 100n;
const MAX_PROB_BPS = PROB_SCALE - MIN_PROB_BPS;

export function initializePool(
  marketId: string,
  seedAmount: bigint,
  initialProbabilityYes?: number,
): AMMPool {
  const raw = initialProbabilityYes ?? 0.5;
  const probBps = clampProbBps(BigInt(Math.round(raw * Number(PROB_SCALE))));
  const total = 2n * seedAmount;
  const reserveYes = (total * (PROB_SCALE - probBps)) / PROB_SCALE;
  const reserveNo = total - reserveYes;
  return {
    marketId,
    reserveYes,
    reserveNo,
    k: reserveYes * reserveNo,
    liquidity: seedAmount,
  };
}

// YES-only buy under ADR-0007. The buyer deposits `amount` WPM; the NO-side
// reserve grows by that amount, and the YES-side reserve shrinks via the
// constant-product invariant. The buyer receives `amount + swapOut` YES shares.
export function calculateBuy(pool: AMMPool, amount: bigint): { shares: bigint; newPool: AMMPool } {
  const newReserveNo = pool.reserveNo + amount;
  // Round the pool's retained YES side UP so newReserveYes * newReserveNo >= k.
  const newReserveYes = ceilDiv(pool.k, newReserveNo);
  const swapOut = pool.reserveYes - newReserveYes;
  const shares = amount + swapOut;

  const newPool: AMMPool = {
    marketId: pool.marketId,
    reserveYes: newReserveYes,
    reserveNo: newReserveNo,
    k: newReserveYes * newReserveNo,
    liquidity: pool.liquidity + amount,
  };

  return { shares, newPool };
}

export function calculatePrices(pool: AMMPool): { priceA: number; priceB: number } {
  const total = pool.reserveYes + pool.reserveNo;
  if (total === 0n) return { priceA: 0.5, priceB: 0.5 };
  const totalNum = Number(total);
  return {
    priceA: Number(pool.reserveNo) / totalNum,
    priceB: Number(pool.reserveYes) / totalNum,
  };
}

export function calculateOdds(pool: AMMPool): {
  priceA: number;
  priceB: number;
  multiplierA: number;
  multiplierB: number;
} {
  const { priceA, priceB } = calculatePrices(pool);
  return {
    priceA,
    priceB,
    multiplierA: priceA > 0 ? 1 / priceA : 0,
    multiplierB: priceB > 0 ? 1 / priceB : 0,
  };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function clampProbBps(bps: bigint): bigint {
  if (bps < MIN_PROB_BPS) return MIN_PROB_BPS;
  if (bps > MAX_PROB_BPS) return MAX_PROB_BPS;
  return bps;
}
