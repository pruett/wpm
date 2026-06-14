import type { PostableMarkdown } from "chat";

/**
 * Wrap a GIF URL as a Telegram-friendly message: a typed `file` attachment
 * rather than the bare URL. Posting the URL as text leaves rendering to
 * Telegram's link-preview unfurler, which usually shows a static page-preview
 * card; a `file` attachment goes through sendDocument, which Telegram inlines
 * as an animated GIF. (The adapter has no sendAnimation, and `image`/sendPhoto
 * would render a single static frame.)
 */
export function gifMessage(url: string): PostableMarkdown {
  return {
    markdown: "",
    attachments: [{ url, type: "file", name: "giphy.gif", mimeType: "image/gif" }],
  };
}

/**
 * Render a UTC instant in US Eastern (`Jun 12, 9:00 PM`) so a 9pm ET time
 * doesn't show as the next day on UTC servers like Vercel.
 */
export function formatEastern(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A registered user's name for display. Usernames are mutable, so this is
 * never used as identity.
 */
export function displayName(u: {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
  if (full) return full;
  if (u.username) return `@${u.username}`;
  return "Anonymous";
}

/**
 * A Telegram inline mention rendered as markdown: the user's display name
 * linked via `tg://user?id=`, which pings them and works even when they have
 * no public username. Only renders as a mention inside a `{ markdown }` post.
 */
export function mention(u: {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  return `[${displayName(u)}](tg://user?id=${u.telegramId})`;
}

/** Format a cent amount as dollars: `$1,000`, `$99,988.65` (whole amounts drop the cents). */
export function formatDollars(cents: number): string {
  const figure = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${figure}`;
}
