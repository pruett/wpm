import { eq, sum } from "drizzle-orm";
import { db } from "../../db";
import { bets, ledger, users } from "../../db/schema";
import { displayName, formatDollars } from "../../utils/format";
import type { BotCommand } from "./types";

const MEDALS = ["🥇", "🥈", "🥉"];

export const leaderboard: BotCommand = {
  name: "leaderboard",
  description: "Rank all players by total bankroll (cash + open bets)",
  usage: "/leaderboard",
  handler: async ({ thread }) => {
    // Total bankroll = cash on hand (the ledger sum) plus the stake tied up in
    // still-open bets. Open positions are valued at cost — the same "At Risk"
    // figure /mybets shows — so placing a bet on a future game is neutral to
    // your standing instead of sinking you until it settles.
    const cashRows = await db
      .select({
        id: users.id,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        cashCents: sum(ledger.amountCents),
      })
      .from(users)
      .leftJoin(ledger, eq(ledger.userId, users.id))
      .groupBy(users.id);

    const openRows = await db
      .select({
        userId: bets.userId,
        atRiskCents: sum(bets.costCents),
      })
      .from(bets)
      .where(eq(bets.status, "open"))
      .groupBy(bets.userId);

    const atRisk = new Map(openRows.map((row) => [row.userId, Number(row.atRiskCents ?? 0)]));

    const ranked = cashRows
      .map((row) => ({
        ...row,
        totalCents: Number(row.cashCents ?? 0) + (atRisk.get(row.id) ?? 0),
      }))
      .sort((a, b) => b.totalCents - a.totalCents);

    if (ranked.length === 0) {
      await thread.post("No players yet — type /start to open an account.");
      return;
    }

    const lines = ranked.map((row, i) => {
      const rank = MEDALS[i] ?? `${i + 1}.`;
      return `${rank} ${displayName(row)} — ${formatDollars(row.totalCents)}`;
    });
    await thread.post(["🏆 Leaderboard", "", ...lines].join("\n"));
  },
};
