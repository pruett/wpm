import "server-only";
import type { LeaderboardEntry } from "@wpm/shared";

import { desc, eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import { db } from "@/lib/db";
import { balances, user } from "@/lib/db/schema";

import { tags } from "./tags";

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.leaderboard());

  return db
    .select({ userId: user.id, name: user.name, balance: balances.amount })
    .from(user)
    .innerJoin(balances, eq(balances.userId, user.id))
    .orderBy(desc(balances.amount));
}
