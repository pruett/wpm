import "server-only";
import { eq, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import type { TranslatedMarket } from "@/lib/kalshi/translator";
import type { AMMPool, Market, MarketWithOdds, MarketsResponse } from "@/lib/types";

import { calculateOdds, initializePool } from "@/lib/amm";
import { db } from "@/lib/db";
import {
  ammPools,
  balances,
  markets as marketsTable,
  positions,
  transactions,
  treasury,
} from "@/lib/db/schema";

import { tags } from "./tags";

type MarketRow = typeof marketsTable.$inferSelect;
type PoolRow = typeof ammPools.$inferSelect;
type PositionRow = typeof positions.$inferSelect;

function toMarket(row: MarketRow): Market {
  return {
    id: row.id,
    name: row.name,
    outcomes: [row.teamA, row.teamB],
    closesAt: new Date(row.closesAt).toISOString(),
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
  cacheTag(tags.market(id));

  const row = await db.query.markets.findFirst({
    where: eq(marketsTable.id, id),
    with: { pool: true, positions: true },
  });

  if (!row || !row.pool) throw new Error(`Market ${id} not found`);

  const bettors = new Set(
    row.positions.filter((p) => p.sharesA > 0 || p.sharesB > 0).map((p) => p.userId),
  );

  return enrichMarket(toMarket(row), toPool(row.pool), bettors.size);
}

export async function getMarkets(): Promise<MarketsResponse> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.marketsAll());

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

export async function listAllMarketsRaw(): Promise<MarketRow[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.marketsAll());

  return db.select().from(marketsTable);
}

export type CreateMarketResult = { created: true } | { created: false; reason: "already_exists" };

export async function createMarket(input: TranslatedMarket): Promise<CreateMarketResult> {
  const { market, seedAmount, initialProbabilityA } = input;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: marketsTable.id })
      .from(marketsTable)
      .where(eq(marketsTable.id, market.id));
    if (existing) return { created: false, reason: "already_exists" } as const;

    const now = Date.now();
    const pool = initializePool(market.id, seedAmount, initialProbabilityA);

    await tx
      .update(treasury)
      .set({ amount: sql`${treasury.amount} - ${seedAmount}` })
      .where(eq(treasury.id, "treasury"));

    await tx.insert(marketsTable).values({
      ...market,
      status: "open",
      createdAt: now,
    });

    await tx.insert(ammPools).values({
      marketId: market.id,
      reserveA: Math.round(pool.sharesA),
      reserveB: Math.round(pool.sharesB),
      wpmReserve: Math.round(pool.liquidity),
      seedAmount,
    });

    await tx.insert(transactions).values({
      type: "CreateMarket",
      marketId: market.id,
      payload: JSON.stringify({
        type: "CreateMarket",
        id: market.id,
        name: market.name,
        outcomes: [market.teamA, market.teamB],
        seedAmount,
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });

    return { created: true } as const;
  });
}

export type ResolveMarketResult =
  | {
      resolved: true;
      alreadyResolved?: boolean;
      affectedUsers: { userId: string; newBalance: number }[];
    }
  | { resolved: false; reason: string };

