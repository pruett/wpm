import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { eq } from "drizzle-orm";
import type { SharePosition } from "@wpm/shared";
import { db } from "@/lib/db";
import { positions } from "@/lib/db/schema";
import { tags } from "./tags";

export async function getPositions(userId: string): Promise<SharePosition[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.viewer(userId));

  const rows = await db.query.positions.findMany({
    where: eq(positions.userId, userId),
  });

  const result: SharePosition[] = [];
  for (const row of rows) {
    const total = row.sharesA + row.sharesB;
    if (total === 0) continue;

    const basisA = Math.round((row.costBasis * row.sharesA) / total);
    const basisB = row.costBasis - basisA;

    if (row.sharesA > 0) {
      result.push({
        userId: row.userId,
        marketId: row.marketId,
        outcome: "A",
        shares: row.sharesA,
        costBasis: basisA,
      });
    }
    if (row.sharesB > 0) {
      result.push({
        userId: row.userId,
        marketId: row.marketId,
        outcome: "B",
        shares: row.sharesB,
        costBasis: basisB,
      });
    }
  }
  return result;
}
