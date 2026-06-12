import { and, eq, sum } from "drizzle-orm";
import { db } from "../../db";
import { bets } from "../../db/schema";
import { formatDollars } from "../../utils/format";
import { REGISTER_PROMPT, balanceCents, findUser } from "../../utils/house";
import { telegramProfile } from "../identity";
import type { BotCommand } from "./types";

export const balance: BotCommand = {
  name: "balance",
  description: "Show your available balance",
  usage: "/balance",
  handler: async ({ thread, message }) => {
    const userId = await findUser(telegramProfile(message));
    if (userId == null) {
      await thread.post(REGISTER_PROMPT);
      return;
    }

    const [row] = await db
      .select({ total: sum(bets.costCents) })
      .from(bets)
      .where(and(eq(bets.userId, userId), eq(bets.status, "open")));
    const atRiskCents = Number(row?.total ?? 0);

    await thread.post(
      [
        `Balance: ${formatDollars(await balanceCents(userId))}`,
        `At risk in open bets: ${formatDollars(atRiskCents)}`,
      ].join("\n"),
    );
  },
};
