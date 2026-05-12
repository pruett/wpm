import "server-only";
import { eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import type { AMMPool, Market, MarketWithOdds, MarketsResponse } from "@/lib/types";

import { calculateOdds } from "@/lib/amm";
import { db } from "@/lib/db";
import { ammPools, markets as marketsTable, positions, user as userTable } from "@/lib/db/schema";

import { tags } from "./tags";

type MarketRow = typeof marketsTable.$inferSelect;
type PoolRow = typeof ammPools.$inferSelect;
type PositionWithUser = typeof positions.$inferSelect & {
  user: typeof userTable.$inferSelect;
};

function toMarket(row: MarketRow): Market {
  return {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    sport: row.sport,
    outcomes: [row.teamA, row.teamB],
    closesAt: new Date(row.closesAt).toISOString(),
    status: row.status,
    result: row.resolvedOutcome ?? undefined,
  };
}

function toPool(row: PoolRow): AMMPool {
  return {
    marketId: row.marketId,
    reserveYes: row.reserveA,
    reserveNo: row.reserveB,
    k: row.reserveA * row.reserveB,
    liquidity: row.wpmReserve,
  };
}

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

function enrichMarket(
  market: Market,
  pool: AMMPool,
  bettors: MarketWithOdds["bettors"],
): MarketWithOdds {
  const bettorCount = bettors.length;
  if (market.status === "resolved") {
    const winYes = market.result === "A" ? 1 : 0;
    return {
      ...market,
      priceYes: winYes,
      multiplierYes: winYes > 0 ? 1 / winYes : 0,
      bettorCount,
      bettors,
    };
  }
  const odds = calculateOdds(pool);
  return {
    ...market,
    priceYes: odds.priceYes,
    multiplierYes: odds.multiplierYes,
    bettorCount,
    bettors,
  };
}

export async function getMarket(id: string): Promise<MarketWithOdds> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.market(id));

  const row = await db.query.markets.findFirst({
    where: eq(marketsTable.id, id),
    with: { pool: true, positions: { with: { user: true } } },
  });

  if (!row || !row.pool) throw new Error(`Market ${id} not found`);

  // A position row is persistent — its presence (not non-zero shares) is the
  // signal that a user has participated in this market. Liveness of those
  // shares is answered by markets.status.
  return enrichMarket(toMarket(row), toPool(row.pool), uniqueBettors(row.positions));
}

export async function getMarkets(): Promise<MarketsResponse> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.marketsAll());

  const rows = await db.query.markets.findMany({
    with: { pool: true, positions: { with: { user: true } } },
  });

  const withPools = rows.filter(
    (r): r is MarketRow & { pool: PoolRow; positions: PositionWithUser[] } => r.pool !== null,
  );

  const enriched: MarketWithOdds[] = withPools.map((r) => {
    return enrichMarket(toMarket(r), toPool(r.pool), uniqueBettors(r.positions));
  });

  return { markets: enriched };
}
