/**
 * Every Kalshi series the app tracks — the single list to edit when adding
 * a new one. The cron sync mirrors each series listed here, and the /bet
 * and /bets menus group events under each series' title, in this order.
 *
 * Find new tickers with listSeries() in ./ingest.ts (e.g.
 * `listSeries({ category: "Sports" })`).
 */
export interface TrackedSeries {
  ticker: string;
  /** Section header shown above this series' events in menus. */
  title: string;
}

export const TRACKED_SERIES: TrackedSeries[] = [
  { ticker: "KXWCGAME", title: "⚽️ World Cup 2026 Games" },
  { ticker: "KXNBAGAME", title: "🏀 NBA Finals 2026" },
];

// Unknown series fall back to the raw ticker minus Kalshi's "KX" prefix,
// title-cased — "KXNBASERIES" → "Nbaseries" beats showing nothing.
export function seriesTitle(seriesTicker: string): string {
  const known = TRACKED_SERIES.find((s) => s.ticker === seriesTicker)?.title;
  if (known) return known;
  const stripped = seriesTicker.replace(/^KX/, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
}

/** Registry position, for ordering menu sections. Unknown series sort last. */
export function seriesRank(seriesTicker: string): number {
  const index = TRACKED_SERIES.findIndex((s) => s.ticker === seriesTicker);
  return index === -1 ? TRACKED_SERIES.length : index;
}
