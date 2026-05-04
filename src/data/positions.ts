import "server-only";
import { and, eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import type { SharePosition, Sport } from "@/lib/types";

import { db } from "@/lib/db";
import { markets as marketsTable, positions, transactions } from "@/lib/db/schema";

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

export type BetHistoryEntry = {
  marketId: string;
  marketName: string;
  sport: Sport;
  outcomes: [string, string];
  closesAt: string;
  marketStatus: "open" | "resolved" | "cancelled";
  resolvedOutcome: "A" | "B" | null;
  resolvedAt: number | null;
  sharesA: number;
  sharesB: number;
  costBasis: number;
  settledAmount: number;
};

export async function getBetHistory(userId: string): Promise<BetHistoryEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.viewer(userId));

  const rows = await db
    .select({
      marketId: positions.marketId,
      sharesA: positions.sharesA,
      sharesB: positions.sharesB,
      costBasis: positions.costBasis,
      marketName: marketsTable.name,
      sport: marketsTable.sport,
      teamA: marketsTable.teamA,
      teamB: marketsTable.teamB,
      closesAt: marketsTable.closesAt,
      marketStatus: marketsTable.status,
      resolvedOutcome: marketsTable.resolvedOutcome,
      resolvedAt: marketsTable.resolvedAt,
    })
    .from(positions)
    .innerJoin(marketsTable, eq(marketsTable.id, positions.marketId))
    .where(eq(positions.userId, userId));

  const settlements = await db
    .select({ marketId: transactions.marketId, payload: transactions.payload })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.type, "SettlePayout")));

  const settledByMarket = new Map<string, number>();
  for (const s of settlements) {
    if (!s.marketId) continue;
    const parsed = JSON.parse(s.payload) as { amount?: number };
    if (typeof parsed.amount !== "number") continue;
    settledByMarket.set(s.marketId, (settledByMarket.get(s.marketId) ?? 0) + parsed.amount);
  }

  const result: BetHistoryEntry[] = [];
  for (const row of rows) {
    // Resolved/cancelled positions stay on the ledger at non-zero shares (ADR-0004),
    // so a zero-share row on an open market means the user has fully sold out — skip it.
    if (row.marketStatus === "open" && row.sharesA === 0n && row.sharesB === 0n) continue;

    result.push({
      marketId: row.marketId,
      marketName: row.marketName,
      sport: row.sport,
      outcomes: [row.teamA, row.teamB],
      closesAt: new Date(row.closesAt).toISOString(),
      marketStatus: row.marketStatus,
      resolvedOutcome: row.resolvedOutcome,
      resolvedAt: row.resolvedAt,
      sharesA: Number(row.sharesA),
      sharesB: Number(row.sharesB),
      costBasis: Number(row.costBasis),
      settledAmount: settledByMarket.get(row.marketId) ?? 0,
    });
  }

  return result;
}
