import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import binaryHealthy from "@/lib/kalshi/fixtures/binary-healthy.json" with { type: "json" };

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

describe("event-flow: ingest → bet → commit (Slice 1 smoke test)", () => {
  it("creates Event + child Markets, accepts YES bet, commits with both children settled", async () => {
    // ── Seed: treasury, two users, balances ────────────────────────────────
    await db.insert(treasury).values({ id: "treasury", amount: 100_000_000n });

    const WINNER = "u-winner";
    const LOSER = "u-loser";

    for (const id of [WINNER, LOSER]) {
      await db.insert(user).values({
        id,
        name: id,
        email: `${id}@test.local`,
        emailVerified: true,
      });
      await db.insert(balances).values({ userId: id, amount: STARTING_BALANCE });
    }

    // ── Translate the 2-Market fixture through the real translator ─────────
    const kalshiEvent = (binaryHealthy as { events: KalshiEvent[] }).events[0];
    const translation = translateKalshiEvent(kalshiEvent, "mlb");
    expect(translation.kind).toBe("ok");
    if (translation.kind !== "ok") return;

    const created = await createEvent(translation.value);
    expect(created.created).toBe(true);

    const eventId = translation.value.event.id;
    const [yesMarket, noMarket] = translation.value.markets;
    const yesMarketId = yesMarket.market.id;
    const noMarketId = noMarket.market.id;

    // Translator builds the Event with closesAt in the past (fixture is for
    // 2026-04-25). Live `placeBet` rejects bets after close, so bump the
    // children's closesAt forward for the betting step.
    const future = Date.now() + 60 * 60 * 1000;
    await db.update(marketsTable).set({ closesAt: future }).where(eq(marketsTable.id, yesMarketId));
    await db.update(marketsTable).set({ closesAt: future }).where(eq(marketsTable.id, noMarketId));

    // ── Both child Markets exist, both pools exist ─────────────────────────
    const allMarkets = await db
      .select()
      .from(marketsTable)
      .where(eq(marketsTable.eventId, eventId));
    expect(allMarkets).toHaveLength(2);
    expect(allMarkets.every((m) => m.status === "open")).toBe(true);

    const allPools = await db.select().from(ammPools);
    expect(allPools).toHaveLength(2);

    // ── WINNER places a YES bet on the first child ─────────────────────────
    currentUserId = WINNER;
    const betResult = await placeBet({
      marketId: yesMarketId,
      amount: Number(BET_AMOUNT),
    });
    expect(betResult.userId).toBe(WINNER);

    const [winnerBalAfterBet] = await db
      .select({ amount: balances.amount })
      .from(balances)
      .where(eq(balances.userId, WINNER));
    expect(winnerBalAfterBet.amount).toBe(STARTING_BALANCE - BET_AMOUNT);

    const [winnerPos] = await db.select().from(positions).where(eq(positions.userId, WINNER));
    expect(winnerPos.marketId).toBe(yesMarketId);
    expect(winnerPos.shares).toBeGreaterThan(0n);
    expect(winnerPos.costBasis).toBe(BET_AMOUNT);
    const winnerShares = winnerPos.shares;

    currentUserId = null;

    // ── Snapshot pre-commit treasury ───────────────────────────────────────
    const [treasuryBefore] = await db
      .select({ amount: treasury.amount })
      .from(treasury)
      .where(eq(treasury.id, "treasury"));

    // ── Force-commit the Event: first child YES wins, second child NO ─────
    const commit = await commitEvent({
      eventId,
      perChild: [
        { marketId: yesMarketId, outcome: "resolved_yes" },
        { marketId: noMarketId, outcome: "resolved_no" },
      ],
    });
    expect(commit.committed).toBe(true);
    if (!commit.committed) return;
    expect(commit.perChild).toHaveLength(2);

    // ── Event terminal, both Markets resolved with correct resolvedAs ──────
    const [eventAfter] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
    expect(eventAfter.status).toBe("terminal");

    const marketsAfter = await db
      .select()
      .from(marketsTable)
      .where(eq(marketsTable.eventId, eventId));
    const yesAfter = marketsAfter.find((m) => m.id === yesMarketId)!;
    const noAfter = marketsAfter.find((m) => m.id === noMarketId)!;
    expect(yesAfter.status).toBe("resolved");
    expect(yesAfter.resolvedAs).toBe("yes");
    expect(noAfter.status).toBe("resolved");
    expect(noAfter.resolvedAs).toBe("no");

    // ── WINNER credited with `shares` WPM; LOSER untouched ─────────────────
    const [winnerBalAfter] = await db
      .select({ amount: balances.amount })
      .from(balances)
      .where(eq(balances.userId, WINNER));
    expect(winnerBalAfter.amount).toBe(STARTING_BALANCE - BET_AMOUNT + winnerShares);

    const [loserBalAfter] = await db
      .select({ amount: balances.amount })
      .from(balances)
      .where(eq(balances.userId, LOSER));
    expect(loserBalAfter.amount).toBe(STARTING_BALANCE);

    // ── SettlePayout row emitted for the WINNER on the winning child ───────
    const payoutRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.type, "SettlePayout"));
    const winnerPayout = payoutRows.find((r) => r.userId === WINNER && r.marketId === yesMarketId);
    expect(winnerPayout).toBeDefined();
    const winnerPayload = JSON.parse(winnerPayout!.payload) as { amount: number; kind: string };
    expect(winnerPayload.kind).toBe("win");
    expect(BigInt(winnerPayload.amount)).toBe(winnerShares);

    // ── ResolveMarket row per child ────────────────────────────────────────
    const resolveRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.type, "ResolveMarket"));
    expect(resolveRows).toHaveLength(2);

    // ── Both pools drained ─────────────────────────────────────────────────
    const poolsAfter = await db.select().from(ammPools);
    expect(poolsAfter.every((p) => p.wpmReserve === 0n)).toBe(true);

    // ── Treasury increased by drained pool minus payout (single-bet,
    // single-winner: treasuryDelta = wpmReserve_yes − shares paid, plus
    // wpmReserve_no fully swept since NO market had no winners). ───────────
    const [treasuryAfter] = await db
      .select({ amount: treasury.amount })
      .from(treasury)
      .where(eq(treasury.id, "treasury"));
    expect(treasuryAfter.amount).toBeGreaterThan(treasuryBefore.amount);
  });
});
