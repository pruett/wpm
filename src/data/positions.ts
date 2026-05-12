import "server-only";
import { and, eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import type { SharePosition, Sport } from "@/lib/types";

import { db } from "@/lib/db";
import {
  events as eventsTable,
  markets as marketsTable,
  positions,
  transactions,
} from "@/lib/db/schema";

import { tags } from "./tags";

export async function getPositions(userId: string): Promise<SharePosition[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.viewer(userId));

  const rows = await db
    .select({
      userId: positions.userId,
      marketId: positions.marketId,
      shares: positions.shares,
      costBasis: positions.costBasis,
      status: marketsTable.status,
    })
    .from(positions)
    .innerJoin(marketsTable, eq(marketsTable.id, positions.marketId))
    .where(and(eq(positions.userId, userId), eq(marketsTable.status, "open")));

  const result: SharePosition[] = [];
  for (const row of rows) {
    if (row.shares === 0n) continue;
    result.push({
      userId: row.userId,
      marketId: row.marketId,
      shares: Number(row.shares),
      costBasis: Number(row.costBasis),
    });
  }
  return result;
}

export type BetHistoryEntry = {
  marketId: string;
  marketName: string;
  sport: Sport;
  closesAt: string;
  marketStatus: "open" | "resolved" | "cancelled";
  resolvedAs: "yes" | "no" | null;
  resolvedAt: number | null;
  shares: number;
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
      shares: positions.shares,
      costBasis: positions.costBasis,
      marketName: marketsTable.name,
      marketStatus: marketsTable.status,
      resolvedAs: marketsTable.resolvedAs,
      resolvedAt: marketsTable.resolvedAt,
      sport: eventsTable.sport,
      closesAt: eventsTable.closesAt,
    })
    .from(positions)
    .innerJoin(marketsTable, eq(marketsTable.id, positions.marketId))
    .innerJoin(eventsTable, eq(eventsTable.id, marketsTable.eventId))
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
    if (row.marketStatus === "open" && row.shares === 0n) continue;

    result.push({
      marketId: row.marketId,
      marketName: row.marketName,
      sport: row.sport,
      closesAt: new Date(row.closesAt).toISOString(),
      marketStatus: row.marketStatus,
      resolvedAs: row.resolvedAs,
      resolvedAt: row.resolvedAt,
      shares: Number(row.shares),
      costBasis: Number(row.costBasis),
      settledAmount: settledByMarket.get(row.marketId) ?? 0,
    });
  }

  return result;
}
