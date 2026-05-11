import "server-only";
import { eq, sql } from "drizzle-orm";

import type { ChildOutcome } from "@/lib/kalshi/resolve";
import type { TranslatedEvent } from "@/lib/kalshi/translator";

import { cancelMarket, resolveMarket } from "@/data/markets";
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

export type CommitEventInput = {
  eventId: string;
  perChild: ChildOutcome[];
};

export type ChildCommitOutcomeStatus =
  | { kind: "resolved"; alreadyResolved: boolean }
  | { kind: "cancelled"; alreadyCancelled: boolean }
  | { kind: "error"; reason: string };

export type ChildCommitResult = {
  marketId: string;
  outcome: ChildOutcome["outcome"];
  status: ChildCommitOutcomeStatus;
};

export type CommitEventResult =
  | { committed: true; perChild: ChildCommitResult[] }
  | { committed: false; reason: "event_not_found" | "event_not_open" };

// Slice 1 stub: dispatches each child outcome to the legacy
// `resolveMarket`/`cancelMarket` data-layer functions, then flips
// `events.status = 'terminal'`. Phase 3 rewrites this with `computeSettlement`
// across all children inside a single DB transaction (see PLAN §Phase 3).
//
// YES-first mapping (preserved during the additive transition):
//   resolved_yes  → legacy `resolveMarket(id, "A")` — A side is YES per
//                   `createEvent`'s `sharesA → reserveYes` wiring.
//   resolved_no   → legacy `resolveMarket(id, "B")` — under YES-only trading
//                   no holder has sharesB, so all payouts compute to 0.
//   cancelled_*   → legacy `cancelMarket(id, <reason>)`.
export async function commitEvent(input: CommitEventInput): Promise<CommitEventResult> {
  const [row] = await db.select().from(eventsTable).where(eq(eventsTable.id, input.eventId));
  if (!row) return { committed: false, reason: "event_not_found" } as const;
  if (row.status !== "open") return { committed: false, reason: "event_not_open" } as const;

  const perChild: ChildCommitResult[] = [];

  for (const child of input.perChild) {
    const status = await applyChildOutcome(child);
    perChild.push({ marketId: child.marketId, outcome: child.outcome, status });
  }

  await db.update(eventsTable).set({ status: "terminal" }).where(eq(eventsTable.id, input.eventId));

  return { committed: true, perChild } as const;
}

async function applyChildOutcome(child: ChildOutcome): Promise<ChildCommitOutcomeStatus> {
  switch (child.outcome) {
    case "resolved_yes": {
      const r = await resolveMarket(child.marketId, "A");
      if (r.resolved) return { kind: "resolved", alreadyResolved: r.alreadyResolved ?? false };
      return { kind: "error", reason: r.reason };
    }
    case "resolved_no": {
      const r = await resolveMarket(child.marketId, "B");
      if (r.resolved) return { kind: "resolved", alreadyResolved: r.alreadyResolved ?? false };
      return { kind: "error", reason: r.reason };
    }
    case "cancelled_voided": {
      const r = await cancelMarket(child.marketId, "kalshi_voided");
      if (r.cancelled) return { kind: "cancelled", alreadyCancelled: r.alreadyCancelled ?? false };
      return { kind: "error", reason: r.reason };
    }
    case "cancelled_scalar": {
      const r = await cancelMarket(child.marketId, "kalshi_scalar_settled");
      if (r.cancelled) return { kind: "cancelled", alreadyCancelled: r.alreadyCancelled ?? false };
      return { kind: "error", reason: r.reason };
    }
    case "cancelled_no_settlement": {
      const r = await cancelMarket(child.marketId, "kalshi_no_settlement");
      if (r.cancelled) return { kind: "cancelled", alreadyCancelled: r.alreadyCancelled ?? false };
      return { kind: "error", reason: r.reason };
    }
  }
}
