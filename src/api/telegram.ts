import { bot } from "../bot";

/**
 * Telegram webhook target. Register it once with setWebhook, passing the
 * same secret_token as TELEGRAM_WEBHOOK_SECRET_TOKEN — the adapter rejects
 * updates whose x-telegram-bot-api-secret-token header doesn't match.
 */
export const POST = bot.webhooks.telegram;
