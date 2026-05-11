import "server-only";
import { isAxiosError } from "axios";
import { and, eq, lt } from "drizzle-orm";

import { cancelMarket, resolveMarket } from "@/data/markets";
import { db } from "@/lib/db";
import { markets as marketsTable } from "@/lib/db/schema";

import { KALSHI_SERIES, type KalshiEvent, kalshiEvents, type KalshiSeriesTicker } from "./index";
import { translateKalshiResolution, type ResolutionTranslation } from "./translator";

// "settled" is included alongside the SDK's MarketStatusEnum terminal values
// because the live Kalshi API still emits it on the elections host even though
// the SDK enum omits it.
const TERMINAL_KALSHI_STATUSES = new Set<string>(["settled", "finalized", "determined"]);

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
// Slice 1 scope: happy path only. Every child must be terminal — otherwise we
// `wait`. Deadline degradation (cancelled_no_settlement) and Event-level void
// semantics arrive in Phase 3.
export function decideEventCommit(
  wampumEvent: WampumEventForDecision,
  kalshiResponse: KalshiEvent,
  _now: number,
): EventCommitDecision {
  const nestedKalshi = kalshiResponse.markets ?? [];
  const kalshiByTicker = new Map<string, (typeof nestedKalshi)[number]>();
  for (const m of nestedKalshi) {
    kalshiByTicker.set(m.ticker, m);
  }

  const perChild: ChildOutcome[] = [];
  for (const child of wampumEvent.markets) {
    const kalshiMarket = child.ticker ? kalshiByTicker.get(child.ticker) : undefined;
    if (!kalshiMarket || !TERMINAL_KALSHI_STATUSES.has(kalshiMarket.status)) {
      return { kind: "wait" };
    }

    const result = kalshiMarket.result;
    if (result === "yes") {
      perChild.push({ marketId: child.id, outcome: "resolved_yes" });
    } else if (result === "no") {
      perChild.push({ marketId: child.id, outcome: "resolved_no" });
    } else if (result === "scalar") {
      perChild.push({ marketId: child.id, outcome: "cancelled_scalar" });
    } else {
      // Terminal status but unrecognised result — treat as wait so the
      // resolver driver retries (or surfaces it operationally) rather than
      // committing on a malformed payload. Phase 3 will tighten this into
      // an explicit error path.
      return { kind: "wait" };
    }
  }

  return { kind: "commit", perChild };
}

const SPORT_TO_SERIES: Record<string, KalshiSeriesTicker> = {
  mlb: KALSHI_SERIES.MLB,
  nfl: KALSHI_SERIES.NFL,
  nba: KALSHI_SERIES.NBA,
  nhl: KALSHI_SERIES.NHL,
};

const SETTLEMENT_DEADLINE_MS = 48 * 60 * 60 * 1000;

const MARKET_ID_PREFIX = "kalshi-";

// Basic-tier read budget is 200 tokens/sec (~20 reads/sec at 10 tokens per
// req). 4 in-flight stays comfortably under that across realistic round-trip
// latencies.
const KALSHI_FETCH_CONCURRENCY = 4;

type SkipReason =
  | "not_settled_yet"
  | "ambiguous"
  | "kalshi_event_missing"
  | "already_resolved"
  | "already_cancelled";

export type AmbiguousSkip = { marketId: string; reason: string };

export type SeriesResolveSummary = {
  considered: number;
  resolved: number;
  cancelled: number;
  skipped: Record<SkipReason, number>;
  ambiguous: AmbiguousSkip[];
};

export type KalshiResolveSummary = {
  bySeries: Record<string, SeriesResolveSummary>;
  totals: {
    considered: number;
    resolved: number;
    cancelled: number;
    skipped: Record<SkipReason, number>;
    ambiguous: (AmbiguousSkip & { series: string })[];
  };
};

function emptySkipCounters(): Record<SkipReason, number> {
  return {
    not_settled_yet: 0,
    ambiguous: 0,
    kalshi_event_missing: 0,
    already_resolved: 0,
    already_cancelled: 0,
  };
}

function emptySeriesSummary(): SeriesResolveSummary {
  return {
    considered: 0,
    resolved: 0,
    cancelled: 0,
    skipped: emptySkipCounters(),
    ambiguous: [],
  };
}

function eventTickerFromMarketId(marketId: string): string | null {
  if (!marketId.startsWith(MARKET_ID_PREFIX)) return null;
  return marketId.slice(MARKET_ID_PREFIX.length);
}

type PastCloseMarket = typeof marketsTable.$inferSelect;

