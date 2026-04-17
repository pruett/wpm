"use server";

import { updateTag } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAdmin, type ActionResult } from "@/lib/auth";
import { db } from "@/lib/db";
import { balances, transactions, treasury } from "@/lib/db/schema";
import { publish } from "@/lib/realtime/bus";

const DistributeInput = z.object({
  userId: z.string().min(1),
  amount: z.number().positive(),
});

export async function distributeTokens(
  input: z.input<typeof DistributeInput>,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if ("error" in guard) return guard;

  const parsed = DistributeInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { userId, amount } = parsed.data;

  try {
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

    updateTag("users");
    updateTag(`viewer:${userId}`);
    updateTag("leaderboard");

    publish({ type: "balance:update", userId, balance: newBalance });

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Distribution failed" };
  }
}
