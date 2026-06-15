import { eq, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/src/db";
import { bets, users } from "@/src/db/schema";
import { displayName } from "@/app/_lib/format";
import { formatCount, formatDollars, formatSignedDollars, formatPercent } from "@/app/_lib/format";

export interface Trophy {
  emoji: string;
  /** The award name. */
  title: string;
  /** The recipient's display name. */
  winner: string;
  /** The damning evidence, pre-formatted. */
  stat: string;
  /** A sarcastic one-liner. */
  blurb: string;
  tone: "gold" | "win" | "loss" | "ice" | "violet";
}

interface PlayerRow {
  name: string;
  bets: number;
  staked: number;
  biggestStake: number;
  wins: number;
  losses: number;
  realized: number;
  biggestWin: number;
  biggestLoss: number;
  avgStake: number;
}

/**
 * Hand out the hardware. Every superlative is computed from one grouped scan of
 * `bets`; awards only appear when a real qualifier exists, so a four-person
 * group on a quiet week never sees a trophy with nobody's name on it.
 */
export async function getTrophies(): Promise<Trophy[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("dashboard", "bets");

  try {
    const rows = await db
      .select({
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        bets: sql<number>`count(${bets.id})::int`,
        staked: sql<number>`coalesce(sum(${bets.costCents}), 0)::int`,
        biggestStake: sql<number>`coalesce(max(${bets.costCents}), 0)::int`,
        wins: sql<number>`count(*) filter (where ${bets.status} = 'won')::int`,
        losses: sql<number>`count(*) filter (where ${bets.status} = 'lost')::int`,
        realized: sql<number>`coalesce(sum(case when ${bets.status} = 'won' then ${bets.contracts} * 100 - ${bets.costCents} when ${bets.status} = 'lost' then -${bets.costCents} else 0 end), 0)::int`,
        biggestWin: sql<number>`coalesce(max(case when ${bets.status} = 'won' then ${bets.contracts} * 100 - ${bets.costCents} end), 0)::int`,
        biggestLoss: sql<number>`coalesce(max(case when ${bets.status} = 'lost' then ${bets.costCents} end), 0)::int`,
      })
      .from(users)
      .leftJoin(bets, eq(bets.userId, users.id))
      .groupBy(users.id);

    const players: PlayerRow[] = rows.map((r) => ({
      name: displayName(r),
      bets: r.bets,
      staked: r.staked,
      biggestStake: r.biggestStake,
      wins: r.wins,
      losses: r.losses,
      realized: r.realized,
      biggestWin: r.biggestWin,
      biggestLoss: r.biggestLoss,
      avgStake: r.bets > 0 ? Math.round(r.staked / r.bets) : 0,
    }));

    const active = players.filter((p) => p.bets > 0);
    if (active.length === 0) return [];

    const trophies: Trophy[] = [];
    const pick = (
      pool: PlayerRow[],
      score: (p: PlayerRow) => number,
      t: Omit<Trophy, "winner" | "stat"> & { stat: (p: PlayerRow) => string },
    ) => {
      if (pool.length === 0) return;
      const winner = pool.reduce((best, p) => (score(p) > score(best) ? p : best));
      if (score(winner) <= 0) return;
      trophies.push({ ...t, winner: winner.name, stat: t.stat(winner) });
    };

    // 🔥 Most bets placed — the one who cannot be stopped.
    pick(active, (p) => p.bets, {
      emoji: "🔥",
      title: "The Degenerate",
      tone: "gold",
      blurb: "Has never met a market they didn't have an opinion on.",
      stat: (p) => `${formatCount(p.bets)} bets placed`,
    });

    // 🐋 Biggest single ticket.
    pick(active, (p) => p.biggestStake, {
      emoji: "🐋",
      title: "The Whale",
      tone: "ice",
      blurb: "Bet sizing is a personality trait, apparently.",
      stat: (p) => `${formatDollars(p.biggestStake)} on one ticket`,
    });

    // 🎯 Best win rate — minimum 3 settled to keep it honest.
    const sharpsPool = active.filter((p) => p.wins + p.losses >= 3);
    pick(sharpsPool, (p) => p.wins / (p.wins + p.losses), {
      emoji: "🎯",
      title: "The Sharp",
      tone: "win",
      blurb: "Insufferable about it, too.",
      stat: (p) =>
        `${formatPercent(p.wins / (p.wins + p.losses))} hit rate (${p.wins}W-${p.losses}L)`,
    });

    // 🧱 Most losses — laying brick after brick.
    pick(active, (p) => p.losses, {
      emoji: "🧱",
      title: "The Bricklayer",
      tone: "loss",
      blurb: "Building a beautiful house, one losing ticket at a time.",
      stat: (p) => `${formatCount(p.losses)} bets lost`,
    });

    // 💸 Biggest single loss.
    pick(active, (p) => p.biggestLoss, {
      emoji: "💸",
      title: "Heartbreak of the Year",
      tone: "loss",
      blurb: "We don't talk about it. They won't shut up about it.",
      stat: (p) => `${formatDollars(p.biggestLoss)} gone in one shot`,
    });

    // 🍀 Biggest single win.
    pick(active, (p) => p.biggestWin, {
      emoji: "🍀",
      title: "The One Good Day",
      tone: "win",
      blurb: "Screenshotted it. Set it as their wallpaper. Living off it.",
      stat: (p) => `+${formatDollars(p.biggestWin)} on a single bet`,
    });

    // 🎢 Highest total volume.
    pick(active, (p) => p.staked, {
      emoji: "🎢",
      title: "All Gas, No Brakes",
      tone: "violet",
      blurb: "Volume is its own reward. Profit is a separate issue.",
      stat: (p) => `${formatDollars(p.staked)} put through the book`,
    });

    // 💀 Worst realized P&L — the house's favorite customer.
    const donor = active.reduce((worst, p) => (p.realized < worst.realized ? p : worst));
    if (donor.realized < 0) {
      trophies.push({
        emoji: "💀",
        title: "House Favorite",
        tone: "loss",
        winner: donor.name,
        stat: `${formatSignedDollars(donor.realized)} realized`,
        blurb: "Single-handedly keeping the lights on. We thank you.",
      });
    }

    // 🪙 Smallest average ticket — min 2 bets, the cautious nickel-nurser.
    const nursersPool = active.filter((p) => p.bets >= 2);
    if (nursersPool.length > 0) {
      const nurser = nursersPool.reduce((min, p) => (p.avgStake < min.avgStake ? p : min));
      trophies.push({
        emoji: "🪙",
        title: "Nickel Nurser",
        tone: "ice",
        winner: nurser.name,
        stat: `${formatDollars(nurser.avgStake)} average ticket`,
        blurb: "Bankroll management, or just scared? Yes.",
      });
    }

    return trophies;
  } catch (err) {
    console.error("getTrophies failed:", err);
    return [];
  }
}
