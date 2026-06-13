import type { Message, Thread } from "chat";

export interface CommandContext {
  thread: Thread;
  message: Message;
  /** Whitespace-split tokens after the command name. */
  args: string[];
}

export interface BotCommand {
  /** Name without the leading slash, e.g. "bet". */
  name: string;
  /** One-line summary shown in /help. */
  description: string;
  /** Invocation shape, e.g. "/placebet <ticker> <yes|no> <contracts>". */
  usage: string;
  handler: (ctx: CommandContext) => Promise<void>;
}
