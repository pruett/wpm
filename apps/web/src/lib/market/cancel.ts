import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ammPools, balances, markets, positions, transactions, treasury } from "@/lib/db/schema";
import { publish } from "@/lib/realtime/bus";
import { revalidateTag } from "next/cache";

export type CancelMarketResult = { cancelled: true } | { cancelled: false; reason: string };

export function cancelMarket(marketId: string, reason?: string): CancelMarketResult {
  const refundedUsers = db.transaction((tx) => {
    const market = tx.select().from(markets).where(eq(markets.id, marketId)).get();
    if (!market) return { cancelled: false, reason: "Market not found" } as const;

    if (market.status === "cancelled") return "already_cancelled" as const;
    if (market.status === "resolved") {
      return { cancelled: false, reason: "Market is already resolved" } as const;
    }

    const pool = tx.select().from(ammPools).where(eq(ammPools.marketId, marketId)).get();
    if (!pool) return { cancelled: false, reason: "AMM pool missing" } as const;

    const holders = tx
      .select()
      .from(positions)
      .where(eq(positions.marketId, marketId))
      .all()
      .filter((p) => p.sharesA > 0 || p.sharesB > 0);

    const now = Date.now();
    let totalRefunded = 0;
    const affected: { userId: string; newBalance: number }[] = [];

    for (const p of holders) {
      if (p.costBasis <= 0) continue;
      const prior =
        tx
          .select({ amount: balances.amount })
          .from(balances)
          .where(eq(balances.userId, p.userId))
          .get()?.amount ?? 0;

      tx.insert(balances)
        .values({ userId: p.userId, amount: p.costBasis })
        .onConflictDoUpdate({
          target: balances.userId,
          set: { amount: sql`${balances.amount} + ${p.costBasis}` },
        })
        .run();

      tx.insert(transactions)
        .values({
          type: "SettlePayout",
          userId: p.userId,
          marketId,
          payload: JSON.stringify({
            type: "SettlePayout",
            marketId,
            to: p.userId,
            shares: p.sharesA + p.sharesB,
            amount: p.costBasis,
            timestamp: new Date(now).toISOString(),
          }),
          createdAt: now,
        })
        .run();

      totalRefunded += p.costBasis;
      affected.push({ userId: p.userId, newBalance: prior + p.costBasis });
    }

    const liquidityRemainder = pool.wpmReserve - totalRefunded;
    if (liquidityRemainder > 0) {
      tx.update(treasury)
        .set({ amount: sql`${treasury.amount} + ${liquidityRemainder}` })
        .where(eq(treasury.id, "treasury"))
        .run();
    }

    tx.update(ammPools).set({ wpmReserve: 0 }).where(eq(ammPools.marketId, marketId)).run();
    tx.update(positions)
      .set({ sharesA: 0, sharesB: 0, costBasis: 0 })
      .where(eq(positions.marketId, marketId))
      .run();
    tx.update(markets)
      .set({ status: "cancelled", resolvedAt: now })
      .where(eq(markets.id, marketId))
      .run();

    tx.insert(transactions)
      .values({
        type: "CancelMarket",
        marketId,
        payload: JSON.stringify({
          type: "CancelMarket",
          marketId,
          reason: reason ?? "oracle_cancel",
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      })
      .run();

    return affected;
  });

  if (refundedUsers === "already_cancelled") return { cancelled: true };
  if (!Array.isArray(refundedUsers)) return refundedUsers;

  for (const u of refundedUsers) {
    publish({ type: "balance:update", userId: u.userId, balance: u.newBalance });
    revalidateTag(`viewer:${u.userId}`, "max");
  }
  revalidateTag("markets", "max");
  revalidateTag(`market:${marketId}`, "max");
  revalidateTag("leaderboard", "max");

  return { cancelled: true };
}
