import type { AMMPool } from "./types";

const PROB_SCALE = 10_000n;
const MIN_PROB_BPS = 100n;
const MAX_PROB_BPS = PROB_SCALE - MIN_PROB_BPS;

export function initializePool(
  marketId: string,
  seedAmount: bigint,
  initialProbabilityA?: number,
): AMMPool {
  const raw = initialProbabilityA ?? 0.5;
  const probBps = clampProbBps(BigInt(Math.round(raw * Number(PROB_SCALE))));
  const total = 2n * seedAmount;
  const sharesA = (total * (PROB_SCALE - probBps)) / PROB_SCALE;
  const sharesB = total - sharesA;
  return {
    marketId,
    sharesA,
    sharesB,
    k: sharesA * sharesB,
    liquidity: seedAmount,
  };
}

export function calculateBuy(
  pool: AMMPool,
  outcome: "A" | "B",
  amount: bigint,
): { shares: bigint; newPool: AMMPool } {
  const [target, other] =
    outcome === "A" ? [pool.sharesA, pool.sharesB] : [pool.sharesB, pool.sharesA];

  const newOther = other + amount;
  // Round the pool's retained side UP so newTarget * newOther >= k.
  const newTarget = ceilDiv(pool.k, newOther);
  const swapOut = target - newTarget;
  const shares = amount + swapOut;

  const newSharesA = outcome === "A" ? newTarget : newOther;
  const newSharesB = outcome === "A" ? newOther : newTarget;

  const newPool: AMMPool = {
    marketId: pool.marketId,
    sharesA: newSharesA,
    sharesB: newSharesB,
    k: newSharesA * newSharesB,
    liquidity: pool.liquidity + amount,
  };

  return { shares, newPool };
}

export function calculateSell(
  pool: AMMPool,
  outcome: "A" | "B",
  sharesToSell: bigint,
): { wpmReturned: bigint; newPool: AMMPool } {
  const [target, other] =
    outcome === "A" ? [pool.sharesA, pool.sharesB] : [pool.sharesB, pool.sharesA];

  const P = target + sharesToSell;
  const Q = other;

  // Solve (P - w) * (Q - w) = k for w. Use floor isqrt and then nudge w down
  // until the invariant holds, so the pool's effective k only grows.
  const disc = (P - Q) * (P - Q) + 4n * pool.k;
  const sqrtDisc = isqrt(disc);
  let wpmReturned = (P + Q - sqrtDisc) / 2n;
  if (wpmReturned < 0n) wpmReturned = 0n;

  while (wpmReturned > 0n && (P - wpmReturned) * (Q - wpmReturned) < pool.k) {
    wpmReturned -= 1n;
  }

  const newTarget = P - wpmReturned;
  const newOther = Q - wpmReturned;
  const newSharesA = outcome === "A" ? newTarget : newOther;
  const newSharesB = outcome === "A" ? newOther : newTarget;

  const newPool: AMMPool = {
    marketId: pool.marketId,
    sharesA: newSharesA,
    sharesB: newSharesB,
    k: newSharesA * newSharesB,
    liquidity: pool.liquidity - wpmReturned,
  };

  return { wpmReturned, newPool };
}

export function calculatePrices(pool: AMMPool): { priceA: number; priceB: number } {
  const total = pool.sharesA + pool.sharesB;
  if (total === 0n) return { priceA: 0.5, priceB: 0.5 };
  const totalNum = Number(total);
  return {
    priceA: Number(pool.sharesB) / totalNum,
    priceB: Number(pool.sharesA) / totalNum,
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

export function isqrt(x: bigint): bigint {
  if (x < 0n) throw new Error("isqrt of negative");
  if (x < 2n) return x;
  let r = x;
  let s = (x + 1n) / 2n;
  while (s < r) {
    r = s;
    s = (s + x / s) / 2n;
  }
  return r;
}
