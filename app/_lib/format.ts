// Pure, dependency-free formatters safe to import into client components.
// (The bot's src/utils/format.ts pulls in `chat` types and Telegram helpers;
// the web surface only needs the money/number/name math, kept standalone here.)

/** `$1,000`, `$99,988.65` — whole amounts drop the cents. */
export function formatDollars(cents: number): string {
  const figure = (Math.round(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${figure}`;
}

/** Signed money for P&L: `+$420`, `-$69`, `$0`. */
export function formatSignedDollars(cents: number): string {
  if (cents === 0) return "$0";
  const sign = cents > 0 ? "+" : "-";
  return `${sign}${formatDollars(Math.abs(cents))}`;
}

/** Abbreviated money for big hero figures: `$1.2M`, `$48.5K`, `$930`. */
export function formatCompactDollars(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `$${(dollars / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}

/** Plain integer with thousands separators. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** `64%` from a 0–1 ratio. */
export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * A registered user's display name. Usernames are mutable, so this is never
 * used as identity — display only. Mirrors the bot's displayName().
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

/** First name (or first token of a handle) — for compact callouts. */
export function firstName(u: {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  if (u.firstName) return u.firstName;
  return displayName(u).replace(/^@/, "").split(" ")[0]!;
}

/** Two-letter monogram for an avatar chip. */
export function initials(u: {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}): string {
  const name = displayName(u).replace(/^@/, "");
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Rough "3 days ago" / "2h ago" relative time, ET-agnostic. */
export function timeAgo(date: Date, now = new Date()): string {
  const sec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  return `${wk}w ago`;
}
