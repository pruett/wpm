import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const { ammPools, balances, markets, positions, transactions, treasury, user } =
  await import("@/lib/db/schema");
const { createMarket, resolveMarket } = await import("@/data/markets");
const { placeBet } = await import("@/data/trading");

const MARKET_ID = "MKT-INT-1";
const SEED_AMOUNT = 1_000_000n;
const STARTING_BALANCE = 10_000n;

type Bettor = {
  id: string;
  outcome: "A" | "B";
  amount: bigint;
};

const BETTORS: Bettor[] = [
  { id: "u-alice", outcome: "A", amount: 500n },
  { id: "u-bob", outcome: "A", amount: 1_500n },
  { id: "u-carol", outcome: "A", amount: 250n },
  { id: "u-dave", outcome: "B", amount: 2_000n },
  { id: "u-erin", outcome: "B", amount: 800n },
];

async function truncateAll() {
  // Order matters due to FKs; CASCADE makes it safe regardless.
  await client.unsafe(`
    SET client_min_messages TO WARNING;
    TRUNCATE TABLE
      transactions, positions, amm_pools, markets,
      balances, treasury, "user"
    CASCADE
  `);
}

beforeAll(async () => {
  // Confirm DB connectivity early — otherwise errors are confusing.
  await client`SELECT 1`;
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll();
});

describe("end-to-end: bet → resolve with 5 bettors", () => {
  it("debits each bettor, pays winners 1:1 in WPM, leaves losers flat, balances the pool", async () => {
    // ── Seed: treasury, users, balances ────────────────────────────────────
    await db.insert(treasury).values({ id: "treasury", amount: 100_000_000n });

    for (const b of BETTORS) {
      await db.insert(user).values({
        id: b.id,
        name: b.id,
        email: `${b.id}@test.local`,
        emailVerified: true,
      });
      await db.insert(balances).values({ userId: b.id, amount: STARTING_BALANCE });
    }

    // ── Create the market via the production DAL ───────────────────────────
    const created = await createMarket({
      market: {
        id: MARKET_ID,
        sport: "test",
        name: "Test Market",
        teamA: "A",
        teamB: "B",
        tickerA: null,
        tickerB: null,
        closesAt: Date.now() + 60 * 60 * 1000,
        resolvedOutcome: null,
        resolvedAt: null,
      },
      seedAmount: SEED_AMOUNT,
      initialProbabilityA: 0.5,
    });
    expect(created).toEqual({ created: true });

    // ── Each bettor places one bet ─────────────────────────────────────────
    const sharesByUser = new Map<string, bigint>();
    for (const b of BETTORS) {
      currentUserId = b.id;
      const result = await placeBet({
        marketId: MARKET_ID,
        outcome: b.outcome,
        amount: Number(b.amount),
      });
      expect(result.userId).toBe(b.id);

      // Confirm balance was debited by exactly the bet amount.
      const [bal] = await db
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, b.id));
      expect(bal.amount).toBe(STARTING_BALANCE - b.amount);

      // Confirm position row matches what AMM logic produced.
      const [pos] = await db.select().from(positions).where(eq(positions.userId, b.id));
      const shares = b.outcome === "A" ? pos.sharesA : pos.sharesB;
      expect(shares).toBeGreaterThan(0n);
      expect(b.outcome === "A" ? pos.sharesB : pos.sharesA).toBe(0n);
      expect(pos.costBasis).toBe(b.amount);
      sharesByUser.set(b.id, shares);
    }
    currentUserId = null;

    // ── Pool: liquidity grew by exactly the sum of all bets ────────────────
    const totalIn = BETTORS.reduce((s, b) => s + b.amount, 0n);
    const [poolBefore] = await db.select().from(ammPools).where(eq(ammPools.marketId, MARKET_ID));
    expect(poolBefore.wpmReserve).toBe(SEED_AMOUNT + totalIn);

    // ── Snapshot pre-resolve treasury & balances ───────────────────────────
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

    // ── Resolve to A: alice/bob/carol win, dave/erin lose ──────────────────
    const resolved = await resolveMarket(MARKET_ID, "A");
    expect(resolved.resolved).toBe(true);

    // ── Winners: balance increased by exactly their winning shares ─────────
    for (const b of BETTORS) {
      const [row] = await db
        .select({ amount: balances.amount })
        .from(balances)
        .where(eq(balances.userId, b.id));
      const before = balancesBefore.get(b.id)!;
      const shares = sharesByUser.get(b.id)!;

      if (b.outcome === "A") {
        expect(row.amount).toBe(before + shares);
      } else {
        // Losers: flat.
        expect(row.amount).toBe(before);
      }
    }

    // ── Pool drained ───────────────────────────────────────────────────────
    const [poolAfter] = await db.select().from(ammPools).where(eq(ammPools.marketId, MARKET_ID));
    expect(poolAfter.wpmReserve).toBe(0n);

    // ── Treasury conservation: poolBefore.wpmReserve = winning payouts +
    //    treasury delta − backstop. So treasury_after − treasury_before
    //    equals (poolBefore.wpmReserve − totalWinningShares). ──────────────
    const totalWinningShares = BETTORS.filter((b) => b.outcome === "A").reduce(
      (s, b) => s + sharesByUser.get(b.id)!,
      0n,
    );
    const [treasuryAfter] = await db
      .select({ amount: treasury.amount })
      .from(treasury)
      .where(eq(treasury.id, "treasury"));
    expect(treasuryAfter.amount - treasuryBefore.amount).toBe(
      poolBefore.wpmReserve - totalWinningShares,
    );

    // ── Market status flipped to resolved with the right outcome ──────────
    const [m] = await db.select().from(markets).where(eq(markets.id, MARKET_ID));
    expect(m.status).toBe("resolved");
    expect(m.resolvedOutcome).toBe("A");

    // ── Ledger has a SettlePayout row for every bettor (win or loss) ──────
    const payoutRows = await db
      .select({ userId: transactions.userId })
      .from(transactions)
      .where(eq(transactions.type, "SettlePayout"));
    const payoutUsers = new Set(payoutRows.map((r) => r.userId));
    for (const b of BETTORS) expect(payoutUsers.has(b.id)).toBe(true);

    // ── Global conservation: every WPM is accounted for ────────────────────
    // Initial system WPM = treasury_initial + sum(starting balances).
    // Final system WPM = treasury_after + sum(all balances) + pool_after.
    const [{ amount: treasuryNow }] = await db.select({ amount: treasury.amount }).from(treasury);
    const allBalances = await db.select({ amount: balances.amount }).from(balances);
    const totalUserBalance = allBalances.reduce((s, r) => s + r.amount, 0n);

    const initialSystem = 100_000_000n + STARTING_BALANCE * BigInt(BETTORS.length);
    const finalSystem = treasuryNow + totalUserBalance + poolAfter.wpmReserve;
    expect(finalSystem).toBe(initialSystem);
  });
});
