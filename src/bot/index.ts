import { Chat } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createMemoryState } from "@chat-adapter/state-memory";
import { dispatchCommand } from "./commands";
import {
  BACK_TO_EVENTS_ACTION,
  PICK_AMOUNT_ACTION,
  PICK_EVENT_ACTION,
  PICK_OUTCOME_ACTION,
  handleBackToEvents,
  handleBetReply,
  handlePickAmount,
  handlePickEvent,
  handlePickOutcome,
} from "./commands/markets";

// The adapter reads TELEGRAM_BOT_TOKEN from the environment.
// Polling mode pulls updates from Telegram via getUpdates —
// no public URL, tunnel, or webhook registration needed.
export const telegram = createTelegramAdapter({
  mode: "polling",
});

export const bot = new Chat({
  userName: process.env.TELEGRAM_BOT_USERNAME ?? "bot",
  adapters: { telegram },
  // Memory state resets on restart — swap for Redis/Postgres later.
  state: createMemoryState(),
});

// Bot @-mentioned in a group chat we aren't following yet.
// Subscribing routes all future group messages to onSubscribedMessage —
// but Telegram only delivers non-mention group messages if privacy mode
// is disabled in BotFather (/setprivacy → Disable).
bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  if (await dispatchCommand(thread, message)) return;
  await thread.post(
    `Hi ${message.author.fullName}! I'm now listening to this group. Try /help.`,
  );
});

// First DM from a user in a thread we aren't following yet.
// Telegram sends "/start" when a user first opens the bot, so this
// usually routes straight to the start command.
bot.onDirectMessage(async (thread, message) => {
  await thread.subscribe();
  if (await dispatchCommand(thread, message)) return;
  if (await handleBetReply(thread, message)) return;
  await thread.post("Hello! I respond to slash commands — try /help.");
});

// The /bet menu is one message that edits itself as users navigate:
// event list → outcomes → amount picker → back to event list.
bot.onAction(PICK_EVENT_ACTION, handlePickEvent);
bot.onAction(PICK_OUTCOME_ACTION, handlePickOutcome);
bot.onAction(PICK_AMOUNT_ACTION, handlePickAmount);
bot.onAction(BACK_TO_EVENTS_ACTION, handleBackToEvents);

// Slash command in a group thread we aren't subscribed to. Subscription
// state is in-memory and wiped on every dev restart — without this, group
// commands are silently dropped until someone @-mentions the bot again.
// Routing is mutually exclusive (DM → subscribed → mention → patterns),
// so this never double-fires with the handlers above.
bot.onNewMessage(/^\//, async (thread, message) => {
  await thread.subscribe();
  await dispatchCommand(thread, message);
});

// Every subsequent message in a thread we've subscribed to.
// Commands first, then amount replies to a pending outcome pick;
// other chatter is ignored so the bot doesn't spam groups.
bot.onSubscribedMessage(async (thread, message) => {
  if (await dispatchCommand(thread, message)) return;
  await handleBetReply(thread, message);
});
