import type { EventData, Milestone, Series } from "kalshi-typescript";
import { eventsApi, marketApi } from "./client";

const PAGE_LIMIT = 200; // API maximum

export type EventStatus = "unopened" | "open" | "closed" | "settled";

export interface IngestOptions {
  /** Filter by event status. Omit to fetch events in any state. */
  status?: EventStatus;
  /** Include each event's markets (nested under event.markets). Defaults to true. */
  withNestedMarkets?: boolean;
}

export interface SeriesIngest {
  events: EventData[];
  /**
   * Event-level live metadata. Milestones carry the scheduled start time
   * (start_date) and live game state (details.status) — market close_time
   * is only a backstop and can be weeks after the game.
   */
  milestones: Milestone[];
}

/**
 * Fetch every event (and its milestones) for a series — e.g. "KXWCGAME"
 * for World Cup 2026 games — following pagination cursors until the API runs dry.
 */
export async function ingestEvents(
  seriesTicker: string,
  { status, withNestedMarkets = true }: IngestOptions = {},
): Promise<SeriesIngest> {
  const events: EventData[] = [];
  const milestones: Milestone[] = [];
  let cursor: string | undefined;

  do {
    const { data } = await eventsApi.getEvents(
      PAGE_LIMIT,
      cursor,
      withNestedMarkets,
      true, // withMilestones
      status,
      seriesTicker,
    );
    events.push(...data.events);
    milestones.push(...(data.milestones ?? []));
    cursor = data.cursor || undefined;
  } while (cursor);

  return { events, milestones };
}

/**
 * Discover series tickers — useful for finding identifiers like KXWCGAME.
 * Filter by category (e.g. "Sports") and/or tags to narrow the list.
 */
export async function listSeries(filters: {
  category?: string;
  tags?: string;
} = {}): Promise<Series[]> {
  const { data } = await marketApi.getSeriesList(filters.category, filters.tags);
  return data.series ?? [];
}
