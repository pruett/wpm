import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import binaryHealthy from "@/lib/kalshi/fixtures/binary-healthy.json" with { type: "json" };

import { bumpEventClosesAt } from "./_helpers";

// PLAN.md Phase 3 line 136 — "Simulated mid-commit failure leaves no rows
// behind (DB transaction rollback)." Verifies that `commitEvent` runs entirely
// inside a single DB transaction: if any per-child write fails, every prior
// per-child write in the same call is rolled back and no ledger rows persist.
//
// To simulate a mid-commit failure deterministically, we mock
// `computeEventSettlement` to inject a payout to a userId that does not exist
// in the `user` table. The first child applies cleanly; the second child's
// balance upsert then violates the `balances.user_id → user.id` FK, postgres
// errors, and drizzle's `db.transaction` rolls the whole batch back.

let currentUserId: string | null = null;
vi.mock("@/data/auth", () => ({
  requireUser: async () => {
    if (!currentUserId) return { error: "Not authenticated" };
    return { session: { user: { id: currentUserId } } };
  },
}));

vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

vi.mock("@/lib/settlement", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/settlement")>();
  return {
    ...original,
    computeEventSettlement: vi.fn((input: import("@/lib/settlement").EventSettlementInput) => {
      const result = original.computeEventSettlement(input);
      // Poison the second child with a payout to a non-existent user — the FK
      // on `balances.user_id` will trip when applyChildSettlement upserts.
      if (result.perChild.length >= 2) {
        result.perChild[1].payouts.push({
          userId: "u-ghost",
          kind: "win",
          amount: 1n,
          shares: 1n,
        });
      }
      return result;
    }),
  };
});

const { db, client } = await import("@/lib/db");
const {
  ammPools,
  balances,
  events: eventsTable,
  markets: marketsTable,
  positions,
  transactions,
  treasury,
  user,
} = await import("@/lib/db/schema");
const { createEvent, commitEvent } = await import("@/data/events");
const { placeBet } = await import("@/data/trading");
const { translateKalshiEvent } = await import("@/lib/kalshi/translator");

import type { KalshiEvent } from "@/lib/kalshi";

const STARTING_BALANCE = 10_000n;
const BET_AMOUNT = 500n;

async function truncateAll() {
  await client.unsafe(`
    SET client_min_messages TO WARNING;
    TRUNCATE TABLE
      transactions, positions, amm_pools, markets, events,
      balances, treasury, "user"
    CASCADE
  `);
}

beforeAll(async () => {
  await client`SELECT 1`;
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll();
});

