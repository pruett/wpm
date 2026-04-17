import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ammPools, balances, markets, positions, transactions, treasury } from "@/lib/db/schema";
import { publish } from "@/lib/realtime/bus";
import { revalidateTag } from "next/cache";

export type ResolveMarketResult = { resolved: true } | { resolved: false; reason: string };

export function resolveMarket(marketId: string, outcome: "A" | "B"): ResolveMarketResult {
  const paidUsers = db.transaction((tx) => {
    const market = tx.select().from(markets).where(eq(markets.id, marketId)).get();
    if (!market) return { resolved: false, reason: "Market not found" } as const;

    if (market.status === "resolved") {
      if (market.resolvedOutcome === outcome) return "already_resolved" as const;
      return { resolved: false, reason: "Market already resolved with different outcome" } as const;
    }
    if (market.status === "cancelled") {
      return { resolved: false, reason: "Market is cancelled" } as const;
    }

    const pool = tx.select().from(ammPools).where(eq(ammPools.marketId, marketId)).get();
    if (!pool) return { resolved: false, reason: "AMM pool missing" } as const;

    const winners = tx
      .select()
      .from(positions)
      .where(eq(positions.marketId, marketId))
      .all()
      .filter((p) => (outcome === "A" ? p.sharesA > 0 : p.sharesB > 0));

    const now = Date.now();
    let totalPaid = 0;
    const affected: { userId: string; newBalance: number }[] = [];

    for (const p of winners) {
      const winningShares = outcome === "A" ? p.sharesA : p.sharesB;
      const payout = winningShares;
      if (payout <= 0) continue;

      const prior =
        tx
          .select({ amount: balances.amount })
          .from(balances)
          .where(eq(balances.userId, p.userId))
          .get()?.amount ?? 0;

      tx.insert(balances)
        .values({ userId: p.userId, amount: payout })
        .onConflictDoUpdate({
          target: balances.userId,
          set: { amount: sql`${balances.amount} + ${payout}` },
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
            shares: winningShares,
            amount: payout,
            timestamp: new Date(now).toISOString(),
          }),
          createdAt: now,
        })
        .run();

      totalPaid += payout;
      affected.push({ userId: p.userId, newBalance: prior + payout });
    }

    const liquidityRemainder = pool.wpmReserve - totalPaid;
    if (liquidityRemainder > 0) {
      tx.update(treasury)
        .set({ amount: sql`${treasury.amount} + ${liquidityRemainder}` })
        .where(eq(treasury.id, "treasury"))
        .run();
    }

    tx.update(ammPools).set({ wpmReserve: 0 }).where(eq(ammPools.marketId, marketId)).run();
    tx.update(markets)
      .set({ status: "resolved", resolvedOutcome: outcome, resolvedAt: now })
      .where(eq(markets.id, marketId))
      .run();

    tx.insert(transactions)
      .values({
        type: "ResolveMarket",
        marketId,
        payload: JSON.stringify({
          type: "ResolveMarket",
          marketId,
          result: outcome,
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      })
      .run();

    return affected;
  });

  if (paidUsers === "already_resolved") return { resolved: true };
  if (!Array.isArray(paidUsers)) return paidUsers;

  publish({ type: "market:resolved", marketId, result: outcome });
  for (const u of paidUsers) {
    publish({ type: "balance:update", userId: u.userId, balance: u.newBalance });
    revalidateTag(`viewer:${u.userId}`, "max");
  }
  revalidateTag("markets", "max");
  revalidateTag(`market:${marketId}`, "max");
  revalidateTag("leaderboard", "max");

  return { resolved: true };
}
