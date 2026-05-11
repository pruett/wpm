import "server-only";
import { eq, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

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
  user as userTable,
} from "@/lib/db/schema";
import { computeSettlement, type SettlementOutput } from "@/lib/settlement";

import { tags } from "./tags";

type MarketRow = typeof marketsTable.$inferSelect;
type PoolRow = typeof ammPools.$inferSelect;
type PositionWithUser = typeof positions.$inferSelect & {
  user: typeof userTable.$inferSelect;
};

function toMarket(row: MarketRow): Market {
  return {
    id: row.id,
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
    const winA = market.result === "A" ? 1 : 0;
    const winB = market.result === "B" ? 1 : 0;
    return {
      ...market,
      priceA: winA,
      priceB: winB,
      multiplierA: winA > 0 ? 1 / winA : 0,
      multiplierB: winB > 0 ? 1 / winB : 0,
      bettorCount,
      bettors,
    };
  }
  const odds = calculateOdds(pool);
  return {
    ...market,
    priceA: odds.priceYes,
    priceB: odds.priceNo,
    multiplierA: odds.multiplierYes,
    multiplierB: odds.multiplierNo,
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

export type CreateMarketResult = { created: true } | { created: false; reason: "already_exists" };

// Legacy single-Market input shape kept temporarily during Slice 1: the new
// translator returns `{event, markets[]}`, but createMarket still does the
// pre-multi-outcome single-row write. The shim lives in `lib/kalshi/ingest.ts`.
// Replaced by `createEvent` in the next plan task.
type LegacyCreateMarketInput = {
  market: {
    id: string;
    sport: "mlb" | "nfl" | "nba" | "nhl";
    name: string;
    teamA: string;
    teamB: string;
    tickerA: string | null;
    tickerB: string | null;
    closesAt: number;
    resolvedOutcome: "A" | "B" | null;
    resolvedAt: number | null;
  };
  seedAmount: bigint;
  initialProbabilityA: number;
};

export async function createMarket(input: LegacyCreateMarketInput): Promise<CreateMarketResult> {
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
      reserveA: pool.reserveYes,
      reserveB: pool.reserveNo,
      wpmReserve: pool.liquidity,
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
        seedAmount: Number(seedAmount),
        initialProbabilityA,
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

    const settlement = computeSettlement({
      kind: "resolve",
      outcome,
      wpmReserve: pool.wpmReserve,
      positions: allPositions,
    });

    const now = Date.now();
    const affected = await applySettlement(tx, marketId, settlement, now);

    await tx.update(ammPools).set({ wpmReserve: 0n }).where(eq(ammPools.marketId, marketId));
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

    const settlement = computeSettlement({
      kind: "cancel",
      wpmReserve: pool.wpmReserve,
      positions: allPositions,
    });

    const now = Date.now();
    const affected = await applySettlement(tx, marketId, settlement, now);

    // Position rows are an immutable ledger — not zeroed on cancel (ADR-0004).
    await tx.update(ammPools).set({ wpmReserve: 0n }).where(eq(ammPools.marketId, marketId));
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applySettlement(
  tx: Tx,
  marketId: string,
  settlement: SettlementOutput,
  now: number,
): Promise<{ userId: string; newBalance: number }[]> {
  const affected: { userId: string; newBalance: number }[] = [];

  for (const p of settlement.payouts) {
    if (p.amount > 0n) {
      const [priorRow] = await tx
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, p.userId));
      const prior = priorRow?.amount ?? 0n;

      await tx
        .insert(balances)
        .values({ userId: p.userId, amount: p.amount })
        .onConflictDoUpdate({
          target: balances.userId,
          set: { amount: sql`${balances.amount} + ${p.amount}` },
        });

      affected.push({ userId: p.userId, newBalance: Number(prior + p.amount) });
    }

    await tx.insert(transactions).values({
      type: "SettlePayout",
      userId: p.userId,
      marketId,
      payload: JSON.stringify({
        type: "SettlePayout",
        marketId,
        to: p.userId,
        shares: Number(p.shares),
        amount: Number(p.amount),
        kind: p.kind,
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });
  }

  if (settlement.backstopAmount > 0n) {
    await tx
      .update(treasury)
      .set({ amount: sql`${treasury.amount} - ${settlement.backstopAmount}` })
      .where(eq(treasury.id, "treasury"));
    await tx.insert(transactions).values({
      type: "TreasuryBackstop",
      marketId,
      payload: JSON.stringify({
        type: "TreasuryBackstop",
        marketId,
        amount: Number(settlement.backstopAmount),
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });
  } else if (settlement.treasuryDelta > 0n) {
    await tx
      .update(treasury)
      .set({ amount: sql`${treasury.amount} + ${settlement.treasuryDelta}` })
      .where(eq(treasury.id, "treasury"));
  }

  return affected;
}
