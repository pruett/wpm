import { eq, sql } from "drizzle-orm";
import type { CreateMarketRequest } from "@wpm/shared";
import { db } from "@/lib/db";
import { ammPools, markets, transactions, treasury } from "@/lib/db/schema";
import { updateTag } from "next/cache";

export type CreateMarketResult = { created: true } | { created: false; reason: "already_exists" };

export function createMarket(req: CreateMarketRequest): CreateMarketResult {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, req.id))
      .get();
    if (existing) return { created: false, reason: "already_exists" } as const;

    const now = Date.now();

    tx.update(treasury)
      .set({ amount: sql`${treasury.amount} - ${req.seedAmount}` })
      .where(eq(treasury.id, "treasury"))
      .run();

    tx.insert(markets)
      .values({
        id: req.id,
        sport: req.sport,
        name: req.name,
        teamA: req.teamA,
        teamB: req.teamB,
        logoA: req.logoA ?? null,
        logoB: req.logoB ?? null,
        leagueLogo: req.leagueLogo ?? null,
        startTime: new Date(req.startTime).getTime(),
        bettingClosesAt: new Date(req.bettingClosesAt).getTime(),
        status: "open",
        createdAt: now,
      })
      .run();

    tx.insert(ammPools)
      .values({
        marketId: req.id,
        reserveA: Math.round(req.reserveA),
        reserveB: Math.round(req.reserveB),
        wpmReserve: Math.round(req.wpmReserve),
        seedAmount: req.seedAmount,
      })
      .run();

    tx.insert(transactions)
      .values({
        type: "CreateMarket",
        marketId: req.id,
        payload: JSON.stringify({
          type: "CreateMarket",
          id: req.id,
          name: req.name,
          outcomes: [req.teamA, req.teamB],
          seedAmount: req.seedAmount,
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      })
      .run();

    return { created: true } as const;
  });
}

export function createMarketAndNotify(req: CreateMarketRequest): CreateMarketResult {
  const result = createMarket(req);
  if (result.created) {
    updateTag("markets");
  }
  return result;
}
