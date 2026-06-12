import type { ActionEvent, Message } from "chat";
import type { TelegramCallbackQuery, TelegramMessage } from "@chat-adapter/telegram";
import type { TelegramProfile } from "../utils/house";

/**
 * Extract the author's Telegram identity from a message. The raw Telegram
 * payload's `from` field carries profile data (username, names, language)
 * beyond the normalized Author. Missing raw fields map to null, not
 * undefined: a message reflects the user's current profile, so an absent
 * username means the user has none and any stored value should be cleared.
 */
export function telegramProfile(message: Message): TelegramProfile {
  const from = (message.raw as TelegramMessage | undefined)?.from;
  return {
    telegramId: message.author.userId,
    username: from?.username ?? null,
    firstName: from?.first_name ?? null,
    lastName: from?.last_name ?? null,
    languageCode: from?.language_code ?? null,
  };
}

/**
 * Same, for button taps: an action event's raw payload is the Telegram
 * callback query, whose `from` is the user who tapped.
 */
export function telegramProfileFromAction(event: ActionEvent): TelegramProfile {
  const from = (event.raw as TelegramCallbackQuery | undefined)?.from;
  return {
    telegramId: event.user.userId,
    username: from?.username ?? null,
    firstName: from?.first_name ?? null,
    lastName: from?.last_name ?? null,
    languageCode: from?.language_code ?? null,
  };
}
