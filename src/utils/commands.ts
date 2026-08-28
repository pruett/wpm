/**
 * Push the slash-command menu to Telegram (setMyCommands), derived from
 * src/bot/commands so the menu can never drift from what the bot handles.
 * Targets whichever bot TELEGRAM_BOT_TOKEN points at:
 *
 *   bun run updateTelegramCommands         # local bot (.env)
 *   bun run updateTelegramCommands:prod    # prod bot (pulled Vercel env)
 *
 * Telegram clients cache the menu aggressively — if the new list doesn't
 * show up, close and reopen the chat (or restart the app).
 */
import { menuCommands } from "../bot/commands";

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

const me = (await api("getMe")) as { username: string };
// menuCommands, not allCommands: admin-only commands stay out of the menu.
const menu = menuCommands.map((c) => ({ command: c.name, description: c.description }));
await api("setMyCommands", { commands: menu });
console.log(`updated @${me.username} with ${menu.length} commands: ${menu.map((c) => `/${c.command}`).join(" ")}`);
