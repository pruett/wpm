import type { Message, Thread } from "chat";
import { leaderboard } from "./leaderboard";
import { placebet } from "./placebet";
import { showbets } from "./showbets";
import { mybets } from "./mybets";
import { bet } from "./bet";
import { bets } from "./bets";
import { gift } from "./gift";
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

// Canonical commands drive /help. Deprecated aliases (old names of renamed
// commands — each forwards to its replacement with a nudge) are appended for
// dispatch and the Telegram menu only, kept out of /help so it always teaches
// the current names. Retire an alias by deleting its file and its entry here.
export const commands: BotCommand[] = [start, help, placebet, showbets, mybets, leaderboard];

const deprecatedCommands: BotCommand[] = [bet, bets, me];

// Admin-only commands: dispatchable, but hidden from /help AND the Telegram
// command menu — a public menu entry would just invite everyone to poke at a
// command that refuses them. Gated inside each handler (TELEGRAM_ADMIN_IDS).
const adminCommands: BotCommand[] = [gift];

// What setMyCommands publishes as the visible Telegram menu.
export const menuCommands: BotCommand[] = [...commands, ...deprecatedCommands];

export const allCommands: BotCommand[] = [...menuCommands, ...adminCommands];

const byName = new Map(allCommands.map((c) => [c.name, c]));

// Telegram has no native slash-command event in the Chat SDK (Slack/Discord
// only), so commands arrive as plain message text. In groups they carry the
// bot username ("/placebet@OurBot yes 5") — strip it before matching.
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
