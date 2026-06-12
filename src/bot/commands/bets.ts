import { MOCK_BETS, formatCents } from "./mocks";
import type { BotCommand } from "./types";

export const bets: BotCommand = {
  name: "bets",
  description: "Show your open bets",
  usage: "/bets",
  handler: async ({ thread, message }) => {
    const open = MOCK_BETS.filter((b) => b.status === "open");
    if (open.length === 0) {
      await thread.post("You have no open bets. Type /bet to place one.");
      return;
    }

    const lines = [`Open bets for ${message.author.fullName}:`];
    for (const bet of open) {
      lines.push(
        "",
        `#${bet.id} ${bet.outcome} ${bet.side.toUpperCase()} — ${bet.contracts} @ ${bet.priceCents}¢`,
        `  Cost ${formatCents(bet.costCents)}, pays ${formatCents(bet.contracts * 100)} (${bet.marketTicker})`,
      );
    }

    await thread.post(lines.join("\n"));
  },
};
