import "server-only";
import { isAxiosError } from "axios";
import { and, eq, inArray, lt } from "drizzle-orm";

import { commitEvent } from "@/data/events";
import { db } from "@/lib/db";
import { events as eventsTable, markets as marketsTable } from "@/lib/db/schema";

import { KALSHI_SERIES, type KalshiEvent, kalshiEvents, type KalshiSeriesTicker } from "./index";

// "settled" is included alongside the SDK's MarketStatusEnum terminal values
// because the live Kalshi API still emits it on the elections host even though
// the SDK enum omits it.
const TERMINAL_KALSHI_STATUSES = new Set<string>(["settled", "finalized", "determined"]);

// PRD §Further Notes — baked-in constant for v1.
const SETTLEMENT_DEADLINE_MS = 48 * 60 * 60 * 1000;

export type ChildOutcome = {
  marketId: string;
  outcome:
    | "resolved_yes"
    | "resolved_no"
    | "cancelled_voided"
    | "cancelled_scalar"
    | "cancelled_no_settlement";
};

export type EventCommitDecision = { kind: "wait" } | { kind: "commit"; perChild: ChildOutcome[] };

export type WampumEventForDecision = {
  id: string;
  closesAt: number;
  markets: { id: string; ticker: string | null }[];
};

// Pure decision core for Event-level commit. Maps every wampum child Market to
// an outcome by matching against the Kalshi response's nested markets by
// ticker. Replaces the per-child `translateKalshiResolution` dispatch under
// the multi-outcome model (PRD §Resolver).
//
// Scope: happy path, Event-level void semantics, and deadline degradation
// (cancelled_no_settlement past the 48h deadline).
export function decideEventCommit(
  wampumEvent: WampumEventForDecision,
  kalshiResponse: KalshiEvent,
  now: number,
): EventCommitDecision {
  const nestedKalshi = kalshiResponse.markets ?? [];
  const kalshiByTicker = new Map<string, (typeof nestedKalshi)[number]>();
  for (const m of nestedKalshi) {
    kalshiByTicker.set(m.ticker, m);
  }

  const deadlineReached = now >= wampumEvent.closesAt + SETTLEMENT_DEADLINE_MS;

  const perChild: ChildOutcome[] = [];
  for (const child of wampumEvent.markets) {
    const kalshiMarket = child.ticker ? kalshiByTicker.get(child.ticker) : undefined;
    const isTerminal = !!kalshiMarket && TERMINAL_KALSHI_STATUSES.has(kalshiMarket.status);

    if (!isTerminal) {
      // Deadline degradation (PRD §Resolver): past the 48h deadline, any
      // non-terminal child is cancelled-no-settlement so holders get a
      // cost-basis refund rather than locked positions. Cleanly-settled
      // siblings still resolve on their actual `result`.
      if (deadlineReached) {
        perChild.push({ marketId: child.id, outcome: "cancelled_no_settlement" });
        continue;
      }
      return { kind: "wait" };
    }

    const result = kalshiMarket.result;
    if (result === "yes") {
      perChild.push({ marketId: child.id, outcome: "resolved_yes" });
    } else if (result === "no") {
      perChild.push({ marketId: child.id, outcome: "resolved_no" });
    } else if (result === "scalar") {
      perChild.push({ marketId: child.id, outcome: "cancelled_scalar" });
    } else if (deadlineReached) {
      // Terminal status but unrecognised result past the deadline — degrade
      // to cancelled_no_settlement so the Event commits rather than stalling
      // indefinitely on a malformed payload.
      perChild.push({ marketId: child.id, outcome: "cancelled_no_settlement" });
    } else {
      // Terminal status but unrecognised result — wait so the resolver driver
      // retries (or surfaces it operationally) rather than committing on a
      // malformed payload before the deadline.
      return { kind: "wait" };
    }
  }

  // Void semantics (PRD §Resolver): if every child settled `no`, no candidate
  // won. Rewrite every outcome to `cancelled_voided` so each holder is refunded
  // their cost basis rather than booking a loss.
  if (perChild.length > 0 && perChild.every((c) => c.outcome === "resolved_no")) {
    return {
      kind: "commit",
      perChild: perChild.map((c) => ({ marketId: c.marketId, outcome: "cancelled_voided" })),
    };
  }

  return { kind: "commit", perChild };
}

const SPORT_TO_SERIES: Record<string, KalshiSeriesTicker> = {
  mlb: KALSHI_SERIES.MLB,
  nfl: KALSHI_SERIES.NFL,
  nba: KALSHI_SERIES.NBA,
  nhl: KALSHI_SERIES.NHL,
};

