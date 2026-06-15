import { eq, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/src/db";
import { bets, ledger, users } from "@/src/db/schema";
import { displayName, initials } from "@/app/_lib/format";

export interface Standing {
  id: number;
  name: string;
  initials: string;
  /** Total bankroll = cash on hand + stake tied up in still-open bets. */
  totalCents: number;
  cashCents: number;
  atRiskCents: number;
  wins: number;
  losses: number;
  openBets: number;
  /** Realized P&L from settled bets (cents). */
  realizedCents: number;
}

/**
 * The pecking order. Bankroll mirrors the bot's /leaderboard: cash (the ledger
 * sum) plus the cost of still-open positions, so a pending bet is neutral to
 * your standing rather than sinking you until it settles. Everyone seeds at
 * $100,000, so distance from that line is lifetime profit or shame.
 */
export async function getLeaderboard(): Promise<Standing[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("dashboard", "bets", "ledger");

  try {
    const cashRows = await db
      .select({
        id: users.id,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        cashCents: sql<number>`coalesce(sum(${ledger.amountCents}), 0)::int`,
      })
      .from(users)
      .leftJoin(ledger, eq(ledger.userId, users.id))
      .groupBy(users.id);

    const betRows = await db
      .select({
        userId: bets.userId,
        atRisk: sql<number>`coalesce(sum(${bets.costCents}) filter (where ${bets.status} = 'open'), 0)::int`,
        open: sql<number>`count(*) filter (where ${bets.status} = 'open')::int`,
        wins: sql<number>`count(*) filter (where ${bets.status} = 'won')::int`,
        losses: sql<number>`count(*) filter (where ${bets.status} = 'lost')::int`,
        realized: sql<number>`coalesce(sum(case when ${bets.status} = 'won' then ${bets.contracts} * 100 - ${bets.costCents} when ${bets.status} = 'lost' then -${bets.costCents} else 0 end), 0)::int`,
      })
      .from(bets)
      .groupBy(bets.userId);

    const byUser = new Map(betRows.map((r) => [r.userId, r]));

    return cashRows
      .map((row) => {
        const b = byUser.get(row.id);
        const atRiskCents = b?.atRisk ?? 0;
        return {
          id: row.id,
          name: displayName(row),
          initials: initials(row),
          totalCents: row.cashCents + atRiskCents,
          cashCents: row.cashCents,
          atRiskCents,
          wins: b?.wins ?? 0,
          losses: b?.losses ?? 0,
          openBets: b?.open ?? 0,
          realizedCents: b?.realized ?? 0,
        };
      })
      .sort((a, b) => b.totalCents - a.totalCents);
  } catch (err) {
    console.error("getLeaderboard failed:", err);
    return [];
  }
}
