import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { bets, events, markets } from "../../db/schema";
import { formatDollars, formatEastern } from "../../utils/format";
import { REGISTER_PROMPT, balanceCents, findUser } from "../../utils/house";
import { telegramProfile } from "../identity";
import type { BotCommand } from "./types";

export const mybets: BotCommand = {
  name: "mybets",
  description: "Show your balance and open bets",
  usage: "/mybets",
  handler: async ({ thread, message }) => {
    const userId = await findUser(telegramProfile(message));
    if (userId == null) {
      await thread.post(REGISTER_PROMPT);
      return;
    }

    const open = await db
      .select({
        id: bets.id,
        outcome: markets.outcome,
        side: bets.side,
        contracts: bets.contracts,
        priceCents: bets.priceCents,
        costCents: bets.costCents,
        startsAt: events.startsAt,
      })
      .from(bets)
      .innerJoin(markets, eq(markets.ticker, bets.marketTicker))
      .innerJoin(events, eq(events.eventTicker, markets.eventTicker))
      .where(and(eq(bets.userId, userId), eq(bets.status, "open")))
      .orderBy(asc(events.startsAt), asc(bets.id));

    const atRiskCents = open.reduce((total, bet) => total + bet.costCents, 0);

    const lines = [
      `${message.author.fullName}`,
      `Balance: ${formatDollars(await balanceCents(userId))}`,
      `At risk in open bets: ${formatDollars(atRiskCents)}`,
    ];

    if (open.length === 0) {
      lines.push("", "No open bets. Type /placebet to place one.");
    } else {
      lines.push("", "Open bets, kicking off soonest first:");
      for (const bet of open) {
        lines.push(
          `#${bet.id} ${bet.outcome} ${bet.side.toUpperCase()} — ${bet.contracts} @ ${bet.priceCents}¢ → ${formatDollars(bet.contracts * 100)} · ${bet.startsAt ? formatEastern(bet.startsAt) : "kickoff TBD"}`,
        );
      }
    }

    await thread.post(lines.join("\n"));
  },
};
