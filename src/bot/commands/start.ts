import { balanceCents, registerUser } from "../../utils/house";
import { telegramProfile } from "../identity";
import { formatCents } from "./mocks";
import type { BotCommand } from "./types";

// Posted as its own message so Telegram's link preview renders it animated —
// the Chat SDK has no native sendAnimation, but a bare GIF URL previews big.
const WELCOME_GIF = "https://media.giphy.com/media/g9582DNuQppxC/giphy.gif";

// Telegram sends /start automatically when a user first opens the bot, so
// this doubles as registration: first contact creates the account and seeds
// the bankroll; a later /start is a plain re-orientation.
export const start: BotCommand = {
  name: "start",
  description: "Open your account and get oriented",
  usage: "/start",
  handler: async ({ thread, message }) => {
    const { userId, created } = await registerUser(telegramProfile(message));
    const balance = formatCents(await balanceCents(userId));

    if (!created) {
      await thread.post(
        [
          `Welcome back, ${message.author.fullName}! Your balance is ${balance}.`,
          "Place a bet with /bet and track your positions with /bets.",
          "Type /help to see everything I can do.",
        ].join("\n"),
      );
      return;
    }

    await thread.post(WELCOME_GIF);
    await thread.post(
      [
        `🎉 Welcome aboard, ${message.author.fullName}!`,
        "",
        `Your account is live with a ${balance} bankroll — this is the house book for World Cup 2026.`,
        "Type /bet to place your first bet, and check /balance any time.",
      ].join("\n"),
    );
  },
};
