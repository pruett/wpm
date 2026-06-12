import { desc, eq, sum } from "drizzle-orm";
import { db } from "../../db";
import { ledger, users } from "../../db/schema";
import { formatDollars } from "../../utils/format";
import type { BotCommand } from "./types";

// Display only — usernames are mutable, so this is never used as identity.
function displayName(u: {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
  if (full) return full;
  if (u.username) return `@${u.username}`;
  return "Anonymous";
}

const MEDALS = ["🥇", "🥈", "🥉"];

export const leaderboard: BotCommand = {
  name: "leaderboard",
  description: "Rank all players by current balance",
  usage: "/leaderboard",
  handler: async ({ thread }) => {
    const balance = sum(ledger.amountCents);
    const rows = await db
      .select({
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        balanceCents: balance,
      })
      .from(ledger)
      .innerJoin(users, eq(users.id, ledger.userId))
      .groupBy(users.id)
      .orderBy(desc(balance));

    if (rows.length === 0) {
      await thread.post("No players yet — type /start to open an account.");
      return;
    }

    const lines = rows.map((row, i) => {
      const rank = MEDALS[i] ?? `${i + 1}.`;
      return `${rank} ${displayName(row)} — ${formatDollars(Number(row.balanceCents ?? 0))}`;
    });
    await thread.post(["🏆 Leaderboard", "", ...lines].join("\n"));
  },
};
