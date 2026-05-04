import "server-only";
import { isAxiosError } from "axios";
import { and, eq, lt } from "drizzle-orm";

import { cancelMarket, resolveMarket } from "@/data/markets";
import { db } from "@/lib/db";
import { markets as marketsTable } from "@/lib/db/schema";

import { KALSHI_SERIES, type KalshiEvent, kalshiEvents, type KalshiSeriesTicker } from "./index";
import { translateKalshiResolution, type ResolutionTranslation } from "./translator";

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

export type SeriesResolveSummary = {
  considered: number;
  resolved: number;
  cancelled: number;
  skipped: Record<SkipReason, number>;
};

export type KalshiResolveSummary = {
  bySeries: Record<string, SeriesResolveSummary>;
  totals: {
    considered: number;
    resolved: number;
    cancelled: number;
    skipped: Record<SkipReason, number>;
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
  return { considered: 0, resolved: 0, cancelled: 0, skipped: emptySkipCounters() };
}

function eventTickerFromMarketId(marketId: string): string | null {
  if (!marketId.startsWith(MARKET_ID_PREFIX)) return null;
  return marketId.slice(MARKET_ID_PREFIX.length);
}

type PastCloseMarket = typeof marketsTable.$inferSelect;

export async function runKalshiResolve(now: number = Date.now()): Promise<KalshiResolveSummary> {
  const summary: KalshiResolveSummary = {
    bySeries: {},
    totals: { considered: 0, resolved: 0, cancelled: 0, skipped: emptySkipCounters() },
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
      countResolve(result, summary);
      return;
    }
    case "resolved_b": {
      const result = await resolveMarket(row.id, "B");
      countResolve(result, summary);
      return;
    }
    case "voided": {
      const result = await cancelMarket(row.id, "kalshi_voided");
      countCancel(result, summary);
      return;
    }
    case "not_settled_yet": {
      if (now - row.closesAt > SETTLEMENT_DEADLINE_MS) {
        const result = await cancelMarket(row.id, "kalshi_no_settlement");
        countCancel(result, summary);
      } else {
        summary.skipped.not_settled_yet++;
      }
      return;
    }
    case "ambiguous": {
      summary.skipped.ambiguous++;
      return;
    }
    case "kalshi_event_missing": {
      summary.skipped.kalshi_event_missing++;
      return;
    }
  }
}

function countResolve(
  result: Awaited<ReturnType<typeof resolveMarket>>,
  summary: SeriesResolveSummary,
): void {
  if (result.resolved) {
    if (result.alreadyResolved) summary.skipped.already_resolved++;
    else summary.resolved++;
  } else {
    summary.skipped.ambiguous++;
  }
}

function countCancel(
  result: Awaited<ReturnType<typeof cancelMarket>>,
  summary: SeriesResolveSummary,
): void {
  if (result.cancelled) {
    if (result.alreadyCancelled) summary.skipped.already_cancelled++;
    else summary.cancelled++;
  } else {
    summary.skipped.ambiguous++;
  }
}
