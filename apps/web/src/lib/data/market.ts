import { cacheLife, cacheTag } from "next/cache";
import { eq } from "drizzle-orm";
import { calculateOdds } from "@wpm/shared";
import type { AMMPool, Market, MarketWithOdds } from "@wpm/shared";
import { db } from "@/lib/db";
import { markets as marketsTable } from "@/lib/db/schema";
import type { markets as marketsTableType, ammPools } from "@/lib/db/schema";

type MarketRow = typeof marketsTableType.$inferSelect;
type PoolRow = typeof ammPools.$inferSelect;

function toMarket(row: MarketRow): Market {
  return {
    id: row.id,
    name: row.name,
    outcomes: [row.teamA, row.teamB],
    logos: row.logoA && row.logoB ? [row.logoA, row.logoB] : undefined,
    leagueLogo: row.leagueLogo ?? undefined,
    closesAt: new Date(row.bettingClosesAt).toISOString(),
    status: row.status,
    result: row.resolvedOutcome ?? undefined,
  };
}

function toPool(row: PoolRow): AMMPool {
  return {
    marketId: row.marketId,
    sharesA: row.reserveA,
    sharesB: row.reserveB,
    k: row.reserveA * row.reserveB,
    liquidity: row.wpmReserve,
  };
}

function enrichMarket(market: Market, pool: AMMPool, bettorCount: number): MarketWithOdds {
  if (market.status === "resolved") {
    const winA = market.result === "A" ? 1 : 0;
    const winB = market.result === "B" ? 1 : 0;
    return {
      ...market,
      priceA: winA,
      priceB: winB,
      multiplierA: winA > 0 ? 1 / winA : 0,
      multiplierB: winB > 0 ? 1 / winB : 0,
      pool,
      bettorCount,
    };
  }
  return { ...market, ...calculateOdds(pool), pool, bettorCount };
}

export async function getMarket(id: string): Promise<MarketWithOdds> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`market:${id}`);

  const row = await db.query.markets.findFirst({
    where: eq(marketsTable.id, id),
    with: { pool: true, positions: true },
  });

  if (!row || !row.pool) {
    throw new Error(`Market ${id} not found`);
  }

  const bettors = new Set(
    row.positions.filter((p) => p.sharesA > 0 || p.sharesB > 0).map((p) => p.userId),
  );

  return enrichMarket(toMarket(row), toPool(row.pool), bettors.size);
}
