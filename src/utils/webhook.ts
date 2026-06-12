/**
 * Manage the Telegram webhook registration, keeping the secret token in
 * sync with what the deployed handler verifies against: both this script
 * and src/api/telegram.ts read TELEGRAM_WEBHOOK_SECRET_TOKEN, so the value
 * Telegram signs with and the value Vercel checks can't drift — as long as
 * the same secret is set in the Vercel project's env.
 *
 *   bun run webhook status     # show current registration (getWebhookInfo)
 *   bun run webhook register   # point Telegram at TELEGRAM_WEBHOOK_URL
 *   bun run webhook delete     # back to local getUpdates polling
 *
 * Registering disconnects local polling (`bun run dev` goes deaf) — it's
 * one or the other per bot token.
 */
export {};

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

async function api(method: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
  return json.result;
}

switch (Bun.argv[2]) {
  case "status": {
    console.log(JSON.stringify(await api("getWebhookInfo"), null, 2));
    break;
  }

  case "register": {
    const url = process.env.TELEGRAM_WEBHOOK_URL;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    if (!url) throw new Error("TELEGRAM_WEBHOOK_URL is not set (e.g. https://wpm-2.vercel.app/api/telegram)");
    if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET_TOKEN is not set");

    await api("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
    });
    console.log(`webhook registered: ${url}`);
    console.log("reminder: TELEGRAM_WEBHOOK_SECRET_TOKEN must hold the same value in the Vercel project env, and local polling is now disconnected");
    break;
  }

  case "delete": {
    await api("deleteWebhook");
    console.log("webhook deleted — local polling will receive updates again");
    break;
  }

  default:
    console.error("usage: webhook <status|register|delete>");
    process.exit(1);
}
