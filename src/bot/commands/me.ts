import { mybets } from "./mybets";
import type { BotCommand } from "./types";

// Deprecated alias for /mybets, kept alive because Telegram caches the
// slash-command menu per device (a hard refresh is needed to see a rename)
// and muscle memory outlives the cache. Forwards to the renamed command after
// a one-line nudge so users learn the new name. Drop this once telemetry shows
// /me has gone quiet.
export const me: BotCommand = {
  name: "me",
  description: `Renamed → ${mybets.usage}`,
  usage: "/me",
  handler: async (ctx) => {
    await ctx.thread.post(`Heads up: /me is now ${mybets.usage} — running it for you.`);
    await mybets.handler(ctx);
  },
};
