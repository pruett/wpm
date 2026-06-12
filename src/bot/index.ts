import { Chat } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createPostgresState } from "@chat-adapter/state-pg";
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
} from "./commands/bet";
import {
  BETS_BACK_ACTION,
  BETS_PICK_EVENT_ACTION,
  handleBetsBack,
  handleBetsPickEvent,
} from "./commands/bets";

// The adapter reads TELEGRAM_BOT_TOKEN (and, for webhook verification,
// TELEGRAM_WEBHOOK_SECRET_TOKEN) from the environment. Auto mode picks
// webhook on serverless runtimes (Vercel) and getUpdates polling locally,
// so `bun run dev` needs no public URL or webhook registration.
export const telegram = createTelegramAdapter({
  mode: "auto",
});

export const bot = new Chat({
  userName: process.env.TELEGRAM_BOT_USERNAME ?? "bot",
  adapters: { telegram },
  // Postgres-backed state (reads DATABASE_URL, creates its own tables):
  // subscriptions, /bet menu flow state, and webhook locks/dedupe must
  // survive across serverless invocations.
  state: createPostgresState(),
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

// Each user gets their own /bet menu — one message per user that edits
// itself as its owner navigates: event list → outcomes → amount picker →
// back to event list. Only the owner's taps move their menu.
bot.onAction(PICK_EVENT_ACTION, handlePickEvent);
bot.onAction(PICK_OUTCOME_ACTION, handlePickOutcome);
bot.onAction(PICK_AMOUNT_ACTION, handlePickAmount);
bot.onAction(BACK_TO_EVENTS_ACTION, handleBackToEvents);

// /bets is a shared read-only card: event list with open-bet counts that
// drills into per-event bet lists. Anyone may navigate it.
bot.onAction(BETS_PICK_EVENT_ACTION, handleBetsPickEvent);
bot.onAction(BETS_BACK_ACTION, handleBetsBack);

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
