// v2 (Next.js Route Handler) mirror of the production Telegram webhook at
// /api/telegram. Delegates to the same handler as `api/telegram.mjs`
// (src/api/telegram.ts → bot.webhooks.telegram).
//
// The chat SDK returns 200 to Telegram immediately and runs message handling
// (including sending the reply) as a BACKGROUND task — it only keeps that task
// alive if you pass a `waitUntil`. On the App Router, once this route's Response
// resolves the instance freezes and an un-registered background task is dropped,
// which surfaces as a silent 200 with no reply. `after` from next/server is the
// SDK's documented App Router hook for this. (v1's raw-function lifecycle
// happened to let the fire-and-forget finish, which masked the issue.)
import { after } from "next/server";
import { POST as telegramWebhook } from "@/src/api/telegram";

// Route handlers are dynamic by default under cacheComponents, so the former
// `runtime`/`dynamic` exports are dropped; the webhook duration ceiling stays.
export const maxDuration = 60;

export function POST(request: Request) {
  return telegramWebhook(request, { waitUntil: (p) => after(() => p) });
}