const EVENT_ID_PREFIX = "kalshi-";

// Basic-tier read budget is 200 tokens/sec (~20 reads/sec at 10 tokens per
// req). 4 in-flight stays comfortably under that across realistic round-trip
// latencies.
const KALSHI_FETCH_CONCURRENCY = 4;

type ChildOutcomeKind = ChildOutcome["outcome"];

type SkipReason = "waited" | "kalshi_event_missing" | "commit_failed" | "no_event_ticker";

export type CommitFailure = { eventId: string; reason: string };
export type ChildError = { marketId: string; reason: string };

export type SeriesResolveSummary = {
  considered: number;
  committed: number;
  committedEventIds: string[];
  perChildOutcomes: Record<ChildOutcomeKind, number>;
  skipped: Record<SkipReason, number>;
  commitFailures: CommitFailure[];
  childErrors: ChildError[];
};

export type KalshiResolveSummary = {
  bySeries: Record<string, SeriesResolveSummary>;
  totals: {
    considered: number;
    committed: number;
    committedEventIds: string[];
    perChildOutcomes: Record<ChildOutcomeKind, number>;
    skipped: Record<SkipReason, number>;
    commitFailures: (CommitFailure & { series: string })[];
    childErrors: (ChildError & { series: string })[];
    // Aggregate convenience counters kept for the cron route (which gates a
    // cache revalidation on these). `resolved` = `resolved_yes` + `resolved_no`
    // child outcomes; `cancelled` = sum of `cancelled_*` child outcomes.
    resolved: number;
    cancelled: number;
  };
};

function emptySkipCounters(): Record<SkipReason, number> {
  return {
    waited: 0,
    kalshi_event_missing: 0,
    commit_failed: 0,
    no_event_ticker: 0,
  };
}

function emptyChildOutcomeCounters(): Record<ChildOutcomeKind, number> {
  return {
    resolved_yes: 0,
    resolved_no: 0,
    cancelled_voided: 0,
    cancelled_scalar: 0,
    cancelled_no_settlement: 0,
  };
}

function emptySeriesSummary(): SeriesResolveSummary {
  return {
    considered: 0,
    committed: 0,
    committedEventIds: [],
    perChildOutcomes: emptyChildOutcomeCounters(),
    skipped: emptySkipCounters(),
    commitFailures: [],
    childErrors: [],
  };
}

function eventTickerFromEventId(eventId: string): string | null {
  if (!eventId.startsWith(EVENT_ID_PREFIX)) return null;
  return eventId.slice(EVENT_ID_PREFIX.length);
}

type EventRow = typeof eventsTable.$inferSelect;
type ChildMarketRow = Pick<typeof marketsTable.$inferSelect, "id" | "eventId" | "ticker">;
type PastCloseEvent = EventRow & { markets: ChildMarketRow[] };

export async function runKalshiResolve(now: number = Date.now()): Promise<KalshiResolveSummary> {
  const summary: KalshiResolveSummary = {
    bySeries: {},
    totals: {
      considered: 0,
      committed: 0,
      committedEventIds: [],
      perChildOutcomes: emptyChildOutcomeCounters(),
      skipped: emptySkipCounters(),
      commitFailures: [],
      childErrors: [],
      resolved: 0,
      cancelled: 0,
    },
  };

  const eventRows = await db
    .select()
    .from(eventsTable)
    .where(and(eq(eventsTable.status, "open"), lt(eventsTable.closesAt, now)));

  if (eventRows.length === 0) return summary;

  const eventIds = eventRows.map((e) => e.id);
  const childRows = await db
    .select({
      id: marketsTable.id,
      eventId: marketsTable.eventId,
      ticker: marketsTable.ticker,
    })
    .from(marketsTable)
    .where(inArray(marketsTable.eventId, eventIds));

  const childrenByEventId = new Map<string, ChildMarketRow[]>();
  for (const child of childRows) {
    if (!child.eventId) continue;
    const list = childrenByEventId.get(child.eventId) ?? [];
    list.push(child);
    childrenByEventId.set(child.eventId, list);
  }

  const eventsBySport = new Map<string, PastCloseEvent[]>();
  for (const event of eventRows) {
    const list = eventsBySport.get(event.sport) ?? [];
    list.push({ ...event, markets: childrenByEventId.get(event.id) ?? [] });
    eventsBySport.set(event.sport, list);
  }

  for (const [sport, seriesEvents] of eventsBySport) {
    const seriesTicker = SPORT_TO_SERIES[sport];
    if (!seriesTicker) continue;

    const seriesSummary = await resolveSeries(seriesTicker, seriesEvents, now);
    summary.bySeries[seriesTicker] = seriesSummary;
    summary.totals.considered += seriesSummary.considered;
    summary.totals.committed += seriesSummary.committed;
    summary.totals.committedEventIds.push(...seriesSummary.committedEventIds);
    for (const key of Object.keys(seriesSummary.perChildOutcomes) as ChildOutcomeKind[]) {
      summary.totals.perChildOutcomes[key] += seriesSummary.perChildOutcomes[key];
    }
    for (const key of Object.keys(seriesSummary.skipped) as SkipReason[]) {
      summary.totals.skipped[key] += seriesSummary.skipped[key];
    }
    for (const entry of seriesSummary.commitFailures) {
      summary.totals.commitFailures.push({ ...entry, series: seriesTicker });
    }
    for (const entry of seriesSummary.childErrors) {
      summary.totals.childErrors.push({ ...entry, series: seriesTicker });
    }
  }

  const c = summary.totals.perChildOutcomes;
  summary.totals.resolved = c.resolved_yes + c.resolved_no;
  summary.totals.cancelled = c.cancelled_voided + c.cancelled_scalar + c.cancelled_no_settlement;

  return summary;
}

