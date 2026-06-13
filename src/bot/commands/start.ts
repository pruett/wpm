import { formatDollars } from "../../utils/format";
import { balanceCents, registerUser } from "../../utils/house";
import { telegramProfile } from "../identity";
import type { BotCommand } from "./types";

// Posted as its own message so Telegram's link preview renders it animated —
// the Chat SDK has no native sendAnimation, but a bare GIF URL previews big.
// One is picked at random per welcome.
const WELCOME_GIFS = [
  "https://media.giphy.com/media/g9582DNuQppxC/giphy.gif", // Gatsby Leo raising a glass
  "https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif", // Forrest Gump waving
  "https://media.giphy.com/media/ASd0Ukj0y3qMM/giphy.gif", // Ralph Wiggum waving hello
  "https://media.giphy.com/media/111ebonMs90YLu/giphy.gif", // 90s kid thumbs-up at computer
];

function randomWelcomeGif(): string {
  return WELCOME_GIFS[Math.floor(Math.random() * WELCOME_GIFS.length)]!;
}

// Telegram sends /start automatically when a user first opens the bot, so
// this doubles as registration: first contact creates the account and seeds
// the bankroll; a later /start is a plain re-orientation.
export const start: BotCommand = {
  name: "start",
  description: "Collect your bankroll and start betting",
  usage: "/start",
  handler: async ({ thread, message }) => {
    const { userId, created } = await registerUser(telegramProfile(message));
    const balance = formatDollars(await balanceCents(userId));

    if (!created) {
      await thread.post(
        [
          `Welcome back, ${message.author.fullName}! Your balance is ${balance}.`,
          "Place a bet with /placebet and check your account with /mybets.",
          "Type /help to see everything I can do.",
        ].join("\n"),
      );
      return;
    }

    await thread.post(randomWelcomeGif());
    await thread.post(
      [
        `🎉 Welcome aboard, ${message.author.fullName}!`,
        "",
        `Your account is live with a ${balance} bankroll — now go make some money 💰, playa!`,
        "",
        "Type /placebet to place your first bet, and check /mybets any time.",
      ].join("\n"),
    );
  },
};
