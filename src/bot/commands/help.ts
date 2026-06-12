import type { BotCommand } from "./types";

export const help: BotCommand = {
  name: "help",
  description: "List available commands",
  usage: "/help",
  handler: async ({ thread }) => {
    // Imported lazily: the registry imports this file, so a top-level import
    // of "./index" here would be circular at module-eval time.
    const { commands } = await import("./index");
    const lines = commands.map((c) => `${c.usage} — ${c.description}`);
    await thread.post(["Commands:", "", ...lines].join("\n"));
  },
};
