import { desc, eq, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/src/db";
import { bets, events, markets, users } from "@/src/db/schema";
import { displayName } from "@/app/_lib/format";

export interface BiggestHit {
  name: string;
  profitCents: number;
  outcome: string;
  title: string;
  side: "yes" | "no";
}

export interface PoolStats {
  /** The single most profitable winning bet ever struck. */
  biggestHit: BiggestHit | null;
  openBets: number;
  atRiskCents: number;
  contractsInPlay: number;
  /** Settled win rate, 0–1. */
  winRate: number | null;
  settled: number;
  avgStakeCents: number | null;
  /** House net P&L (cents): stakes collected minus winnings paid out. */
  houseNetCents: number;
  /** House edge over settled volume, 0–1 (can be negative if the house is losing). */
  houseEdge: number | null;
}

const EMPTY: PoolStats = {
  biggestHit: null,
  openBets: 0,
  atRiskCents: 0,
  contractsInPlay: 0,
  winRate: null,
  settled: 0,
  avgStakeCents: null,
  houseNetCents: 0,
  houseEdge: null,
};

/**
 * The book's vital signs: hit rate, average ticket, exposure currently in the
 * air, the all-time biggest single score, and the house's running take.
 */
export async function getPoolStats(): Promise<PoolStats> {
  "use cache";
  cacheLife("hours");
  cacheTag("dashboard", "bets");

  try {
    const [agg] = await db
      .select({
        open: sql<number>`count(*) filter (where ${bets.status} = 'open')::int`,
        atRisk: sql<number>`coalesce(sum(${bets.costCents}) filter (where ${bets.status} = 'open'), 0)::int`,
        contracts: sql<number>`coalesce(sum(${bets.contracts}) filter (where ${bets.status} = 'open'), 0)::int`,
        wins: sql<number>`count(*) filter (where ${bets.status} = 'won')::int`,
        losses: sql<number>`count(*) filter (where ${bets.status} = 'lost')::int`,
        avgStake: sql<number | null>`avg(${bets.costCents})::float`,
        // Stakes the house took on every settled (won/lost) ticket...
        settledStake: sql<number>`coalesce(sum(${bets.costCents}) filter (where ${bets.status} in ('won','lost')), 0)::int`,
        // ...minus the dollar paid back out on the winners.
        paidOut: sql<number>`coalesce(sum(${bets.contracts} * 100) filter (where ${bets.status} = 'won'), 0)::int`,
      })
      .from(bets);

    if (!agg) return EMPTY;

    const settled = agg.wins + agg.losses;
    const houseNetCents = agg.settledStake - agg.paidOut;

    // Biggest single winning ticket, with the market it landed on.
    const [hit] = await db
      .select({
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        contracts: bets.contracts,
        costCents: bets.costCents,
        side: bets.side,
        outcome: markets.outcome,
        title: events.title,
      })
      .from(bets)
      .innerJoin(users, eq(users.id, bets.userId))
      .innerJoin(markets, eq(markets.ticker, bets.marketTicker))
      .innerJoin(events, eq(events.eventTicker, markets.eventTicker))
      .where(eq(bets.status, "won"))
      .orderBy(desc(sql`${bets.contracts} * 100 - ${bets.costCents}`))
      .limit(1);

    const biggestHit: BiggestHit | null = hit
      ? {
          name: displayName(hit),
          profitCents: hit.contracts * 100 - hit.costCents,
          outcome: hit.outcome,
          title: hit.title,
          side: hit.side,
        }
      : null;

    return {
      biggestHit,
      openBets: agg.open,
      atRiskCents: agg.atRisk,
      contractsInPlay: agg.contracts,
      winRate: settled > 0 ? agg.wins / settled : null,
      settled,
      avgStakeCents: agg.avgStake != null ? Math.round(agg.avgStake) : null,
      houseNetCents,
      houseEdge: agg.settledStake > 0 ? houseNetCents / agg.settledStake : null,
    };
  } catch (err) {
    console.error("getPoolStats failed:", err);
    return EMPTY;
  }
}
