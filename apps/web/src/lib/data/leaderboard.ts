import { cacheLife, cacheTag } from "next/cache";
import { desc, eq } from "drizzle-orm";
import type { LeaderboardEntry } from "@wpm/shared";
import { db } from "@/lib/db";
import { balances, user } from "@/lib/db/schema";

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("leaderboard");

  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      balance: balances.amount,
    })
    .from(user)
    .innerJoin(balances, eq(balances.userId, user.id))
    .orderBy(desc(balances.amount));

  return rows;
}
