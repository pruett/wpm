import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import binaryHealthy from "@/lib/kalshi/fixtures/binary-healthy.json" with { type: "json" };

import { bumpEventClosesAt } from "./_helpers";

// Mock the auth boundary so we can drive userId from inside the test.
let currentUserId: string | null = null;
vi.mock("@/data/auth", () => ({
  requireUser: async () => {
    if (!currentUserId) return { error: "Not authenticated" };
    return { session: { user: { id: currentUserId } } };
  },
}));

// Avoid Next.js cache wiring during direct DAL calls.
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

// All imports of project modules must come AFTER the mocks above so vi.mock
// hoisting registers before module eval.
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
const TREASURY_SEED = 100_000_000n;

type Bettor = {
  id: string;
  // Which child of the 2-Market Event to back: YES on the first (winner) child
  // or YES on the second (loser) child. Under the multi-outcome model, betting
  // against an outcome is buying YES on the sibling Market.
  side: "winner-child" | "loser-child";
  amount: bigint;
};

const BETTORS: Bettor[] = [
  { id: "u-alice", side: "winner-child", amount: 500n },
  { id: "u-bob", side: "winner-child", amount: 1_500n },
  { id: "u-carol", side: "winner-child", amount: 250n },
  { id: "u-dave", side: "loser-child", amount: 2_000n },
  { id: "u-erin", side: "loser-child", amount: 800n },
];

