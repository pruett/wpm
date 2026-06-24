/**
 * Every Kalshi series the app tracks — the single list to edit when adding
 * a new one. The cron sync mirrors each series listed here, and the /placebet
 * and /showbets menus group events under each series' title, in this order.
 *
 * Find new tickers with listSeries() in ./ingest.ts (e.g.
 * `listSeries({ category: "Sports" })`).
 */
export interface TrackedSeries {
  ticker: string;
  /** The series' emoji, rendered beside its title everywhere (menus, alerts). */
  emoji: string;
  /** Section header (without emoji) shown above this series' events in menus. */
  title: string;
  /**
   * For pooled per-match series (e.g. KXATPMATCH carries every ATP tournament
   * at once), keep only events whose milestone `details.tournament_name`
   * matches this — the sync drops the rest. Omit to track the whole series.
   */
  tournamentName?: string;
}

export const TRACKED_SERIES: TrackedSeries[] = [
  { ticker: "KXWCGAME", emoji: "⚽️", title: "World Cup 2026 Games" },
  { ticker: "KXNBAGAME", emoji: "🏀", title: "NBA Finals 2026" },
  // Wimbledon men's singles trades per match under the shared ATP-match series,
  // not the tournament-winner series (KXWMENSINGLES) — only per-match events
  // carry a kickoff (milestone.start_date) and live status, which our betting
  // cutoff needs. Filter the ATP-wide feed down to just Wimbledon.
  {
    ticker: "KXATPMATCH",
    emoji: "🎾",
    title: "Wimbledon 2026 Men's Singles",
    tournamentName: "Wimbledon Men Singles",
  },
];

// Every series gets an emoji — tracked ones their own, anything else this.
const DEFAULT_SERIES_EMOJI = "🎯";

/** A series' emoji, keyed off its ticker. Unknown tickers get the default. */
export function seriesEmoji(seriesTicker: string): string {
  return TRACKED_SERIES.find((s) => s.ticker === seriesTicker)?.emoji ?? DEFAULT_SERIES_EMOJI;
}

// Unknown series fall back to the raw ticker minus Kalshi's "KX" prefix,
// title-cased — "KXNBASERIES" → "Nbaseries" beats showing nothing.
export function seriesTitle(seriesTicker: string): string {
  const known = TRACKED_SERIES.find((s) => s.ticker === seriesTicker);
  if (known) return `${known.emoji} ${known.title}`;
  const stripped = seriesTicker.replace(/^KX/, "");
  const name = stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
  return `${DEFAULT_SERIES_EMOJI} ${name}`;
}

/** Registry position, for ordering menu sections. Unknown series sort last. */
export function seriesRank(seriesTicker: string): number {
  const index = TRACKED_SERIES.findIndex((s) => s.ticker === seriesTicker);
  return index === -1 ? TRACKED_SERIES.length : index;
}
