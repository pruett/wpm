"use server";

import { updateTag } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { calculateBuy, calculateOdds } from "@wpm/shared";
import { requireUser, type ActionResult } from "@/lib/auth";
import { db } from "@/lib/db";
import { ammPools, balances, markets, positions, transactions } from "@/lib/db/schema";
import { publish } from "@/lib/realtime/bus";

const PlaceBetInput = z.object({
  marketId: z.string().min(1),
  outcome: z.enum(["A", "B"]),
  amount: z.number().positive(),
});

export async function placeBet(input: z.input<typeof PlaceBetInput>): Promise<ActionResult> {
  const guard = await requireUser();
  if ("error" in guard) return guard;
  const userId = guard.session.user.id;

  const parsed = PlaceBetInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { marketId, outcome, amount } = parsed.data;

  try {
    const { newBalance, newReserveA, newReserveB, newLiquidity } = db.transaction((tx) => {
      const market = tx.select().from(markets).where(eq(markets.id, marketId)).get();
      if (!market) throw new Error("Market not found");
      if (market.status !== "open") throw new Error("Market is not open");
      if (Date.now() >= market.bettingClosesAt) throw new Error("Betting has closed");

      const bal = tx.select().from(balances).where(eq(balances.userId, userId)).get();
      const currentBalance = bal?.amount ?? 0;
      if (currentBalance < amount) throw new Error("Insufficient balance");

      const poolRow = tx.select().from(ammPools).where(eq(ammPools.marketId, marketId)).get();
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

      tx.update(balances)
        .set({ amount: sql`${balances.amount} - ${amount}` })
        .where(eq(balances.userId, userId))
        .run();

      tx.update(ammPools)
        .set({ reserveA, reserveB, wpmReserve: sql`${ammPools.wpmReserve} + ${amount}` })
        .where(eq(ammPools.marketId, marketId))
        .run();

      tx.insert(positions)
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
        })
        .run();

      const now = Date.now();
      tx.insert(transactions)
        .values({
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
        })
        .run();

      return {
        newBalance: currentBalance - amount,
        newReserveA: reserveA,
        newReserveB: reserveB,
        newLiquidity: poolRow.wpmReserve + amount,
      };
    });

    const odds = calculateOdds({
      marketId,
      sharesA: newReserveA,
      sharesB: newReserveB,
      k: newReserveA * newReserveB,
      liquidity: newLiquidity,
    });
    updateTag(`market:${marketId}`);
    updateTag(`viewer:${userId}`);

    publish({ type: "price:update", marketId, ...odds });
    publish({ type: "balance:update", userId, balance: newBalance });

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Bet failed" };
  }
}
