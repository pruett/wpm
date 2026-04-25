import "server-only";
import { eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import type { SharePosition } from "@/lib/types";

import { db } from "@/lib/db";
import { markets as marketsTable, positions } from "@/lib/db/schema";

import { tags } from "./tags";

export async function getPositions(userId: string): Promise<SharePosition[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.viewer(userId));

  const rows = await db
    .select({
      userId: positions.userId,
      marketId: positions.marketId,
      sharesA: positions.sharesA,
      sharesB: positions.sharesB,
      costBasis: positions.costBasis,
      status: marketsTable.status,
    })
    .from(positions)
    .innerJoin(marketsTable, eq(marketsTable.id, positions.marketId))
    .where(eq(positions.userId, userId));

  const result: SharePosition[] = [];
  for (const row of rows) {
    if (row.status !== "open") continue;

    const total = row.sharesA + row.sharesB;
    if (total === 0n) continue;

    const basisA = (row.costBasis * row.sharesA) / total;
    const basisB = row.costBasis - basisA;

    if (row.sharesA > 0n) {
      result.push({
        userId: row.userId,
        marketId: row.marketId,
        outcome: "A",
        shares: Number(row.sharesA),
        costBasis: Number(basisA),
      });
    }
    if (row.sharesB > 0n) {
      result.push({
        userId: row.userId,
        marketId: row.marketId,
        outcome: "B",
        shares: Number(row.sharesB),
        costBasis: Number(basisB),
      });
    }
  }
  return result;
}
