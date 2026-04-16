"use server";

import { updateTag } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { calculateSell, calculateOdds } from "@wpm/shared";
import { requireUser, type ActionResult } from "@/lib/auth";
import { db } from "@/lib/db";
import { ammPools, balances, markets, positions, transactions } from "@/lib/db/schema";
import { publish } from "@/lib/realtime/bus";

const SellSharesInput = z.object({
  marketId: z.string().min(1),
  outcome: z.enum(["A", "B"]),
  shares: z.number().positive(),
});

export async function sellShares(input: z.input<typeof SellSharesInput>): Promise<ActionResult> {
  const guard = await requireUser();
  if ("error" in guard) return guard;
  const userId = guard.session.user.id;

  const parsed = SellSharesInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { marketId, outcome, shares } = parsed.data;

  try {
    const { newBalance, newReserveA, newReserveB, newLiquidity } = db.transaction((tx) => {
      const market = tx.select().from(markets).where(eq(markets.id, marketId)).get();
      if (!market) throw new Error("Market not found");
      if (market.status !== "open") throw new Error("Market is not open");
      if (Date.now() >= market.bettingClosesAt) throw new Error("Betting has closed");

      const pos = tx
        .select()
        .from(positions)
        .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)))
        .get();
      if (!pos) throw new Error("No position in this market");

      const held = outcome === "A" ? pos.sharesA : pos.sharesB;
      if (held < shares) throw new Error("Insufficient shares");

      const poolRow = tx.select().from(ammPools).where(eq(ammPools.marketId, marketId)).get();
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

      // Cost-basis reduced proportionally to the user's total shares in this market.
      const totalShares = pos.sharesA + pos.sharesB;
      const basisReduction =
        totalShares > 0 ? Math.round((pos.costBasis * shares) / totalShares) : 0;

      const currentBalance =
        tx
          .select({ amount: balances.amount })
          .from(balances)
          .where(eq(balances.userId, userId))
          .get()?.amount ?? 0;

      tx.insert(balances)
        .values({ userId, amount: wpmInt })
        .onConflictDoUpdate({
          target: balances.userId,
          set: { amount: sql`${balances.amount} + ${wpmInt}` },
        })
        .run();

      tx.update(ammPools)
        .set({ reserveA, reserveB, wpmReserve: sql`${ammPools.wpmReserve} - ${wpmInt}` })
        .where(eq(ammPools.marketId, marketId))
        .run();

      tx.update(positions)
        .set({
          sharesA: outcome === "A" ? sql`${positions.sharesA} - ${shares}` : pos.sharesA,
          sharesB: outcome === "B" ? sql`${positions.sharesB} - ${shares}` : pos.sharesB,
          costBasis: Math.max(0, pos.costBasis - basisReduction),
        })
        .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)))
        .run();

      const now = Date.now();
      tx.insert(transactions)
        .values({
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
        })
        .run();

      return {
        newBalance: currentBalance + wpmInt,
        newReserveA: reserveA,
        newReserveB: reserveB,
        newLiquidity: poolRow.wpmReserve - wpmInt,
      };
    });

    const odds = calculateOdds({
      marketId,
      sharesA: newReserveA,
      sharesB: newReserveB,
      k: newReserveA * newReserveB,
      liquidity: newLiquidity,
    });
    publish({ type: "price:update", marketId, ...odds });
    publish({ type: "balance:update", userId, balance: newBalance });

    updateTag(`market:${marketId}`);
    updateTag(`viewer:${userId}`);

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Sell failed" };
  }
}
