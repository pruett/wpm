import { markets } from "@/lib/db/schema";

import type { KalshiEvent, KalshiMarket } from "./index";

const SEED_AMOUNT = 1000;

type MarketInsert = typeof markets.$inferInsert;

export type TranslatedMarketRow = Omit<MarketInsert, "status" | "createdAt">;

export type TranslatedMarket = {
  market: TranslatedMarketRow;
  seedAmount: number;
  initialProbabilityA: number;
};

export type TranslationResult =
  | { kind: "ok"; value: TranslatedMarket }
  | { kind: "non_binary"; count: number }
  | { kind: "unparseable_close_time"; raw: string }
  | { kind: "no_initial_price"; eventTicker: string };

export function translateKalshiEvent(event: KalshiEvent, sport: string): TranslationResult {
  if (event.markets.length !== 2) {
    return { kind: "non_binary", count: event.markets.length };
  }

  const [a, b] = event.markets;

  const closesAt = Date.parse(a.expected_expiration_time);
  if (!Number.isFinite(closesAt)) {
    return { kind: "unparseable_close_time", raw: a.expected_expiration_time };
  }

  const probA = midProbability(a);
  const probB = midProbability(b);
  if (probA === null || probB === null) {
    return { kind: "no_initial_price", eventTicker: event.event_ticker };
  }

  return {
    kind: "ok",
    value: {
      market: {
        id: `kalshi-${event.event_ticker}`,
        sport,
        name: event.title,
        teamA: a.yes_sub_title,
        teamB: b.yes_sub_title,
        tickerA: a.ticker,
        tickerB: b.ticker,
        closesAt,
      },
      seedAmount: SEED_AMOUNT,
      initialProbabilityA: probA,
    },
  };
}

function midProbability(market: KalshiMarket): number | null {
  const bid = Number(market.yes_bid_dollars);
  const ask = Number(market.yes_ask_dollars);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0) return null;
  return (bid + ask) / 2;
}
