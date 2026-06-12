import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { bets as betsTable, markets } from "../../db/schema";
import { formatDollars } from "../../utils/format";
import { REGISTER_PROMPT, findUser } from "../../utils/house";
import { telegramProfile } from "../identity";
import type { BotCommand } from "./types";

export const bets: BotCommand = {
  name: "bets",
  description: "Show your open bets",
  usage: "/bets",
  handler: async ({ thread, message }) => {
    const userId = await findUser(telegramProfile(message));
    if (userId == null) {
      await thread.post(REGISTER_PROMPT);
      return;
    }

    const open = await db
      .select({
        id: betsTable.id,
        marketTicker: betsTable.marketTicker,
        outcome: markets.outcome,
        side: betsTable.side,
        contracts: betsTable.contracts,
        priceCents: betsTable.priceCents,
        costCents: betsTable.costCents,
      })
      .from(betsTable)
      .innerJoin(markets, eq(markets.ticker, betsTable.marketTicker))
      .where(and(eq(betsTable.userId, userId), eq(betsTable.status, "open")))
      .orderBy(asc(betsTable.id));

    if (open.length === 0) {
      await thread.post("You have no open bets. Type /bet to place one.");
      return;
    }

    const lines = [`Open bets for ${message.author.fullName}:`];
    for (const bet of open) {
      lines.push(
        "",
        `#${bet.id} ${bet.outcome} ${bet.side.toUpperCase()} — ${bet.contracts} shares @ ${bet.priceCents}¢`,
        `  Cost ${formatDollars(bet.costCents)}, pays ${formatDollars(bet.contracts * 100)} (${bet.marketTicker})`,
      );
    }

    await thread.post(lines.join("\n"));
  },
};
