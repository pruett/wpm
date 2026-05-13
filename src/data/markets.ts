import "server-only";
import { eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import type { MarketWithOdds, MarketsResponse } from "@/lib/types";

import { calculateOdds, poolFromRow } from "@/lib/amm";
import { db } from "@/lib/db";
import {
  ammPools,
  events as eventsTable,
  markets as marketsTable,
  positions,
  user as userTable,
} from "@/lib/db/schema";

import { tags } from "./tags";

type MarketRow = typeof marketsTable.$inferSelect;
type EventRow = typeof eventsTable.$inferSelect;
type PoolRow = typeof ammPools.$inferSelect;
type PositionWithUser = typeof positions.$inferSelect & {
  user: typeof userTable.$inferSelect;
};
type MarketJoinedRow = MarketRow & {
  event: EventRow;
  pool: PoolRow;
  positions: PositionWithUser[];
};

function uniqueBettors(positions: PositionWithUser[]): MarketWithOdds["bettors"] {
  const bettors = new Map<string, MarketWithOdds["bettors"][number]>();
  for (const position of positions) {
    bettors.set(position.user.id, {
      id: position.user.id,
      name: position.user.name,
      color: position.user.color,
    });
  }
  return [...bettors.values()];
}

function toMarketWithOdds(row: MarketJoinedRow): MarketWithOdds {
  const bettors = uniqueBettors(row.positions);
  const base = {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    status: row.status,
    resolvedAs: row.resolvedAs,
    sport: row.event.sport,
    closesAt: new Date(row.event.closesAt).toISOString(),
    bettorCount: bettors.length,
    bettors,
  };

  if (row.status === "resolved") {
    const winYes = row.resolvedAs === "yes" ? 1 : 0;
    return { ...base, priceYes: winYes, multiplierYes: winYes > 0 ? 1 / winYes : 0 };
  }
  if (row.status === "cancelled") {
    return { ...base, priceYes: 0, multiplierYes: 0 };
  }
  const odds = calculateOdds(poolFromRow(row.pool));
  return { ...base, priceYes: odds.priceYes, multiplierYes: odds.multiplierYes };
}

export async function getMarket(id: string): Promise<MarketWithOdds> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.market(id));

  const row = await db.query.markets.findFirst({
    where: eq(marketsTable.id, id),
    with: { event: true, pool: true, positions: { with: { user: true } } },
  });

  if (!row || !row.pool) throw new Error(`Market ${id} not found`);

  return toMarketWithOdds(row);
}

export async function getMarkets(): Promise<MarketsResponse> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.marketsAll());

  const rows = await db.query.markets.findMany({
    with: { event: true, pool: true, positions: { with: { user: true } } },
  });

  const withPools = rows.filter((r): r is MarketJoinedRow => r.pool !== null);

  return { markets: withPools.map(toMarketWithOdds) };
}
