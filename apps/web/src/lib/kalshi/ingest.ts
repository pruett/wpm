import "server-only";
import { initializePool } from "@wpm/shared";
import { Schema } from "effect";

import { createMarket, type CreateMarketInput } from "@/data/markets";

import {
  KALSHI_SERIES,
  KalshiEventsResponse,
  kalshiEventsUrl,
  type KalshiEvent,
  type KalshiMarket,
  type KalshiSeriesTicker,
} from "./index";

const SEED_AMOUNT = 1000;

const SERIES_TO_SPORT: Record<KalshiSeriesTicker, string> = {
  [KALSHI_SERIES.MLB]: "mlb",
  [KALSHI_SERIES.NFL]: "nfl",
  [KALSHI_SERIES.NBA]: "nba",
  [KALSHI_SERIES.NHL]: "nhl",
};

export type KalshiIngestSummary = {
  bySeries: Record<string, { fetched: number; created: number; skipped: number }>;
  totals: { fetched: number; created: number; skipped: number };
};

export async function runKalshiIngest(): Promise<KalshiIngestSummary> {
  const summary: KalshiIngestSummary = {
    bySeries: {},
    totals: { fetched: 0, created: 0, skipped: 0 },
  };

  for (const seriesTicker of Object.values(KALSHI_SERIES)) {
    const result = await ingestSeries(seriesTicker);
    summary.bySeries[seriesTicker] = result;
    summary.totals.fetched += result.fetched;
    summary.totals.created += result.created;
    summary.totals.skipped += result.skipped;
  }

  return summary;
}

async function ingestSeries(seriesTicker: KalshiSeriesTicker) {
  const response = await fetch(kalshiEventsUrl(seriesTicker));
  if (!response.ok) {
    throw new Error(`Kalshi ${seriesTicker} request failed: ${response.status}`);
  }
  const parsed = Schema.decodeUnknownSync(KalshiEventsResponse)(await response.json());
  const sport = SERIES_TO_SPORT[seriesTicker];

  let created = 0;
  let skipped = 0;

  for (const event of parsed.events) {
    const req = toCreateMarketRequest(event, sport);
    if (!req) {
      skipped++;
      continue;
    }
    const result = await createMarket(req);
    if (result.created) created++;
    else skipped++;
  }

  return { fetched: parsed.events.length, created, skipped };
}

function toCreateMarketRequest(event: KalshiEvent, sport: string): CreateMarketInput | null {
  // Only binary events map to our A/B AMM.
  if (event.markets.length !== 2) return null;

  const [a, b] = event.markets;
  const closesAt = Date.parse(a.expected_expiration_time);
  if (!Number.isFinite(closesAt)) return null;

  const probA = midProbability(a);
  const id = `kalshi-${event.event_ticker}`;
  const pool = initializePool(id, SEED_AMOUNT, probA ?? undefined);

  return {
    id,
    sport,
    name: event.title,
    teamA: a.yes_sub_title,
    teamB: b.yes_sub_title,
    tickerA: a.ticker,
    tickerB: b.ticker,
    closesAt: new Date(closesAt).toISOString(),
    seedAmount: SEED_AMOUNT,
    initialProbabilityA: probA ?? undefined,
    reserveA: pool.sharesA,
    reserveB: pool.sharesB,
    wpmReserve: pool.liquidity,
    yesBidCentsA: dollarsToCents(a.yes_bid_dollars),
    yesAskCentsA: dollarsToCents(a.yes_ask_dollars),
    noBidCentsA: dollarsToCents(a.no_bid_dollars),
    noAskCentsA: dollarsToCents(a.no_ask_dollars),
    yesBidCentsB: dollarsToCents(b.yes_bid_dollars),
    yesAskCentsB: dollarsToCents(b.yes_ask_dollars),
    noBidCentsB: dollarsToCents(b.no_bid_dollars),
    noAskCentsB: dollarsToCents(b.no_ask_dollars),
    volume24hA: volumeToInt(a.volume_24h_fp),
    volume24hB: volumeToInt(b.volume_24h_fp),
  };
}

function midProbability(market: KalshiMarket): number | null {
  const bid = Number(market.yes_bid_dollars);
  const ask = Number(market.yes_ask_dollars);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid === 0 && ask === 0) return null;
  return (bid + ask) / 2;
}

function dollarsToCents(dollars: string): number {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function volumeToInt(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}
