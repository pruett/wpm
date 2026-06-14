import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { bets, events, markets } from "../../db/schema";
import { seriesEmoji } from "../../kalshi/series";
import { formatDollars, formatEasternShort } from "../../utils/format";
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
        title: events.title,
        seriesTicker: events.seriesTicker,
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
      `💵 Balance: **${formatDollars(await balanceCents(userId))}**`,
      `⏳ Pending / At Risk: **${formatDollars(atRiskCents)}**`,
    ];

    if (open.length === 0) {
      lines.push("", "No open bets. Type /placebet to place one.");
    } else {
      lines.push("", "All bets:");
      for (const bet of open) {
        const kickoff = bet.startsAt ? formatEasternShort(bet.startsAt) : "kickoff TBD";
        lines.push(
          `${seriesEmoji(bet.seriesTicker)} **${bet.outcome}** in *${bet.title}* - betting **${formatDollars(bet.costCents)}** to win **${formatDollars(bet.contracts * 100)}** · ${kickoff}`,
        );
      }
    }

    await thread.post({ markdown: lines.join("\n") });
  },
};