export async function resolveMarket(
  marketId: string,
  outcome: "A" | "B",
): Promise<ResolveMarketResult> {
  const txResult = await db.transaction(async (tx) => {
    const [market] = await tx.select().from(marketsTable).where(eq(marketsTable.id, marketId));
    if (!market) return { resolved: false as const, reason: "Market not found" };

    if (market.status === "resolved") {
      if (market.resolvedOutcome === outcome) return "already_resolved" as const;
      return {
        resolved: false as const,
        reason: "Market already resolved with different outcome",
      };
    }
    if (market.status === "cancelled") {
      return { resolved: false as const, reason: "Market is cancelled" };
    }

    const [pool] = await tx.select().from(ammPools).where(eq(ammPools.marketId, marketId));
    if (!pool) return { resolved: false as const, reason: "AMM pool missing" };

    const allPositions = await tx.select().from(positions).where(eq(positions.marketId, marketId));
    const winners = allPositions.filter((p) => (outcome === "A" ? p.sharesA > 0 : p.sharesB > 0));

    const now = Date.now();
    let totalPaid = 0;
    const affected: { userId: string; newBalance: number }[] = [];

    for (const p of winners) {
      const winningShares = outcome === "A" ? p.sharesA : p.sharesB;
      const payout = winningShares;
      if (payout <= 0) continue;

      const [priorRow] = await tx
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, p.userId));
      const prior = priorRow?.amount ?? 0;

      await tx
        .insert(balances)
        .values({ userId: p.userId, amount: payout })
        .onConflictDoUpdate({
          target: balances.userId,
          set: { amount: sql`${balances.amount} + ${payout}` },
        });

      await tx.insert(transactions).values({
        type: "SettlePayout",
        userId: p.userId,
        marketId,
        payload: JSON.stringify({
          type: "SettlePayout",
          marketId,
          to: p.userId,
          shares: winningShares,
          amount: payout,
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      });

      totalPaid += payout;
      affected.push({ userId: p.userId, newBalance: prior + payout });
    }

    const liquidityRemainder = pool.wpmReserve - totalPaid;
    if (liquidityRemainder > 0) {
      await tx
        .update(treasury)
        .set({ amount: sql`${treasury.amount} + ${liquidityRemainder}` })
        .where(eq(treasury.id, "treasury"));
    }

    await tx.update(ammPools).set({ wpmReserve: 0 }).where(eq(ammPools.marketId, marketId));
    await tx
      .update(marketsTable)
      .set({ status: "resolved", resolvedOutcome: outcome, resolvedAt: now })
      .where(eq(marketsTable.id, marketId));

    await tx.insert(transactions).values({
      type: "ResolveMarket",
      marketId,
      payload: JSON.stringify({
        type: "ResolveMarket",
        marketId,
        result: outcome,
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });

    return affected;
  });

  if (txResult === "already_resolved")
    return { resolved: true, alreadyResolved: true, affectedUsers: [] };
  if (!Array.isArray(txResult)) return txResult;
  return { resolved: true, affectedUsers: txResult };
}

export type CancelMarketResult =
  | {
      cancelled: true;
      alreadyCancelled?: boolean;
      affectedUsers: { userId: string; newBalance: number }[];
    }
  | { cancelled: false; reason: string };

export async function cancelMarket(marketId: string, reason?: string): Promise<CancelMarketResult> {
  const txResult = await db.transaction(async (tx) => {
    const [market] = await tx.select().from(marketsTable).where(eq(marketsTable.id, marketId));
    if (!market) return { cancelled: false as const, reason: "Market not found" };

    if (market.status === "cancelled") return "already_cancelled" as const;
    if (market.status === "resolved") {
      return { cancelled: false as const, reason: "Market is already resolved" };
    }

    const [pool] = await tx.select().from(ammPools).where(eq(ammPools.marketId, marketId));
    if (!pool) return { cancelled: false as const, reason: "AMM pool missing" };

    const allPositions = await tx.select().from(positions).where(eq(positions.marketId, marketId));
    const holders = allPositions.filter((p) => p.sharesA > 0 || p.sharesB > 0);

    const now = Date.now();
    let totalRefunded = 0;
    const affected: { userId: string; newBalance: number }[] = [];

    for (const p of holders) {
      if (p.costBasis <= 0) continue;
      const [priorRow] = await tx
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, p.userId));
      const prior = priorRow?.amount ?? 0;

      await tx
        .insert(balances)
        .values({ userId: p.userId, amount: p.costBasis })
        .onConflictDoUpdate({
          target: balances.userId,
          set: { amount: sql`${balances.amount} + ${p.costBasis}` },
        });

      await tx.insert(transactions).values({
        type: "SettlePayout",
        userId: p.userId,
        marketId,
        payload: JSON.stringify({
          type: "SettlePayout",
          marketId,
          to: p.userId,
          shares: p.sharesA + p.sharesB,
          amount: p.costBasis,
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      });

      totalRefunded += p.costBasis;
      affected.push({ userId: p.userId, newBalance: prior + p.costBasis });
    }

    const liquidityRemainder = pool.wpmReserve - totalRefunded;
    if (liquidityRemainder > 0) {
      await tx
        .update(treasury)
        .set({ amount: sql`${treasury.amount} + ${liquidityRemainder}` })
        .where(eq(treasury.id, "treasury"));
    }

    await tx.update(ammPools).set({ wpmReserve: 0 }).where(eq(ammPools.marketId, marketId));
    await tx
      .update(positions)
      .set({ sharesA: 0, sharesB: 0, costBasis: 0 })
      .where(eq(positions.marketId, marketId));
    await tx
      .update(marketsTable)
      .set({ status: "cancelled", resolvedAt: now })
      .where(eq(marketsTable.id, marketId));

    await tx.insert(transactions).values({
      type: "CancelMarket",
      marketId,
      payload: JSON.stringify({
        type: "CancelMarket",
        marketId,
        reason: reason ?? "oracle_cancel",
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });

    return affected;
  });

  if (txResult === "already_cancelled")
    return { cancelled: true, alreadyCancelled: true, affectedUsers: [] };
  if (!Array.isArray(txResult)) return txResult;
  return { cancelled: true, affectedUsers: txResult };
}

export async function overrideSeed(
  marketId: string,
  seedA: number,
  seedB: number,
): Promise<{ liquidity: number; reserveA: number; reserveB: number }> {
  const reserveA = Math.round(seedA);
  const reserveB = Math.round(seedB);

  return db.transaction(async (tx) => {
    const [market] = await tx.select().from(marketsTable).where(eq(marketsTable.id, marketId));
    if (!market) throw new Error("Market not found");

    const [pool] = await tx.select().from(ammPools).where(eq(ammPools.marketId, marketId));
    if (!pool) throw new Error("AMM pool missing");

    await tx.update(ammPools).set({ reserveA, reserveB }).where(eq(ammPools.marketId, marketId));

    return { liquidity: pool.wpmReserve, reserveA, reserveB };
  });
}
