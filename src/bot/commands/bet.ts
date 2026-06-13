import { placebet } from "./placebet";
import type { BotCommand } from "./types";

// Deprecated alias for /placebet, kept alive because Telegram caches the
// slash-command menu per device (a hard refresh is needed to see a rename)
// and muscle memory outlives the cache. Forwards to the renamed command after
// a one-line nudge so users learn the new name. Drop this once telemetry shows
// /bet has gone quiet.
export const bet: BotCommand = {
  name: "bet",
  description: `Renamed → ${placebet.usage}`,
  usage: "/bet",
  handler: async (ctx) => {
    await ctx.thread.post(`Heads up: /bet is now ${placebet.usage} — running it for you.`);
    await placebet.handler(ctx);
  },
};
