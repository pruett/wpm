import { and, eq, sql, sum } from "drizzle-orm";
import { db } from "../db";
import { bets, events, ledger, markets, users } from "../db/schema";

const SEED_CENTS = 10_000_000; // every new user starts with $100,000 of fake money

// Refuse to execute against a stale price mirror (e.g. the sync cron died).
// The Vercel cron (vercel.json) syncs every 5 minutes; 3× the interval lets
// one run fail or arrive late without blocking bets.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PRICE_AGE_MS = 3 * SYNC_INTERVAL_MS;

export type BetSide = "yes" | "no";

/**
 * Telegram identity for a user. `telegramId` is the immutable key; the rest
 * are mutable profile fields. Semantics per field: a string/null value is the
 * user's current state (null = unset on Telegram), `undefined` means the
 * caller doesn't know it and existing data should be left untouched.
 */
export interface TelegramProfile {
  telegramId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
}

/** Reply shown wherever an unregistered user tries to bet. */
export const REGISTER_PROMPT =
  "You must first register to place a bet. Type /start to get started.";

/**
 * Look up a user by Telegram id, refreshing any profile fields the caller
 * knows. Returns null for users who haven't registered yet — accounts are
 * only ever created explicitly, via registerUser.
 */
export async function findUser(profile: TelegramProfile): Promise<number | null> {
  const existing = await db.query.users.findFirst({
    where: eq(users.telegramId, profile.telegramId),
  });
  if (!existing) return null;

  // Usernames and display names change — refresh whatever the caller knows.
  const updates: Partial<typeof users.$inferInsert> = {};
  if (profile.username !== undefined && profile.username !== existing.username)
    updates.username = profile.username;
  if (profile.firstName !== undefined && profile.firstName !== existing.firstName)
    updates.firstName = profile.firstName;
  if (profile.lastName !== undefined && profile.lastName !== existing.lastName)
    updates.lastName = profile.lastName;
  if (profile.languageCode !== undefined && profile.languageCode !== existing.languageCode)
    updates.languageCode = profile.languageCode;
  if (Object.keys(updates).length > 0) {
    await db.update(users).set(updates).where(eq(users.id, existing.id));
  }
  return existing.id;
}

/**
 * Register a user: create their row and seed the ledger with the starting
 * bankroll. Idempotent — re-registering returns the existing account
 * without seeding again.
 */
export async function registerUser(
  profile: TelegramProfile,
): Promise<{ userId: number; created: boolean }> {
  const existing = await findUser(profile);
  if (existing != null) return { userId: existing, created: false };

  const userId = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        telegramId: profile.telegramId,
        username: profile.username ?? null,
        firstName: profile.firstName ?? null,
        lastName: profile.lastName ?? null,
        languageCode: profile.languageCode ?? null,
      })
      .returning({ id: users.id });
    await tx.insert(ledger).values({ userId: user!.id, amountCents: SEED_CENTS, kind: "seed" });
    return user!.id;
  });
  return { userId, created: true };
}

export async function balanceCents(userId: number): Promise<number> {
  const [row] = await db
    .select({ total: sum(ledger.amountCents) })
    .from(ledger)
    .where(eq(ledger.userId, userId));
  return Number(row?.total ?? 0);
}

/**
 * Place a bet against the house at Kalshi's current ask price.
 * Stake buys whole contracts (floor); each contract pays 100¢ on a win.
 */
export async function placeBet(
  profile: TelegramProfile,
  marketTicker: string,
  side: BetSide,
  stakeCents: number,
) {
  const userId = await findUser(profile);
  if (userId == null) throw new Error(REGISTER_PROMPT);
  const [row] = await db
    .select({ market: markets, startsAt: events.startsAt })
    .from(markets)
    .innerJoin(events, eq(events.eventTicker, markets.eventTicker))
    .where(eq(markets.ticker, marketTicker));

  if (!row) throw new Error(`unknown market: ${marketTicker}`);
  const { market, startsAt } = row;

  if (market.status !== "active") {
    throw new Error(`market not open for betting (status: ${market.status})`);
  }
  // Kalshi trades sports in-play, so an active market is not enough — lock at kickoff.
  if (startsAt && startsAt <= new Date()) throw new Error("betting locked: game has started");
  if (market.closeTime <= new Date()) throw new Error("market is past its close time");
  if (Date.now() - market.syncedAt.getTime() > MAX_PRICE_AGE_MS) {
    throw new Error("prices are stale — try again after the next sync");
  }

  const price = side === "yes" ? market.yesAsk : market.noAsk;
  if (!price || price <= 0 || price >= 100) {
    throw new Error(`no usable ${side} price for ${marketTicker}`);
  }

  const contracts = Math.floor(stakeCents / price);
  if (contracts < 1) throw new Error(`stake too small: ${side} costs ${price}¢ per contract`);
  const cost = contracts * price;

  if ((await balanceCents(userId)) < cost) throw new Error("insufficient balance");

  return db.transaction(async (tx) => {
    const [bet] = await tx
      .insert(bets)
      .values({ userId, marketTicker, side, contracts, priceCents: price, costCents: cost })
      .returning({ id: bets.id });
    await tx
      .insert(ledger)
      .values({ userId, amountCents: -cost, kind: "bet_place", betId: bet!.id });
    return { betId: bet!.id, contracts, price, cost };
  });
}

/** Settle all open bets on a market once its result is known. */
export async function settleMarketBets(marketTicker: string, result: BetSide): Promise<number> {
  return db.transaction(async (tx) => {
    // FOR UPDATE: overlapping sweeps would otherwise both read status="open"
    // before either commits and pay the same winner twice.
    const open = await tx
      .select({ id: bets.id, userId: bets.userId, side: bets.side, contracts: bets.contracts })
      .from(bets)
      .where(and(eq(bets.marketTicker, marketTicker), eq(bets.status, "open")))
      .for("update");

    for (const bet of open) {
      const won = bet.side === result;
      await tx
        .update(bets)
        .set({ status: won ? "won" : "lost", settledAt: sql`now()` })
        .where(eq(bets.id, bet.id));
      if (won) {
        await tx.insert(ledger).values({
          userId: bet.userId,
          amountCents: bet.contracts * 100,
          kind: "bet_settle",
          betId: bet.id,
        });
      }
    }
    return open.length;
  });
}

/** Void all open bets on a market (cancelled game etc.) and refund stakes. */
export async function voidMarketBets(marketTicker: string): Promise<number> {
  return db.transaction(async (tx) => {
    const open = await tx
      .select({ id: bets.id, userId: bets.userId, costCents: bets.costCents })
      .from(bets)
      .where(and(eq(bets.marketTicker, marketTicker), eq(bets.status, "open")))
      .for("update");

    for (const bet of open) {
      await tx
        .update(bets)
        .set({ status: "voided", settledAt: sql`now()` })
        .where(eq(bets.id, bet.id));
      await tx.insert(ledger).values({
        userId: bet.userId,
        amountCents: bet.costCents,
        kind: "bet_void",
        betId: bet.id,
      });
    }
    return open.length;
  });
}
