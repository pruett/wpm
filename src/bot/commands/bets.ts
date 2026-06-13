import { showbets } from "./showbets";
import type { BotCommand } from "./types";

// Deprecated alias for /showbets, kept alive because Telegram caches the
// slash-command menu per device (a hard refresh is needed to see a rename)
// and muscle memory outlives the cache. Forwards to the renamed command after
// a one-line nudge so users learn the new name. Drop this once telemetry shows
// /bets has gone quiet.
export const bets: BotCommand = {
  name: "bets",
  description: `Renamed → ${showbets.usage}`,
  usage: "/bets",
  handler: async (ctx) => {
    await ctx.thread.post(`Heads up: /bets is now ${showbets.usage} — running it for you.`);
    await showbets.handler(ctx);
  },
};