describe("event-flow: mid-commit failure rolls back atomically", () => {
  it("throws and leaves zero per-child writes behind when child #2 fails", async () => {
    // ── Seed: treasury + one bettor ─────────────────────────────────────────
    await db.insert(treasury).values({ id: "treasury", amount: 100_000_000n });

    const BETTOR = "u-bettor";
    await db.insert(user).values({
      id: BETTOR,
      name: BETTOR,
      email: `${BETTOR}@test.local`,
      emailVerified: true,
    });
    await db.insert(balances).values({ userId: BETTOR, amount: STARTING_BALANCE });

    // ── Create a 2-Market Event from the healthy fixture ────────────────────
    const kalshiEvent = (binaryHealthy as { events: KalshiEvent[] }).events[0];
    const translation = translateKalshiEvent(kalshiEvent, "mlb");
    expect(translation.kind).toBe("ok");
    if (translation.kind !== "ok") return;

    const created = await createEvent(translation.value);
    expect(created.created).toBe(true);

    const eventId = translation.value.event.id;
    const [child1, child2] = translation.value.markets;
    const child1Id = child1.market.id;
    const child2Id = child2.market.id;

    await bumpEventClosesAt(eventId);

    // ── BETTOR places a YES bet on the first child to give settlement
    //    something to actually pay out ──────────────────────────────────────
    currentUserId = BETTOR;
    await placeBet({ marketId: child1Id, amount: Number(BET_AMOUNT) });
    currentUserId = null;

    // ── Snapshot pre-commit state ──────────────────────────────────────────
    const [bettorBalBefore] = await db
      .select({ amount: balances.amount })
      .from(balances)
      .where(eq(balances.userId, BETTOR));
    const [treasuryBefore] = await db
      .select({ amount: treasury.amount })
      .from(treasury)
      .where(eq(treasury.id, "treasury"));
    const positionsBefore = await db.select().from(positions);
    const txCountBefore = (await db.select().from(transactions)).length;
    const poolsBefore = await db.select().from(ammPools);

    // ── Trigger the commit. The mocked `computeEventSettlement` injects a
    //    ghost-user payout on child 2; applyChildSettlement applies child 1
    //    cleanly, then errors on child 2's FK violation, rolling everything
    //    in the same db.transaction back. ────────────────────────────────────
    await expect(
      commitEvent({
        eventId,
        perChild: [
          { marketId: child1Id, outcome: "resolved_yes" },
          { marketId: child2Id, outcome: "resolved_no" },
        ],
      }),
    ).rejects.toThrow();

    // ── Verify the Event is still open and BOTH child Markets are still
    //    open — neither status flip from applyChildSettlement persisted. ────
    const [eventAfter] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
    expect(eventAfter.status).toBe("open");

    const marketsAfter = await db
      .select()
      .from(marketsTable)
      .where(eq(marketsTable.eventId, eventId));
    expect(marketsAfter.every((m) => m.status === "open")).toBe(true);
    expect(marketsAfter.every((m) => m.resolvedAs === null)).toBe(true);
    expect(marketsAfter.every((m) => m.resolvedAt === null)).toBe(true);

    // ── Bettor balance unchanged from pre-commit snapshot (no SettlePayout
    //    credit ever landed). ─────────────────────────────────────────────────
    const [bettorBalAfter] = await db
      .select({ amount: balances.amount })
      .from(balances)
      .where(eq(balances.userId, BETTOR));
    expect(bettorBalAfter.amount).toBe(bettorBalBefore.amount);

    // ── Treasury untouched. ────────────────────────────────────────────────
    const [treasuryAfter] = await db
      .select({ amount: treasury.amount })
      .from(treasury)
      .where(eq(treasury.id, "treasury"));
    expect(treasuryAfter.amount).toBe(treasuryBefore.amount);

    // ── No ghost balance row was upserted for "u-ghost". ───────────────────
    const ghostRows = await db.select().from(balances).where(eq(balances.userId, "u-ghost"));
    expect(ghostRows).toHaveLength(0);

    // ── Positions unchanged from pre-commit snapshot. ──────────────────────
    const positionsAfter = await db.select().from(positions);
    expect(positionsAfter).toEqual(positionsBefore);

    // ── No SettlePayout / ResolveMarket / TreasuryBackstop rows survived. ──
    const settleRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.type, "SettlePayout"));
    const resolveRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.type, "ResolveMarket"));
    const backstopRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.type, "TreasuryBackstop"));
    expect(settleRows).toHaveLength(0);
    expect(resolveRows).toHaveLength(0);
    expect(backstopRows).toHaveLength(0);

    // ── Transaction-count delta is zero: nothing the commit would have
    //    written remains. ────────────────────────────────────────────────────
    const txCountAfter = (await db.select().from(transactions)).length;
    expect(txCountAfter).toBe(txCountBefore);

    // ── Pools unchanged: wpmReserve not drained on either child. ───────────
    const poolsAfter = await db.select().from(ammPools);
    const poolBeforeById = new Map(poolsBefore.map((p) => [p.marketId, p]));
    for (const after of poolsAfter) {
      const before = poolBeforeById.get(after.marketId)!;
      expect(after.wpmReserve).toBe(before.wpmReserve);
    }
  });
});
