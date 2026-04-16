"use server";

import { updateTag } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAdmin, type ActionResult } from "@/lib/auth";
import { db } from "@/lib/db";
import { ammPools, balances, markets, positions, transactions, treasury } from "@/lib/db/schema";
import { publish } from "@/lib/realtime/bus";

const ResolveMarketInput = z.object({
  marketId: z.string().min(1),
  result: z.enum(["A", "B"]),
});

export async function resolveMarket(
  input: z.input<typeof ResolveMarketInput>,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if ("error" in guard) return guard;

  const parsed = ResolveMarketInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { marketId, result } = parsed.data;

  try {
    const paidUsers = db.transaction((tx) => {
      const market = tx.select().from(markets).where(eq(markets.id, marketId)).get();
      if (!market) throw new Error("Market not found");
      if (market.status === "resolved" || market.status === "cancelled") {
        throw new Error(`Market is already ${market.status}`);
      }

      const pool = tx.select().from(ammPools).where(eq(ammPools.marketId, marketId)).get();
      if (!pool) throw new Error("AMM pool missing");

      const winners = tx
        .select()
        .from(positions)
        .where(eq(positions.marketId, marketId))
        .all()
        .filter((p) => (result === "A" ? p.sharesA > 0 : p.sharesB > 0));

      const now = Date.now();
      let totalPaid = 0;
      const affected: { userId: string; newBalance: number }[] = [];

      // Each winning share pays 1 WPM.
      for (const p of winners) {
        const winningShares = result === "A" ? p.sharesA : p.sharesB;
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

      // Liquidity remainder returns to treasury.
      const liquidityRemainder = pool.wpmReserve - totalPaid;
      if (liquidityRemainder > 0) {
        tx.update(treasury)
          .set({ amount: sql`${treasury.amount} + ${liquidityRemainder}` })
          .where(eq(treasury.id, "treasury"))
          .run();
      }

      tx.update(ammPools).set({ wpmReserve: 0 }).where(eq(ammPools.marketId, marketId)).run();
      tx.update(markets)
        .set({ status: "resolved", resolvedOutcome: result, resolvedAt: now })
        .where(eq(markets.id, marketId))
        .run();

      tx.insert(transactions)
        .values({
          type: "ResolveMarket",
          marketId,
          payload: JSON.stringify({
            type: "ResolveMarket",
            marketId,
            result,
            timestamp: new Date(now).toISOString(),
          }),
          createdAt: now,
        })
        .run();

      return affected;
    });

    publish({ type: "market:resolved", marketId, result });
    for (const u of paidUsers) {
      publish({ type: "balance:update", userId: u.userId, balance: u.newBalance });
      updateTag(`viewer:${u.userId}`);
    }

    updateTag("markets");
    updateTag(`market:${marketId}`);
    updateTag("leaderboard");

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Resolve failed" };
  }
}
