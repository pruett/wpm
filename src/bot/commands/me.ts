import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { bets, markets } from "../../db/schema";
import { formatDollars, formatEastern } from "../../utils/format";
import { REGISTER_PROMPT, balanceCents, findUser } from "../../utils/house";
import { telegramProfile } from "../identity";
import type { BotCommand } from "./types";

export const me: BotCommand = {
  name: "me",
  description: "Show your balance and open bets",
  usage: "/me",
  handler: async ({ thread, message }) => {
    const userId = await findUser(telegramProfile(message));
    if (userId == null) {
      await thread.post(REGISTER_PROMPT);
      return;
    }

    const open = await db
      .select({
        id: bets.id,
        marketTicker: bets.marketTicker,
        outcome: markets.outcome,
        side: bets.side,
        contracts: bets.contracts,
        priceCents: bets.priceCents,
        costCents: bets.costCents,
        closeTime: markets.closeTime,
      })
      .from(bets)
      .innerJoin(markets, eq(markets.ticker, bets.marketTicker))
      .where(and(eq(bets.userId, userId), eq(bets.status, "open")))
      .orderBy(asc(markets.closeTime), asc(bets.id));

    const atRiskCents = open.reduce((total, bet) => total + bet.costCents, 0);

    const lines = [
      `${message.author.fullName}`,
      `Balance: ${formatDollars(await balanceCents(userId))}`,
      `At risk in open bets: ${formatDollars(atRiskCents)}`,
    ];

    if (open.length === 0) {
      lines.push("", "No open bets. Type /bet to place one.");
    } else {
      lines.push("", "Open bets, closing soonest first:");
      for (const bet of open) {
        lines.push(
          "",
          `#${bet.id} ${bet.outcome} ${bet.side.toUpperCase()} — ${bet.contracts} shares @ ${bet.priceCents}¢`,
          `  Cost ${formatDollars(bet.costCents)}, pays ${formatDollars(bet.contracts * 100)} (${bet.marketTicker})`,
          `  Closes ${formatEastern(bet.closeTime)}`,
        );
      }
    }

    await thread.post(lines.join("\n"));
  },
};
