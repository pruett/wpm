import { formatDollars } from "../../utils/format";
import { giftAllUsers, giftUser } from "../../utils/house";
import { announceGift } from "../../utils/announce";
import type { BotCommand } from "./types";

// Telegram user ids allowed to run /gift, from TELEGRAM_ADMIN_IDS
// (comma-separated). Ids, not usernames: usernames are mutable and
// anyone can rename themselves into one.
function adminIds(): Set<string> {
  return new Set(
    (process.env.TELEGRAM_ADMIN_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * Parse a dollar amount like "5000", "$5,000", or "49.99" into cents.
 * Returns null for anything non-positive or unparseable.
 */
function parseDollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  return cents > 0 ? cents : null;
}

// Admin-only and deliberately hidden: registered for dispatch but kept out of
// /help and the Telegram command menu (see adminCommands in commands/index.ts).
export const gift: BotCommand = {
  name: "gift",
  description: "Gift house money to every bettor, or one (admin only)",
  usage: "/gift <amount> [@username]",
  handler: async ({ thread, message, args }) => {
    if (!adminIds().has(message.author.userId)) {
      await thread.post("Nice try — only the house hands out money. 💸");
      return;
    }

    const [rawAmount, handle] = args;
    const amountCents = rawAmount ? parseDollarsToCents(rawAmount) : null;
    if (amountCents == null) {
      await thread.post(
        "Usage: /gift <amount> [@username] — e.g. `/gift 5000` for everyone, `/gift 5000 @kevin` for one person.",
      );
      return;
    }

    if (handle) {
      const gifted = await giftUser(handle, amountCents);
      if (!gifted) {
        await thread.post(`No registered user matches ${handle}.`);
        return;
      }
      const announced = await announceGift([gifted], amountCents);
      await confirm(
        thread,
        announced,
        `Gifted ${formatDollars(amountCents)} to ${handle} (balance now ${formatDollars(gifted.balanceCents)}).`,
      );
      return;
    }

    const gifted = await giftAllUsers(amountCents);
    if (gifted.length === 0) {
      await thread.post("No registered users yet — nobody to gift.");
      return;
    }
    const announced = await announceGift(gifted, amountCents);
    await confirm(
      thread,
      announced,
      `Gifted ${formatDollars(amountCents)} to ${gifted.length} user${gifted.length === 1 ? "" : "s"}.`,
    );
  },
};

/**
 * Post the admin confirmation, unless the invoking thread just received the
 * public announcement itself — a group sees the MONEY DROP, not the receipts.
 * Announcements go to bare chat threads while a forum command can arrive on a
 * topic thread ("telegram:<chatId>:<topicId>"), so compare by chat prefix.
 */
async function confirm(
  thread: { id: string; post: (text: string) => Promise<unknown> },
  announcedThreadIds: string[],
  summary: string,
): Promise<void> {
  const chatThread = thread.id.split(":").slice(0, 2).join(":");
  if (announcedThreadIds.includes(chatThread)) return;
  const where =
    announcedThreadIds.length > 0
      ? ` Announced in ${announcedThreadIds.length} group${announcedThreadIds.length === 1 ? "" : "s"}.`
      : " No subscribed groups to announce in.";
  await thread.post(summary + where);
}
