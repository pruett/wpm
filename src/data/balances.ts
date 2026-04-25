import "server-only";
import { eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import { db } from "@/lib/db";
import { balances } from "@/lib/db/schema";

import { tags } from "./tags";

export type BalanceData = { balance: number };

export async function getBalance(userId: string): Promise<BalanceData> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.viewer(userId));

  const row = await db.query.balances.findFirst({
    where: eq(balances.userId, userId),
    columns: { amount: true },
  });

  return { balance: row ? Number(row.amount) : 0 };
}
