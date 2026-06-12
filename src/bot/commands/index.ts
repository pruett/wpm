import type { Message, Thread } from "chat";
import { leaderboard } from "./leaderboard";
import { bet } from "./bet";
import { bets } from "./bets";
import { me } from "./me";
import { start } from "./start";
import type { BotCommand } from "./types";

export type { BotCommand, CommandContext } from "./types";

// /help enumerates the registry it belongs to, so it lives here beside the
// array — in its own module it could only see the list through a circular
// import back into this file.
const help: BotCommand = {
  name: "help",
  description: "List available commands",
  usage: "/help",
  handler: async ({ thread }) => {
    const lines = commands.map((c) => `${c.usage} — ${c.description}`);
    await thread.post(["Commands:", "", ...lines].join("\n"));
  },
};

export const commands: BotCommand[] = [start, help, bet, bets, me, leaderboard];

const byName = new Map(commands.map((c) => [c.name, c]));

// Telegram has no native slash-command event in the Chat SDK (Slack/Discord
// only), so commands arrive as plain message text. In groups they carry the
// bot username ("/bet@OurBot yes 5") — strip it before matching.
const COMMAND_RE = /^\/([a-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i;

/**
 * Parse a message as a slash command and run its handler.
 * Returns false when the message isn't a command, so callers can fall
 * through to non-command handling.
 */
export async function dispatchCommand(thread: Thread, message: Message): Promise<boolean> {
  const match = COMMAND_RE.exec(message.text?.trim() ?? "");
  if (!match) return false;

  const [, name, rest = ""] = match;
  const command = byName.get(name!.toLowerCase());
  if (!command) {
    await thread.post(`Unknown command /${name}. Try /help.`);
    return true;
  }

  const args = rest.trim() === "" ? [] : rest.trim().split(/\s+/);
  await command.handler({ thread, message, args });
  return true;
}
