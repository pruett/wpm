import "server-only";
import { eq, inArray, sql } from "drizzle-orm";

import type { ChildOutcome } from "@/lib/kalshi/resolve";
import type { TranslatedEvent } from "@/lib/kalshi/translator";
import type {
  ChildSettlementOutcome,
  EventSettlementChildInput,
  EventSettlementChildOutput,
} from "@/lib/settlement";

import { initializePool } from "@/lib/amm";
import { db } from "@/lib/db";
import {
  ammPools,
  balances,
  events as eventsTable,
  markets as marketsTable,
  positions,
  transactions,
  treasury,
} from "@/lib/db/schema";
import { computeEventSettlement } from "@/lib/settlement";

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
        reserveA: pool.reserveYes,
        reserveB: pool.reserveNo,
        reserveYes: pool.reserveYes,
        reserveNo: pool.reserveNo,
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

// Event-atomic commit: loads every child Market's pool + position rows in one
// pass, runs `computeEventSettlement` over the plan, and applies all payouts,
// pool drains, status flips, and ledger rows inside a single DB transaction.
// Replaces the prior Slice 1 stub that looped over per-child
// `resolveMarket`/`cancelMarket` calls (each opening its own tx).
//
// Idempotency: children that have already flipped to `resolved`/`cancelled`
// short-circuit with an `already*` marker rather than re-running settlement.
export async function commitEvent(input: CommitEventInput): Promise<CommitEventResult> {
  return db.transaction(async (tx) => {
    const [eventRow] = await tx.select().from(eventsTable).where(eq(eventsTable.id, input.eventId));
    if (!eventRow) return { committed: false, reason: "event_not_found" } as const;
    if (eventRow.status !== "open") return { committed: false, reason: "event_not_open" } as const;

    const childMarketIds = input.perChild.map((c) => c.marketId);

    const [marketRows, poolRows, positionRows] =
      childMarketIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            tx.select().from(marketsTable).where(inArray(marketsTable.id, childMarketIds)),
            tx.select().from(ammPools).where(inArray(ammPools.marketId, childMarketIds)),
            tx.select().from(positions).where(inArray(positions.marketId, childMarketIds)),
          ]);

    const marketById = new Map(marketRows.map((m) => [m.id, m]));
    const poolByMarketId = new Map(poolRows.map((p) => [p.marketId, p]));
    const positionsByMarketId = new Map<string, typeof positionRows>();
    for (const p of positionRows) {
      const list = positionsByMarketId.get(p.marketId) ?? [];
      list.push(p);
      positionsByMarketId.set(p.marketId, list);
    }

    const settleablePlan: EventSettlementChildInput[] = [];
    const resultByMarketId = new Map<string, ChildCommitResult>();

    for (const child of input.perChild) {
      const market = marketById.get(child.marketId);
      if (!market) {
        resultByMarketId.set(child.marketId, {
          marketId: child.marketId,
          outcome: child.outcome,
          status: { kind: "error", reason: "market_not_found" },
        });
        continue;
      }
      if (market.status === "resolved") {
        resultByMarketId.set(child.marketId, {
          marketId: child.marketId,
          outcome: child.outcome,
          status: { kind: "resolved", alreadyResolved: true },
        });
        continue;
      }
      if (market.status === "cancelled") {
        resultByMarketId.set(child.marketId, {
          marketId: child.marketId,
          outcome: child.outcome,
          status: { kind: "cancelled", alreadyCancelled: true },
        });
        continue;
      }
      const pool = poolByMarketId.get(child.marketId);
      if (!pool) {
        resultByMarketId.set(child.marketId, {
          marketId: child.marketId,
          outcome: child.outcome,
          status: { kind: "error", reason: "pool_missing" },
        });
        continue;
      }
      const childPositions = (positionsByMarketId.get(child.marketId) ?? []).map((p) => ({
        userId: p.userId,
        shares: p.shares,
        costBasis: p.costBasis,
      }));
      settleablePlan.push({
        marketId: child.marketId,
        outcome: child.outcome,
        wpmReserve: pool.wpmReserve,
        positions: childPositions,
      });
    }

    const settlement = computeEventSettlement({ perChild: settleablePlan });
    const now = Date.now();

    for (const childOut of settlement.perChild) {
      await applyChildSettlement(tx, childOut, now);
      resultByMarketId.set(childOut.marketId, {
        marketId: childOut.marketId,
        outcome: childOut.outcome,
        status:
          childOut.finalStatus === "resolved"
            ? { kind: "resolved", alreadyResolved: false }
            : { kind: "cancelled", alreadyCancelled: false },
      });
    }

    await tx
      .update(eventsTable)
      .set({ status: "terminal" })
      .where(eq(eventsTable.id, input.eventId));

    const perChild: ChildCommitResult[] = input.perChild.map(
      (c) =>
        resultByMarketId.get(c.marketId) ?? {
          marketId: c.marketId,
          outcome: c.outcome,
          status: { kind: "error", reason: "unprocessed" } as const,
        },
    );

    return { committed: true, perChild } as const;
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applyChildSettlement(
  tx: Tx,
  childOut: EventSettlementChildOutput,
  now: number,
): Promise<void> {
  for (const p of childOut.payouts) {
    if (p.amount > 0n) {
      await tx
        .insert(balances)
        .values({ userId: p.userId, amount: p.amount })
        .onConflictDoUpdate({
          target: balances.userId,
          set: { amount: sql`${balances.amount} + ${p.amount}` },
        });
    }

    await tx.insert(transactions).values({
      type: "SettlePayout",
      userId: p.userId,
      marketId: childOut.marketId,
      payload: JSON.stringify({
        type: "SettlePayout",
        marketId: childOut.marketId,
        to: p.userId,
        shares: Number(p.shares),
        amount: Number(p.amount),
        kind: p.kind,
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });
  }

  if (childOut.backstopAmount > 0n) {
    await tx
      .update(treasury)
      .set({ amount: sql`${treasury.amount} - ${childOut.backstopAmount}` })
      .where(eq(treasury.id, "treasury"));
    await tx.insert(transactions).values({
      type: "TreasuryBackstop",
      marketId: childOut.marketId,
      payload: JSON.stringify({
        type: "TreasuryBackstop",
        marketId: childOut.marketId,
        amount: Number(childOut.backstopAmount),
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });
  } else if (childOut.treasuryDelta > 0n) {
    await tx
      .update(treasury)
      .set({ amount: sql`${treasury.amount} + ${childOut.treasuryDelta}` })
      .where(eq(treasury.id, "treasury"));
  }

  await tx.update(ammPools).set({ wpmReserve: 0n }).where(eq(ammPools.marketId, childOut.marketId));

  if (childOut.finalStatus === "resolved") {
    // Dual-write legacy `resolvedOutcome` (A/B) alongside the new
    // `resolvedAs` (yes/no) column during the additive transition. Under the
    // YES-first mapping, A === yes, B === no.
    const legacyOutcome: "A" | "B" = childOut.resolvedAs === "yes" ? "A" : "B";
    await tx
      .update(marketsTable)
      .set({
        status: "resolved",
        resolvedAs: childOut.resolvedAs,
        resolvedOutcome: legacyOutcome,
        resolvedAt: now,
      })
      .where(eq(marketsTable.id, childOut.marketId));

    await tx.insert(transactions).values({
      type: "ResolveMarket",
      marketId: childOut.marketId,
      payload: JSON.stringify({
        type: "ResolveMarket",
        marketId: childOut.marketId,
        result: legacyOutcome,
        resolvedAs: childOut.resolvedAs,
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });
  } else {
    const reason = cancelReasonFor(childOut.outcome);
    // Position rows are an immutable ledger — not zeroed on cancel (ADR-0004).
    await tx
      .update(marketsTable)
      .set({ status: "cancelled", resolvedAt: now })
      .where(eq(marketsTable.id, childOut.marketId));

    await tx.insert(transactions).values({
      type: "CancelMarket",
      marketId: childOut.marketId,
      payload: JSON.stringify({
        type: "CancelMarket",
        marketId: childOut.marketId,
        reason,
        timestamp: new Date(now).toISOString(),
      }),
      createdAt: now,
    });
  }
}

function cancelReasonFor(outcome: ChildSettlementOutcome): string {
  switch (outcome) {
    case "cancelled_voided":
      return "kalshi_voided";
    case "cancelled_scalar":
      return "kalshi_scalar_settled";
    case "cancelled_no_settlement":
      return "kalshi_no_settlement";
    case "resolved_yes":
    case "resolved_no":
      return "oracle_cancel";
  }
}
