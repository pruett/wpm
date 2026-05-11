import "server-only";
import { eq, sql } from "drizzle-orm";

import { calculateBuy, calculateOdds } from "@/lib/amm";
import { db } from "@/lib/db";
import { ammPools, balances, markets, positions, transactions } from "@/lib/db/schema";

import { requireUser } from "./auth";

export type Odds = {
  priceA: number;
  priceB: number;
  multiplierA: number;
  multiplierB: number;
};

export type PlaceBetInput = {
  marketId: string;
  amount: number;
};

export type PlaceBetResult = {
  userId: string;
  marketId: string;
  newBalance: number;
  odds: Odds;
};

// YES-only buy under the multi-outcome model (ADR-0007). Each Market is a
// binary YES/NO contract; users only ever buy YES on a Market. To bet
// against an outcome, buy YES on a sibling Market.
export async function placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
  const guard = await requireUser();
  if ("error" in guard) throw new Error(guard.error);
  const userId = guard.session.user.id;
  const { marketId } = input;
  const amount = BigInt(Math.trunc(input.amount));
  if (amount <= 0n) throw new Error("Amount must be positive");

  const { newBalance, newPool } = await db.transaction(async (tx) => {
    const [market] = await tx.select().from(markets).where(eq(markets.id, marketId));
    if (!market) throw new Error("Market not found");
    if (market.status !== "open") throw new Error("Market is not open");
    if (Date.now() >= market.closesAt) throw new Error("Betting has closed");

    const [bal] = await tx.select().from(balances).where(eq(balances.userId, userId));
    const currentBalance = bal?.amount ?? 0n;
    if (currentBalance < amount) throw new Error("Insufficient balance");

    const [poolRow] = await tx.select().from(ammPools).where(eq(ammPools.marketId, marketId));
    if (!poolRow) throw new Error("AMM pool missing");

    // Prefer YES-aligned columns when present (rows created by `createEvent`);
    // fall back to legacy A/B columns for pre-Slice-1 rows. Under the YES-first
    // mapping established in `createEvent`, A → YES, B → NO.
    const reserveYes = poolRow.reserveYes ?? poolRow.reserveA;
    const reserveNo = poolRow.reserveNo ?? poolRow.reserveB;

    // The legacy AMM still takes an outcome; A === YES, so we hardcode "A".
    // The dedicated YES-only `calculateBuy(pool, amount)` lands in Phase 1
    // when the AMM is rewritten.
    const { shares, newPool } = calculateBuy(
      {
        marketId,
        reserveYes,
        reserveNo,
        k: reserveYes * reserveNo,
        liquidity: poolRow.wpmReserve,
      },
      "A",
      amount,
    );

    await tx
      .update(balances)
      .set({ amount: sql`${balances.amount} - ${amount}` })
      .where(eq(balances.userId, userId));

    // Dual-write: keep legacy reserveA/B in sync with the new reserveYes/No
    // columns until the legacy columns are dropped in Phase 1.
    await tx
      .update(ammPools)
      .set({
        reserveA: newPool.reserveYes,
        reserveB: newPool.reserveNo,
        reserveYes: newPool.reserveYes,
        reserveNo: newPool.reserveNo,
        wpmReserve: sql`${ammPools.wpmReserve} + ${amount}`,
      })
      .where(eq(ammPools.marketId, marketId));

    await tx
      .insert(positions)
      .values({
        userId,
        marketId,
        sharesA: shares,
        sharesB: 0n,
        shares,
        costBasis: amount,
      })
      .onConflictDoUpdate({
        target: [positions.userId, positions.marketId],
        set: {
          sharesA: sql`${positions.sharesA} + ${shares}`,
          shares: sql`${positions.shares} + ${shares}`,
          costBasis: sql`${positions.costBasis} + ${amount}`,
        },
      });

    const now = Date.now();
    await tx.insert(transactions).values({
      type: "PlaceBet",
      userId,
      marketId,
      payload: JSON.stringify({
        type: "PlaceBet",
        marketId,
        amount: Number(amount),
        userId,
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });

    return {
      newBalance: currentBalance - amount,
      newPool,
    };
  });

  const odds = calculateOdds(newPool);

  return { userId, marketId, newBalance: Number(newBalance), odds };
}

// Legacy A/B placeBet retained for the pre-multi-outcome integration test
// (`tests/integration/bet-and-resolve.test.ts`). Phase 6 rewrites that test
// against the new placeBet shape and removes this adapter.
export type PlaceBetLegacyInput = {
  marketId: string;
  outcome: "A" | "B";
  amount: number;
};

export async function placeBetLegacy(input: PlaceBetLegacyInput): Promise<PlaceBetResult> {
  const guard = await requireUser();
  if ("error" in guard) throw new Error(guard.error);
  const userId = guard.session.user.id;
  const { marketId, outcome } = input;
  const amount = BigInt(Math.trunc(input.amount));
  if (amount <= 0n) throw new Error("Amount must be positive");

  const { newBalance, newPool } = await db.transaction(async (tx) => {
    const [market] = await tx.select().from(markets).where(eq(markets.id, marketId));
    if (!market) throw new Error("Market not found");
    if (market.status !== "open") throw new Error("Market is not open");
    if (Date.now() >= market.closesAt) throw new Error("Betting has closed");

    const [bal] = await tx.select().from(balances).where(eq(balances.userId, userId));
    const currentBalance = bal?.amount ?? 0n;
    if (currentBalance < amount) throw new Error("Insufficient balance");

    const [poolRow] = await tx.select().from(ammPools).where(eq(ammPools.marketId, marketId));
    if (!poolRow) throw new Error("AMM pool missing");

    const { shares, newPool } = calculateBuy(
      {
        marketId,
        reserveYes: poolRow.reserveA,
        reserveNo: poolRow.reserveB,
        k: poolRow.reserveA * poolRow.reserveB,
        liquidity: poolRow.wpmReserve,
      },
      outcome,
      amount,
    );

    await tx
      .update(balances)
      .set({ amount: sql`${balances.amount} - ${amount}` })
      .where(eq(balances.userId, userId));

    await tx
      .update(ammPools)
      .set({
        reserveA: newPool.reserveYes,
        reserveB: newPool.reserveNo,
        wpmReserve: sql`${ammPools.wpmReserve} + ${amount}`,
      })
      .where(eq(ammPools.marketId, marketId));

    await tx
      .insert(positions)
      .values({
        userId,
        marketId,
        sharesA: outcome === "A" ? shares : 0n,
        sharesB: outcome === "B" ? shares : 0n,
        costBasis: amount,
      })
      .onConflictDoUpdate({
        target: [positions.userId, positions.marketId],
        set: {
          sharesA:
            outcome === "A" ? sql`${positions.sharesA} + ${shares}` : sql`${positions.sharesA}`,
          sharesB:
            outcome === "B" ? sql`${positions.sharesB} + ${shares}` : sql`${positions.sharesB}`,
          costBasis: sql`${positions.costBasis} + ${amount}`,
        },
      });

    const now = Date.now();
    await tx.insert(transactions).values({
      type: "PlaceBet",
      userId,
      marketId,
      payload: JSON.stringify({
        type: "PlaceBet",
        marketId,
        outcome,
        amount: Number(amount),
        userId,
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });

    return {
      newBalance: currentBalance - amount,
      newPool,
    };
  });

  const odds = calculateOdds(newPool);

  return { userId, marketId, newBalance: Number(newBalance), odds };
}
