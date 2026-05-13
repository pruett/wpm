import "server-only";
import { eq, sql } from "drizzle-orm";

import { calculateBuy, calculateOdds, poolFromRow } from "@/lib/amm";
import { db } from "@/lib/db";
import {
  ammPools,
  balances,
  events as eventsTable,
  markets,
  positions,
  transactions,
} from "@/lib/db/schema";

import { requireUser } from "./auth";
import { invalidate } from "./invalidate";
import { tags } from "./tags";

export type Odds = {
  priceYes: number;
  priceNo: number;
  multiplierYes: number;
  multiplierNo: number;
};

export type PlaceBetInput = {
  marketId: string;
  amount: number;
};

export type PlaceBetResult = {
  userId: string;
  marketId: string;
  eventId: string | null;
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

  const { newBalance, newPool, eventId } = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        marketStatus: markets.status,
        eventId: markets.eventId,
        closesAt: eventsTable.closesAt,
      })
      .from(markets)
      .innerJoin(eventsTable, eq(eventsTable.id, markets.eventId))
      .where(eq(markets.id, marketId));
    if (!row) throw new Error("Market not found");
    if (row.marketStatus !== "open") throw new Error("Market is not open");
    if (Date.now() >= row.closesAt) throw new Error("Betting has closed");

    const [bal] = await tx.select().from(balances).where(eq(balances.userId, userId));
    const currentBalance = bal?.amount ?? 0n;
    if (currentBalance < amount) throw new Error("Insufficient balance");

    const [poolRow] = await tx.select().from(ammPools).where(eq(ammPools.marketId, marketId));
    if (!poolRow) throw new Error("AMM pool missing");

    const { shares, newPool } = calculateBuy(poolFromRow(poolRow), amount);

    await tx
      .update(balances)
      .set({ amount: sql`${balances.amount} - ${amount}` })
      .where(eq(balances.userId, userId));

    await tx
      .update(ammPools)
      .set({
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
        shares,
        costBasis: amount,
      })
      .onConflictDoUpdate({
        target: [positions.userId, positions.marketId],
        set: {
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

    // Hints fire on COMMIT (Postgres queues NOTIFY until the tx commits). A
    // rolled-back placeBet emits nothing.
    await invalidate(tags.market(marketId), tx);
    await invalidate(tags.event(row.eventId), tx);
    await invalidate(tags.viewer(userId), tx);

    return {
      newBalance: currentBalance - amount,
      newPool,
      eventId: row.eventId,
    };
  });

  const odds = calculateOdds(newPool);

  return { userId, marketId, eventId, newBalance: Number(newBalance), odds };
}
