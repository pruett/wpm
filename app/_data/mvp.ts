import { cacheLife, cacheTag } from "next/cache";
import { collectWeeklyStats } from "@/src/utils/summary";
import { displayName, initials } from "@/app/_lib/format";

export interface MvpHighlight {
  outcome: string;
  title: string;
  side: "yes" | "no";
  profitCents: number;
}

export interface MvpRunnerUp {
  name: string;
  realizedCents: number;
  wins: number;
  losses: number;
}

export interface MvpData {
  /** Whether anything happened in the trailing 7 days at all. */
  hasActivity: boolean;
  name: string;
  initials: string;
  seed: string;
  realizedCents: number;
  wins: number;
  losses: number;
  voids: number;
  betsPlaced: number;
  stakedCents: number;
  /** True when the MVP is actually up money — vs. merely the least underwater. */
  positive: boolean;
  biggestWin: MvpHighlight | null;
  runnersUp: MvpRunnerUp[];
  weekBets: number;
  weekStakedCents: number;
}

/**
 * This week's headline act. Reuses the bot's exact weekly tally
 * (collectWeeklyStats) so the web MVP and the Sunday Rundown can never
 * disagree about who had the best — or least catastrophic — week.
 */
export async function getMvp(): Promise<MvpData | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("dashboard", "bets");

  try {
    const stats = await collectWeeklyStats();
    const top = stats.players[0];
    if (!top) return null;

    return {
      hasActivity: stats.betsPlaced > 0 || stats.betsSettled > 0,
      name: displayName(top.user),
      initials: initials(top.user),
      seed: top.user.telegramId,
      realizedCents: top.realizedCents,
      wins: top.wins,
      losses: top.losses,
      voids: top.voids,
      betsPlaced: top.betsPlaced,
      stakedCents: top.stakedCents,
      positive: top.realizedCents > 0,
      biggestWin:
        stats.biggestWin && stats.biggestWin.user.id === top.user.id
          ? {
              outcome: stats.biggestWin.outcome,
              title: stats.biggestWin.title,
              side: stats.biggestWin.side,
              profitCents: stats.biggestWin.profitCents,
            }
          : null,
      runnersUp: stats.players.slice(1, 3).map((p) => ({
        name: displayName(p.user),
        realizedCents: p.realizedCents,
        wins: p.wins,
        losses: p.losses,
      })),
      weekBets: stats.betsPlaced,
      weekStakedCents: stats.totalStakedCents,
    };
  } catch (err) {
    console.error("getMvp failed:", err);
    return null;
  }
}
