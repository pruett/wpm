import { calculatePrices } from "@wpm/shared";
import type { ChainState } from "./state.js";
import { logger } from "./logger.js";

const TOTAL_SUPPLY = 10_000_000;
const PRICE_SUM_TOLERANCE = 0.0001;

type InvariantViolation = {
  id: string;
  message: string;
  critical: boolean;
};

export function checkPostBlockInvariants(state: ChainState): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // INV-1: Total supply conservation
  let totalBalances = 0;
  for (const balance of state.balances.values()) {
    totalBalances += balance;
  }
  let totalLocked = 0;
  for (const pool of state.pools.values()) {
    totalLocked += pool.wpmLocked;
  }
  const totalSupply = Math.round((totalBalances + totalLocked) * 100) / 100;
  if (totalSupply !== TOTAL_SUPPLY) {
    violations.push({
      id: "INV-1",
      message: `Total supply violation: sum(balances)=${totalBalances} + sum(wpmLocked)=${totalLocked} = ${totalSupply}, expected ${TOTAL_SUPPLY}`,
      critical: true,
    });
  }

  // INV-3: No negative balances
  for (const [address, balance] of state.balances) {
    if (balance < 0) {
      violations.push({
        id: "INV-3",
        message: `Negative balance: ${address} has ${balance}`,
        critical: false,
      });
    }
  }

  // INV-4: No negative shares
  for (const [address, byMarket] of state.sharePositions) {
    for (const [marketId, byOutcome] of byMarket) {
      for (const [outcome, position] of byOutcome) {
        if (position.shares < 0) {
          violations.push({
            id: "INV-4",
            message: `Negative shares: ${address} has ${position.shares} shares of ${outcome} in market ${marketId}`,
            critical: false,
          });
        }
      }
    }
  }

  return violations;
}

export function checkPoolKInvariant(
  previousK: number,
  newK: number,
  marketId: string,
): InvariantViolation | null {
  // INV-5: k only increases (fees add liquidity)
  if (newK < previousK) {
    return {
      id: "INV-5",
      message: `Pool k decreased: market ${marketId}, previous=${previousK}, new=${newK}`,
      critical: false,
    };
  }
  return null;
}

export function checkPriceSumInvariant(
  marketId: string,
  sharesA: number,
  sharesB: number,
): InvariantViolation | null {
  // INV-2: priceA + priceB === 1.00 within tolerance
  const prices = calculatePrices({ marketId, sharesA, sharesB, k: 0, wpmLocked: 0 });
  const sum = prices.priceA + prices.priceB;
  if (Number.isNaN(sum) || Math.abs(sum - 1.0) > PRICE_SUM_TOLERANCE) {
    return {
      id: "INV-2",
      message: `Price sum violation: market ${marketId}, priceA=${prices.priceA} + priceB=${prices.priceB} = ${sum}, expected 1.00 (tolerance ${PRICE_SUM_TOLERANCE})`,
      critical: false,
    };
  }
  return null;
}

export function handleViolations(violations: InvariantViolation[], blockIndex: number): void {
  for (const v of violations) {
    if (v.critical) {
      logger.error("critical invariant violation", { invariant: v.id, blockIndex, detail: v.message });
      throw new Error(`Critical invariant violation ${v.id}: ${v.message}`);
    }
    logger.warn("invariant violation", { invariant: v.id, blockIndex, detail: v.message });
  }
}
