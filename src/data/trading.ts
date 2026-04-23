import "server-only";
import { and, eq, sql } from "drizzle-orm";

import { calculateBuy, calculateOdds, calculateSell } from "@/lib/amm";
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
  outcome: "A" | "B";
  amount: number;
};

export type PlaceBetResult = {
  userId: string;
  marketId: string;
  newBalance: number;
  odds: Odds;
};

export async function placeBet(input: PlaceBetInput): Promise<PlaceBetResult> {
  const guard = await requireUser();
  if ("error" in guard) throw new Error(guard.error);
  const userId = guard.session.user.id;
  const { marketId, outcome, amount } = input;

  const { newBalance, newReserveA, newReserveB, newLiquidity } = await db.transaction(
    async (tx) => {
      const [market] = await tx.select().from(markets).where(eq(markets.id, marketId));
      if (!market) throw new Error("Market not found");
      if (market.status !== "open") throw new Error("Market is not open");
      if (Date.now() >= market.closesAt) throw new Error("Betting has closed");

      const [bal] = await tx.select().from(balances).where(eq(balances.userId, userId));
      const currentBalance = bal?.amount ?? 0;
      if (currentBalance < amount) throw new Error("Insufficient balance");

      const [poolRow] = await tx.select().from(ammPools).where(eq(ammPools.marketId, marketId));
      if (!poolRow) throw new Error("AMM pool missing");

      const { shares, newPool } = calculateBuy(
        {
          marketId,
          sharesA: poolRow.reserveA,
          sharesB: poolRow.reserveB,
          k: poolRow.reserveA * poolRow.reserveB,
          liquidity: poolRow.wpmReserve,
        },
        outcome,
        amount,
      );
      const sharesInt = Math.round(shares);
      const reserveA = Math.round(newPool.sharesA);
      const reserveB = Math.round(newPool.sharesB);

      await tx
        .update(balances)
        .set({ amount: sql`${balances.amount} - ${amount}` })
        .where(eq(balances.userId, userId));

      await tx
        .update(ammPools)
        .set({ reserveA, reserveB, wpmReserve: sql`${ammPools.wpmReserve} + ${amount}` })
        .where(eq(ammPools.marketId, marketId));

      await tx
        .insert(positions)
        .values({
          userId,
          marketId,
          sharesA: outcome === "A" ? sharesInt : 0,
          sharesB: outcome === "B" ? sharesInt : 0,
          costBasis: amount,
        })
        .onConflictDoUpdate({
          target: [positions.userId, positions.marketId],
          set: {
            sharesA:
              outcome === "A"
                ? sql`${positions.sharesA} + ${sharesInt}`
                : sql`${positions.sharesA}`,
            sharesB:
              outcome === "B"
                ? sql`${positions.sharesB} + ${sharesInt}`
                : sql`${positions.sharesB}`,
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
          amount,
          userId,
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      });

      return {
        newBalance: currentBalance - amount,
        newReserveA: reserveA,
        newReserveB: reserveB,
        newLiquidity: poolRow.wpmReserve + amount,
      };
    },
  );

  const odds = calculateOdds({
    marketId,
    sharesA: newReserveA,
    sharesB: newReserveB,
    k: newReserveA * newReserveB,
    liquidity: newLiquidity,
  });

  return { userId, marketId, newBalance, odds };
}

export type SellSharesInput = {
  marketId: string;
  outcome: "A" | "B";
  shares: number;
};

export type SellSharesResult = PlaceBetResult;

export async function sellShares(input: SellSharesInput): Promise<SellSharesResult> {
  const guard = await requireUser();
  if ("error" in guard) throw new Error(guard.error);
  const userId = guard.session.user.id;
  const { marketId, outcome, shares } = input;

  const { newBalance, newReserveA, newReserveB, newLiquidity } = await db.transaction(
    async (tx) => {
      const [market] = await tx.select().from(markets).where(eq(markets.id, marketId));
      if (!market) throw new Error("Market not found");
      if (market.status !== "open") throw new Error("Market is not open");
      if (Date.now() >= market.closesAt) throw new Error("Betting has closed");

      const [pos] = await tx
        .select()
        .from(positions)
        .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)));
      if (!pos) throw new Error("No position in this market");

      const held = outcome === "A" ? pos.sharesA : pos.sharesB;
      if (held < shares) throw new Error("Insufficient shares");

      const [poolRow] = await tx.select().from(ammPools).where(eq(ammPools.marketId, marketId));
      if (!poolRow) throw new Error("AMM pool missing");

      const { wpmReturned, newPool } = calculateSell(
        {
          marketId,
          sharesA: poolRow.reserveA,
          sharesB: poolRow.reserveB,
          k: poolRow.reserveA * poolRow.reserveB,
          liquidity: poolRow.wpmReserve,
        },
        outcome,
        shares,
      );
      const wpmInt = Math.round(wpmReturned);
      const reserveA = Math.round(newPool.sharesA);
      const reserveB = Math.round(newPool.sharesB);

      const totalShares = pos.sharesA + pos.sharesB;
      const basisReduction =
        totalShares > 0 ? Math.round((pos.costBasis * shares) / totalShares) : 0;

      const [balRow] = await tx
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, userId));
      const currentBalance = balRow?.amount ?? 0;

      await tx
        .insert(balances)
        .values({ userId, amount: wpmInt })
        .onConflictDoUpdate({
          target: balances.userId,
          set: { amount: sql`${balances.amount} + ${wpmInt}` },
        });

      await tx
        .update(ammPools)
        .set({ reserveA, reserveB, wpmReserve: sql`${ammPools.wpmReserve} - ${wpmInt}` })
        .where(eq(ammPools.marketId, marketId));

      await tx
        .update(positions)
        .set({
          sharesA: outcome === "A" ? sql`${positions.sharesA} - ${shares}` : pos.sharesA,
          sharesB: outcome === "B" ? sql`${positions.sharesB} - ${shares}` : pos.sharesB,
          costBasis: Math.max(0, pos.costBasis - basisReduction),
        })
        .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)));

      const now = Date.now();
      await tx.insert(transactions).values({
        type: "SellShares",
        userId,
        marketId,
        payload: JSON.stringify({
          type: "SellShares",
          marketId,
          outcome,
          shares,
          userId,
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      });

      return {
        newBalance: currentBalance + wpmInt,
        newReserveA: reserveA,
        newReserveB: reserveB,
        newLiquidity: poolRow.wpmReserve - wpmInt,
      };
    },
  );

  const odds = calculateOdds({
    marketId,
    sharesA: newReserveA,
    sharesB: newReserveB,
    k: newReserveA * newReserveB,
    liquidity: newLiquidity,
  });

  return { userId, marketId, newBalance, odds };
}
