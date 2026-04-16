import { cacheLife, cacheTag } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { balances } from "@/lib/db/schema";

export type BalanceData = {
  balance: number;
};

export async function getBalance(userId: string): Promise<BalanceData> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`viewer:${userId}`);

  const row = await db.query.balances.findFirst({
    where: eq(balances.userId, userId),
    columns: { amount: true },
  });

  return { balance: row?.amount ?? 0 };
}