async function truncateAll() {
  // Order matters due to FKs; CASCADE makes it safe regardless.
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

describe("end-to-end: bet → Event-commit with 5 bettors across two child Markets", () => {
  it("credits winners 1:1 in WPM, leaves losers flat, drains pools, conserves total WPM", async () => {
    // ── Seed: treasury, users, balances ────────────────────────────────────
    await db.insert(treasury).values({ id: "treasury", amount: TREASURY_SEED });

    for (const b of BETTORS) {
      await db.insert(user).values({
        id: b.id,
        name: b.id,
        email: `${b.id}@test.local`,
        emailVerified: true,
      });
      await db.insert(balances).values({ userId: b.id, amount: STARTING_BALANCE });
    }

    // ── Translate the 2-Market fixture through the real translator ─────────
    const kalshiEvent = (binaryHealthy as { events: KalshiEvent[] }).events[0];
    const translation = translateKalshiEvent(kalshiEvent, "mlb");
    expect(translation.kind).toBe("ok");
    if (translation.kind !== "ok") return;

    const created = await createEvent(translation.value);
    expect(created.created).toBe(true);

    const eventId = translation.value.event.id;
    const [winnerChild, loserChild] = translation.value.markets;
    const winnerMarketId = winnerChild.market.id;
    const loserMarketId = loserChild.market.id;

    await bumpEventClosesAt(eventId);

    // ── Each bettor places one YES bet on their assigned child Market ─────
    const sharesByUser = new Map<string, bigint>();
    for (const b of BETTORS) {
      currentUserId = b.id;
      const targetMarketId = b.side === "winner-child" ? winnerMarketId : loserMarketId;
      const result = await placeBet({ marketId: targetMarketId, amount: Number(b.amount) });
      expect(result.userId).toBe(b.id);

      const [bal] = await db
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, b.id));
      expect(bal.amount).toBe(STARTING_BALANCE - b.amount);

      const [pos] = await db.select().from(positions).where(eq(positions.userId, b.id));
      expect(pos.marketId).toBe(targetMarketId);
      expect(pos.shares).toBeGreaterThan(0n);
      expect(pos.costBasis).toBe(b.amount);
      sharesByUser.set(b.id, pos.shares);
    }
    currentUserId = null;

    // ── Each pool's liquidity grew by exactly the sum of bets routed to it ─
    const winnerPoolInflow = BETTORS.filter((b) => b.side === "winner-child").reduce(
      (s, b) => s + b.amount,
      0n,
    );
    const loserPoolInflow = BETTORS.filter((b) => b.side === "loser-child").reduce(
      (s, b) => s + b.amount,
      0n,
    );
    const [winnerPoolBefore] = await db
      .select()
      .from(ammPools)
      .where(eq(ammPools.marketId, winnerMarketId));
    const [loserPoolBefore] = await db
      .select()
      .from(ammPools)
      .where(eq(ammPools.marketId, loserMarketId));
    const winnerSeed = winnerChild.seedAmount;
    const loserSeed = loserChild.seedAmount;
    expect(winnerPoolBefore.wpmReserve).toBe(winnerSeed + winnerPoolInflow);
    expect(loserPoolBefore.wpmReserve).toBe(loserSeed + loserPoolInflow);

    // ── Snapshot pre-commit treasury & balances ────────────────────────────
    const [treasuryBefore] = await db
      .select({ amount: treasury.amount })
      .from(treasury)
      .where(eq(treasury.id, "treasury"));

    const balancesBefore = new Map<string, bigint>();
    for (const b of BETTORS) {
      const [row] = await db
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, b.id));
      balancesBefore.set(b.id, row.amount);
    }

    // ── Commit the Event: winner child resolves YES, loser child resolves NO
    const commit = await commitEvent({
      eventId,
      perChild: [
        { marketId: winnerMarketId, outcome: "resolved_yes" },
        { marketId: loserMarketId, outcome: "resolved_no" },
      ],
    });
    expect(commit.committed).toBe(true);
    if (!commit.committed) return;

    // ── Per-bettor balance deltas: winners +shares, losers flat ────────────
    for (const b of BETTORS) {
      const [row] = await db
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, b.id));
      const before = balancesBefore.get(b.id)!;
      const shares = sharesByUser.get(b.id)!;

      if (b.side === "winner-child") {
        expect(row.amount).toBe(before + shares);
      } else {
        expect(row.amount).toBe(before);
      }
    }

    // ── Event terminal + per-child statuses correct ────────────────────────
    const [eventAfter] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
    expect(eventAfter.status).toBe("terminal");

    const marketsAfter = await db
      .select()
      .from(marketsTable)
      .where(eq(marketsTable.eventId, eventId));
    const winnerAfter = marketsAfter.find((m) => m.id === winnerMarketId)!;
    const loserAfter = marketsAfter.find((m) => m.id === loserMarketId)!;
    expect(winnerAfter.status).toBe("resolved");
    expect(winnerAfter.resolvedAs).toBe("yes");
    expect(loserAfter.status).toBe("resolved");
    expect(loserAfter.resolvedAs).toBe("no");

    // ── Both pools fully drained ───────────────────────────────────────────
    const poolsAfter = await db.select().from(ammPools);
    expect(poolsAfter).toHaveLength(2);
    expect(poolsAfter.every((p) => p.wpmReserve === 0n)).toBe(true);

    // ── One ResolveMarket row per child Market ─────────────────────────────
    const resolveRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.type, "ResolveMarket"));
    expect(resolveRows).toHaveLength(2);

    // ── SettlePayout row for every bettor with a position; kind reflects
    //    the per-child outcome ─────────────────────────────────────────────
    const payoutRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.type, "SettlePayout"));
    expect(payoutRows).toHaveLength(BETTORS.length);

    for (const b of BETTORS) {
      const expectedMarketId = b.side === "winner-child" ? winnerMarketId : loserMarketId;
      const row = payoutRows.find((r) => r.userId === b.id && r.marketId === expectedMarketId);
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload) as { amount: number; kind: string };
      if (b.side === "winner-child") {
        expect(payload.kind).toBe("win");
        expect(BigInt(payload.amount)).toBe(sharesByUser.get(b.id)!);
      } else {
        expect(payload.kind).toBe("loss");
        expect(payload.amount).toBe(0);
      }
    }

    // ── Global conservation: every WPM accounted for ───────────────────────
    // Initial system WPM = treasury_initial + sum(starting balances).
    // Final system WPM = treasury_after + sum(all balances) + sum(pool_after).
    const [{ amount: treasuryAfter }] = await db.select({ amount: treasury.amount }).from(treasury);
    expect(treasuryAfter).toBeGreaterThanOrEqual(treasuryBefore.amount);

    const allBalances = await db.select({ amount: balances.amount }).from(balances);
    const totalUserBalance = allBalances.reduce((s, r) => s + r.amount, 0n);
    const totalPoolWpm = poolsAfter.reduce((s, p) => s + p.wpmReserve, 0n);

    const initialSystem = TREASURY_SEED + STARTING_BALANCE * BigInt(BETTORS.length);
    const finalSystem = treasuryAfter + totalUserBalance + totalPoolWpm;
    expect(finalSystem).toBe(initialSystem);
  });
});
