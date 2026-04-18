import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { balances, transactions, treasury } from "@/lib/db/schema";

export type DistributeResult = { userId: string; newBalance: number };

export async function distributeTokens(userId: string, amount: number): Promise<DistributeResult> {
  const newBalance = db.transaction((tx) => {
    const t = tx.select().from(treasury).where(eq(treasury.id, "treasury")).get();
    if (!t) throw new Error("Treasury not seeded");
    if (t.amount < amount) throw new Error("Insufficient treasury balance");

    const bal = tx.select().from(balances).where(eq(balances.userId, userId)).get();
    const current = bal?.amount ?? 0;

    tx.update(treasury)
      .set({ amount: sql`${treasury.amount} - ${amount}` })
      .where(eq(treasury.id, "treasury"))
      .run();

    tx.insert(balances)
      .values({ userId, amount })
      .onConflictDoUpdate({
        target: balances.userId,
        set: { amount: sql`${balances.amount} + ${amount}` },
      })
      .run();

    const now = Date.now();
    tx.insert(transactions)
      .values({
        type: "Distribute",
        userId,
        payload: JSON.stringify({
          type: "Distribute",
          to: userId,
          amount,
          memo: "admin_distribute",
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      })
      .run();

    return current + amount;
  });

  return { userId, newBalance };
}
