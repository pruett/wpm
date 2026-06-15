import { sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/src/db";
import { bets, users } from "@/src/db/schema";
import { timeAgo } from "@/app/_lib/format";

export interface Overview {
  totalBets: number;
  totalWageredCents: number;
  players: number;
  openBets: number;
  settledBets: number;
  wins: number;
  losses: number;
  voids: number;
  atRiskCents: number;
  lastBetAt: Date | null;
  /** "2h ago" relative to cache-generation time; refreshed each revalidation. */
  lastBetLabel: string | null;
}

const EMPTY: Overview = {
  totalBets: 0,
  totalWageredCents: 0,
  players: 0,
  openBets: 0,
  settledBets: 0,
  wins: 0,
  losses: 0,
  voids: 0,
  atRiskCents: 0,
  lastBetAt: null,
  lastBetLabel: null,
};

/**
 * Top-line tape for the hero strip: lifetime volume, the headcount, and how
 * much fake money is currently in the air. One scan of `bets` plus a headcount.
 */
export async function getOverview(): Promise<Overview> {
  "use cache";
  cacheLife("hours");
  cacheTag("dashboard", "bets");

  try {
    const [betAgg] = await db
      .select({
        totalBets: sql<number>`count(*)::int`,
        totalWagered: sql<number>`coalesce(sum(${bets.costCents}), 0)::int`,
        open: sql<number>`count(*) filter (where ${bets.status} = 'open')::int`,
        won: sql<number>`count(*) filter (where ${bets.status} = 'won')::int`,
        lost: sql<number>`count(*) filter (where ${bets.status} = 'lost')::int`,
        voided: sql<number>`count(*) filter (where ${bets.status} = 'voided')::int`,
        atRisk: sql<number>`coalesce(sum(${bets.costCents}) filter (where ${bets.status} = 'open'), 0)::int`,
        lastBet: sql<string | null>`max(${bets.createdAt})`,
      })
      .from(bets);

    const [playerAgg] = await db
      .select({ players: sql<number>`count(*)::int` })
      .from(users);

    if (!betAgg) return EMPTY;

    const lastBetAt = betAgg.lastBet ? new Date(betAgg.lastBet) : null;

    return {
      totalBets: betAgg.totalBets,
      totalWageredCents: betAgg.totalWagered,
      players: playerAgg?.players ?? 0,
      openBets: betAgg.open,
      settledBets: betAgg.won + betAgg.lost,
      wins: betAgg.won,
      losses: betAgg.lost,
      voids: betAgg.voided,
      atRiskCents: betAgg.atRisk,
      lastBetAt,
      lastBetLabel: lastBetAt ? timeAgo(lastBetAt) : null,
    };
  } catch (err) {
    console.error("getOverview failed:", err);
    return EMPTY;
  }
}
