import { MOCK_BALANCE_CENTS, MOCK_BETS, formatCents } from "./mocks";
import type { BotCommand } from "./types";

export const balance: BotCommand = {
  name: "balance",
  description: "Show your available balance",
  usage: "/balance",
  handler: async ({ thread }) => {
    const atRiskCents = MOCK_BETS.filter((b) => b.status === "open").reduce(
      (sum, b) => sum + b.costCents,
      0,
    );

    await thread.post(
      [
        `Balance: ${formatCents(MOCK_BALANCE_CENTS)}`,
        `At risk in open bets: ${formatCents(atRiskCents)}`,
      ].join("\n"),
    );
  },
};
