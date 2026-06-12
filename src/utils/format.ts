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

/** Format a cent amount as dollars: `$1,000`, `$99,988.65` (whole amounts drop the cents). */
export function formatDollars(cents: number): string {
  const figure = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$${figure}`;
}
