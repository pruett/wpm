import { cacheLife, cacheTag } from "next/cache";
import { calculateOdds } from "@wpm/shared";
import type { AMMPool, Market, MarketWithOdds, MarketsResponse } from "@wpm/shared";
import { db } from "@/lib/db";
import type { markets as marketsTable, ammPools, positions } from "@/lib/db/schema";

type MarketRow = typeof marketsTable.$inferSelect;
type PoolRow = typeof ammPools.$inferSelect;
type PositionRow = typeof positions.$inferSelect;

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

export async function getMarkets(): Promise<MarketsResponse> {
  "use cache";
  cacheLife("minutes");
  cacheTag("markets");

  const rows = await db.query.markets.findMany({
    with: { pool: true, positions: true },
  });

  const enriched: MarketWithOdds[] = rows
    .filter((r): r is MarketRow & { pool: PoolRow; positions: PositionRow[] } => r.pool !== null)
    .map((r) => {
      const bettors = new Set(
        r.positions.filter((p) => p.sharesA > 0 || p.sharesB > 0).map((p) => p.userId),
      );
      return enrichMarket(toMarket(r), toPool(r.pool), bettors.size);
    });

  const active = enriched
    .filter((m) => m.status === "open" && m.pool.sharesA !== m.pool.sharesB)
    .map((m) => m.id);

  return { active, markets: enriched };
}