export async function runKalshiResolve(now: number = Date.now()): Promise<KalshiResolveSummary> {
  const summary: KalshiResolveSummary = {
    bySeries: {},
    totals: {
      considered: 0,
      resolved: 0,
      cancelled: 0,
      skipped: emptySkipCounters(),
      ambiguous: [],
    },
  };

  const rows = await db
    .select()
    .from(marketsTable)
    .where(and(eq(marketsTable.status, "open"), lt(marketsTable.closesAt, now)));

  const bySport = new Map<string, PastCloseMarket[]>();
  for (const row of rows) {
    const list = bySport.get(row.sport) ?? [];
    list.push(row);
    bySport.set(row.sport, list);
  }

  for (const [sport, seriesMarkets] of bySport) {
    const seriesTicker = SPORT_TO_SERIES[sport];
    if (!seriesTicker) continue;

    const seriesSummary = await resolveSeries(seriesTicker, seriesMarkets, now);
    summary.bySeries[seriesTicker] = seriesSummary;
    summary.totals.considered += seriesSummary.considered;
    summary.totals.resolved += seriesSummary.resolved;
    summary.totals.cancelled += seriesSummary.cancelled;
    for (const key of Object.keys(seriesSummary.skipped) as SkipReason[]) {
      summary.totals.skipped[key] += seriesSummary.skipped[key];
    }
    for (const entry of seriesSummary.ambiguous) {
      summary.totals.ambiguous.push({ ...entry, series: seriesTicker });
    }
  }

  return summary;
}

async function resolveSeries(
  seriesTicker: KalshiSeriesTicker,
  rows: PastCloseMarket[],
  now: number,
): Promise<SeriesResolveSummary> {
  const summary = emptySeriesSummary();
  summary.considered = rows.length;
  if (rows.length === 0) return summary;

  const rowsByTicker = new Map<string, PastCloseMarket>();
  for (const row of rows) {
    const ticker = eventTickerFromMarketId(row.id);
    if (!ticker) continue;
    rowsByTicker.set(ticker, row);
  }

  const eventsByTicker = await fetchEventsByTicker(seriesTicker, [...rowsByTicker.keys()]);

  for (const [ticker, row] of rowsByTicker) {
    const event = eventsByTicker.get(ticker);
    const translation: ResolutionTranslation = event
      ? translateKalshiResolution(event)
      : { kind: "kalshi_event_missing" };

    await dispatch(row, translation, now, summary);
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

async function dispatch(
  row: PastCloseMarket,
  translation: ResolutionTranslation,
  now: number,
  summary: SeriesResolveSummary,
): Promise<void> {
  switch (translation.kind) {
    case "resolved_a": {
      const result = await resolveMarket(row.id, "A");
      countResolve(row.id, result, summary);
      return;
    }
    case "resolved_b": {
      const result = await resolveMarket(row.id, "B");
      countResolve(row.id, result, summary);
      return;
    }
    case "voided": {
      const result = await cancelMarket(row.id, "kalshi_voided");
      countCancel(row.id, result, summary);
      return;
    }
    case "scalar_settled": {
      const result = await cancelMarket(row.id, "kalshi_scalar_settled");
      countCancel(row.id, result, summary);
      return;
    }
    case "not_settled_yet": {
      if (now - row.closesAt > SETTLEMENT_DEADLINE_MS) {
        const result = await cancelMarket(row.id, "kalshi_no_settlement");
        countCancel(row.id, result, summary);
      } else {
        summary.skipped.not_settled_yet++;
      }
      return;
    }
    case "ambiguous": {
      recordAmbiguous(row.id, translation.reason, summary);
      return;
    }
    case "kalshi_event_missing": {
      summary.skipped.kalshi_event_missing++;
      return;
    }
  }
}

function recordAmbiguous(marketId: string, reason: string, summary: SeriesResolveSummary): void {
  summary.skipped.ambiguous++;
  summary.ambiguous.push({ marketId, reason });
}

function countResolve(
  marketId: string,
  result: Awaited<ReturnType<typeof resolveMarket>>,
  summary: SeriesResolveSummary,
): void {
  if (result.resolved) {
    if (result.alreadyResolved) summary.skipped.already_resolved++;
    else summary.resolved++;
  } else {
    recordAmbiguous(marketId, result.reason, summary);
  }
}

function countCancel(
  marketId: string,
  result: Awaited<ReturnType<typeof cancelMarket>>,
  summary: SeriesResolveSummary,
): void {
  if (result.cancelled) {
    if (result.alreadyCancelled) summary.skipped.already_cancelled++;
    else summary.cancelled++;
  } else {
    recordAmbiguous(marketId, result.reason, summary);
  }
}
