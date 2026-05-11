import "server-only";
import { eq, sql } from "drizzle-orm";

import type { TranslatedEvent } from "@/lib/kalshi/translator";

import { initializePool } from "@/lib/amm";
import { db } from "@/lib/db";
import {
  ammPools,
  events as eventsTable,
  markets as marketsTable,
  transactions,
  treasury,
} from "@/lib/db/schema";

export type CreateEventResult = { created: true } | { created: false; reason: "already_exists" };

export async function createEvent(input: TranslatedEvent): Promise<CreateEventResult> {
  const { event, markets: childMarkets } = input;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.id, event.id));
    if (existing) return { created: false, reason: "already_exists" } as const;

    const now = Date.now();

    await tx.insert(eventsTable).values({
      ...event,
      status: "open",
      createdAt: now,
    });

    for (const child of childMarkets) {
      const { market, seedAmount, initialProbabilityYes } = child;
      // initializePool returns sharesA/sharesB in the legacy AMM. Under the
      // YES-first model (Slice 1 additive): sharesA → reserveYes (the retained
      // YES side), sharesB → reserveNo. priceYes = sharesB/total, which
      // matches `initialProbabilityYes` when we pass it as the probability.
      const pool = initializePool(market.id, seedAmount, initialProbabilityYes);

      await tx
        .update(treasury)
        .set({ amount: sql`${treasury.amount} - ${seedAmount}` })
        .where(eq(treasury.id, "treasury"));

      await tx.insert(marketsTable).values({
        ...market,
        eventId: event.id,
        status: "open",
        createdAt: now,
      });

      await tx.insert(ammPools).values({
        marketId: market.id,
        reserveA: pool.sharesA,
        reserveB: pool.sharesB,
        reserveYes: pool.sharesA,
        reserveNo: pool.sharesB,
        wpmReserve: pool.liquidity,
        seedAmount,
      });

      await tx.insert(transactions).values({
        type: "CreateMarket",
        marketId: market.id,
        payload: JSON.stringify({
          type: "CreateMarket",
          id: market.id,
          eventId: event.id,
          name: market.name,
          seedAmount: Number(seedAmount),
          initialProbabilityYes,
          timestamp: new Date(now).toISOString(),
        }),
        createdAt: now,
      });
    }

    return { created: true } as const;
  });
}