async function resolveSeries(
  seriesTicker: KalshiSeriesTicker,
  events: PastCloseEvent[],
  now: number,
): Promise<SeriesResolveSummary> {
  const summary = emptySeriesSummary();
  summary.considered = events.length;
  if (events.length === 0) return summary;

  const eventsByTicker = new Map<string, PastCloseEvent>();
  for (const event of events) {
    const ticker = eventTickerFromEventId(event.id);
    if (!ticker) {
      summary.skipped.no_event_ticker++;
      continue;
    }
    eventsByTicker.set(ticker, event);
  }

  const kalshiByTicker = await fetchEventsByTicker(seriesTicker, [...eventsByTicker.keys()]);

  for (const [ticker, wampumEvent] of eventsByTicker) {
    const kalshiEvent = kalshiByTicker.get(ticker);
    if (!kalshiEvent) {
      summary.skipped.kalshi_event_missing++;
      continue;
    }

    const decision = decideEventCommit(
      {
        id: wampumEvent.id,
        closesAt: wampumEvent.closesAt,
        markets: wampumEvent.markets.map((m) => ({ id: m.id, ticker: m.ticker })),
      },
      kalshiEvent,
      now,
    );

    if (decision.kind === "wait") {
      summary.skipped.waited++;
      continue;
    }

    const result = await commitEvent({ eventId: wampumEvent.id, perChild: decision.perChild });
    if (!result.committed) {
      summary.skipped.commit_failed++;
      summary.commitFailures.push({ eventId: wampumEvent.id, reason: result.reason });
      continue;
    }

    summary.committed++;
    summary.committedEventIds.push(wampumEvent.id);
    for (const child of result.perChild) {
      summary.perChildOutcomes[child.outcome]++;
      if (child.status.kind === "error") {
        summary.childErrors.push({ marketId: child.marketId, reason: child.status.reason });
      }
    }
  }

  return summary;
}

async function fetchEventsByTicker(
  seriesTicker: KalshiSeriesTicker,
  tickers: string[],
): Promise<Map<string, KalshiEvent>> {
  const map = new Map<string, KalshiEvent>();
  if (tickers.length === 0) return map;

  // The SDK does not expose the bulk `event_tickers` filter on getEvents, so
  // we fan out to per-ticker getEvent calls. A 404 means the event is no
  // longer available on Kalshi — treated as kalshi_event_missing downstream.
  const client = kalshiEvents();
  const fetchOne = async (ticker: string) => {
    try {
      const { data } = await client.getEvent(ticker, true);
      return [ticker, data.event] as const;
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 404) {
        return [ticker, null] as const;
      }
      throw new Error(
        `Kalshi ${seriesTicker} resolve request failed for ${ticker}: ${
          isAxiosError(err) ? (err.response?.status ?? err.message) : String(err)
        }`,
      );
    }
  };

  for (let i = 0; i < tickers.length; i += KALSHI_FETCH_CONCURRENCY) {
    const batch = tickers.slice(i, i + KALSHI_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(fetchOne));
    for (const [ticker, event] of batchResults) {
      if (event) map.set(ticker, event);
    }
  }
  return map;
}
