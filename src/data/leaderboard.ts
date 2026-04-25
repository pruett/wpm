import "server-only";
import { desc, eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import type { LeaderboardEntry } from "@/lib/types";

import { db } from "@/lib/db";
import { balances, user } from "@/lib/db/schema";

import { tags } from "./tags";

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.leaderboard());

  const rows = await db
    .select({ userId: user.id, name: user.name, balance: balances.amount })
    .from(user)
    .innerJoin(balances, eq(balances.userId, user.id))
    .orderBy(desc(balances.amount));

  return rows.map((r) => ({ userId: r.userId, name: r.name, balance: Number(r.balance) }));
}
