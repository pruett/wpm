// v2 (Next.js Route Handler) for the production Telegram webhook at
// /api/v2/telegram. Full handler lives here (migrated from src/api/telegram.ts);
// it delegates straight to the chat SDK's Telegram adapter
// (bot.webhooks.telegram), the same handler the legacy bundled
// `api/telegram.mjs` (v1) uses. Register it once with setWebhook, passing the
// same secret_token as TELEGRAM_WEBHOOK_SECRET_TOKEN — the adapter rejects
// updates whose x-telegram-bot-api-secret-token header doesn't match.
//
// The chat SDK returns 200 to Telegram immediately and runs message handling
// (including sending the reply) as a BACKGROUND task — it only keeps that task
// alive if you pass a `waitUntil`. On the App Router, once this route's Response
// resolves the instance freezes and an un-registered background task is dropped,
// which surfaces as a silent 200 with no reply. `after` from next/server is the
// SDK's documented App Router hook for this. (v1's raw-function lifecycle
// happened to let the fire-and-forget finish, which masked the issue.)
import { after } from "next/server";
import { bot } from "@/src/bot";

// Route handlers are dynamic by default under cacheComponents, so the former
// `runtime`/`dynamic` exports are dropped; the webhook duration ceiling stays.
export const maxDuration = 60;

export function POST(request: Request) {
  return bot.webhooks.telegram(request, { waitUntil: (p) => after(() => p) });
}
