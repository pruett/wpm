// v2 (Next.js Route Handler) mirror of the production Telegram webhook at
// /api/telegram. Delegates to the same handler as `api/telegram.mjs`
// (src/api/telegram.ts → bot.webhooks.telegram). We wrap rather than re-export
// because the chat SDK's WebhookHandler signature (request, options?) isn't
// directly assignable to Next's POST type; calling it with just the request
// matches how Vercel invokes the .mjs today. The live webhook is still
// registered against /api/telegram — only re-point setWebhook here once v2 is
// confirmed working.
import { POST as telegramWebhook } from "@/src/api/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function POST(request: Request) {
  return telegramWebhook(request);
}
