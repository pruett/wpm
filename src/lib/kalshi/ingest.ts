import "server-only";
import { createMarket } from "@/data/markets";

import {
  currentUnixSeconds,
  GetEventsStatusEnum,
  KALSHI_SERIES,
  kalshiEvents,
  type KalshiSeriesTicker,
} from "./index";
import { translateKalshiEvent, type TranslationResult } from "./translator";

const SERIES_TO_SPORT: Record<KalshiSeriesTicker, string> = {
  [KALSHI_SERIES.MLB]: "mlb",
  [KALSHI_SERIES.NFL]: "nfl",
  [KALSHI_SERIES.NBA]: "nba",
  [KALSHI_SERIES.NHL]: "nhl",
};

type SkipReasonKind = Exclude<TranslationResult["kind"], "ok"> | "already_exists";

export type SeriesIngestSummary = {
  fetched: number;
  created: number;
  skipped: Record<SkipReasonKind, number>;
};

export type KalshiIngestSummary = {
  bySeries: Record<string, SeriesIngestSummary>;
  totals: { fetched: number; created: number; skipped: Record<SkipReasonKind, number> };
};

function emptySkipCounters(): Record<SkipReasonKind, number> {
  return {
    non_binary: 0,
    unparseable_close_time: 0,
    no_initial_price: 0,
    insufficient_confidence: 0,
    already_exists: 0,
  };
}

export async function runKalshiIngest(): Promise<KalshiIngestSummary> {
  const summary: KalshiIngestSummary = {
    bySeries: {},
    totals: { fetched: 0, created: 0, skipped: emptySkipCounters() },
  };

  for (const seriesTicker of Object.values(KALSHI_SERIES)) {
    const result = await ingestSeries(seriesTicker);
    summary.bySeries[seriesTicker] = result;
    summary.totals.fetched += result.fetched;
    summary.totals.created += result.created;
    for (const key of Object.keys(result.skipped) as SkipReasonKind[]) {
      summary.totals.skipped[key] += result.skipped[key];
    }
  }

  return summary;
}

async function ingestSeries(seriesTicker: KalshiSeriesTicker): Promise<SeriesIngestSummary> {
  const { data } = await kalshiEvents().getEvents(
    undefined,
    undefined,
    true,
    undefined,
    GetEventsStatusEnum.Open,
    seriesTicker,
    currentUnixSeconds(),
  );
  const sport = SERIES_TO_SPORT[seriesTicker];

  let created = 0;
  const skipped = emptySkipCounters();

  for (const event of data.events) {
    const result = translateKalshiEvent(event, sport);
    if (result.kind !== "ok") {
      skipped[result.kind]++;
      continue;
    }
    const persistence = await createMarket(result.value);
    if (persistence.created) {
      created++;
    } else {
      skipped[persistence.reason]++;
    }
  }

  return { fetched: data.events.length, created, skipped };
}
