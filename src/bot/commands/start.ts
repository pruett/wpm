import { formatDollars, gifMessage } from "../../utils/format";
import { balanceCents, findUser, registerUser } from "../../utils/house";
import { canRegister } from "../access";
import { telegramProfile } from "../identity";
import type { BotCommand } from "./types";

// Posted as its own message (see gifMessage) so Telegram renders it animated.
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
    const profile = telegramProfile(message);
    // Existing accounts always get through; only new sign-ups are gated.
    if (!canRegister(profile.telegramId) && (await findUser(profile)) == null) {
      await thread.post(
        "This is a private betting pool — ask the house to add your Telegram id to the guest list.",
      );
      return;
    }

    const { userId, created } = await registerUser(profile);
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

    await thread.post(gifMessage(randomWelcomeGif()));
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
