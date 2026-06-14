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

/** Compact Eastern timestamp, e.g. "06/13/26:8:30 PM". */
export function formatEasternShort(date: Date): string {
  const formatted = date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
  // en-US renders "06/13/26, 8:30 PM" — join date and time with a colon.
  return formatted.replace(", ", " ");
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

type Mentionable = {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

/**
 * Turn bare display names in free text (e.g. an LLM-written recap) into
 * `tg://user?id=` mentions so the named people get pinged. Names are matched in
 * one pass via a single alternation, longest first so "Kevin Pruett" wins over
 * "Kevin"; String.replace never re-scans the links it inserts, so a name inside
 * a freshly inserted mention can't be matched again. The boundaries are
 * `\w` lookarounds rather than `\b` so `@username` display names (which start
 * with a non-word char) still anchor correctly.
 */
export function linkMentions(text: string, people: Mentionable[]): string {
  const named = people.filter((p) => displayName(p) !== "Anonymous");
  if (named.length === 0) return text;

  const ordered = [...named].sort((a, b) => displayName(b).length - displayName(a).length);
  const byName = new Map(ordered.map((p) => [displayName(p), p] as const));
  const alternation = ordered
    .map((p) => displayName(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(`(?<!\\w)(?:${alternation})(?!\\w)`, "g");

  return text.replace(pattern, (match) => {
    const person = byName.get(match);
    return person ? mention(person) : match;
  });
}

/**
 * Render a Kalshi ask price (cents, 1–100) as decimal odds — the total return
 * per $1 staked, the way most sportsbooks quote it (`94¢ → 1.06x`). A share
 * costs the price and pays $1 on a win, so the multiple is 100 / price.
 * Returns `—` when there's no live price.
 */
export function formatDecimalOdds(priceCents: number | null): string {
  if (priceCents == null || priceCents <= 0) return "—";
  return `${(100 / priceCents).toFixed(2)}x`;
}

/**
 * Show what a bet returns at a given ask price — stake included — either as
 * `$100 → $106` (style `"arrow"`, the default) or `$100 (pays $106)` (style
 * `"pays"`). A share costs the price and pays $1, so a stake buys stake/price
 * shares and returns stake × (100 / price), rounded to whole dollars for a
 * clean label. Defaults to a $100 stake. Returns `null` when there's no live
 * price.
 */
export function formatStakeReturn(
  priceCents: number | null,
  stakeDollars = 100,
  style: "arrow" | "pays" = "arrow",
): string | null {
  if (priceCents == null || priceCents <= 0) return null;
  const back = Math.round((stakeDollars * 100) / priceCents);
  const stake = formatDollars(stakeDollars * 100);
  const payout = formatDollars(back * 100);
  return style === "pays" ? `${stake} (pays ${payout})` : `${stake} → ${payout}`;
}

/** Format a cent amount as dollars: `$1,000`, `$99,988.65` (whole amounts drop the cents). */
export function formatDollars(cents: number): string {
  const figure = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${figure}`;
}
