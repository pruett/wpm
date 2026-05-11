import type { Sport } from "@/lib/types";

import { events, markets } from "@/lib/db/schema";

import type { KalshiEvent, KalshiMarket } from "./index";

const SEED_AMOUNT = 1000n;

// Maximum tolerated bid-ask spread on each Kalshi Market before we reject the
// event. A wide spread means buyers and sellers have not agreed on a price and
// the midpoint is a phantom. Applied per-child Market under the new
// multi-outcome model (PRD §Translator).
const MAX_SPREAD = 0.1;

type EventInsert = typeof events.$inferInsert;
type MarketInsert = typeof markets.$inferInsert;

export type TranslatedEventRow = Omit<EventInsert, "status" | "createdAt">;
export type TranslatedMarketRow = Omit<MarketInsert, "status" | "createdAt" | "eventId">;

export type TranslatedMarket = {
  market: TranslatedMarketRow;
  seedAmount: bigint;
  initialProbabilityYes: number;
};

export type TranslatedEvent = {
  event: TranslatedEventRow;
  markets: TranslatedMarket[];
};

export type InsufficientConfidenceReason = {
  ticker: string;
  reason: "spread_too_wide";
};

export type TranslationResult =
  | { kind: "ok"; value: TranslatedEvent }
  | { kind: "unparseable_close_time"; raw: string }
  | { kind: "no_initial_price"; eventTicker: string }
  | {
      kind: "insufficient_confidence";
      eventTicker: string;
      reasons: InsufficientConfidenceReason[];
    };

export function translateKalshiEvent(event: KalshiEvent, sport: Sport): TranslationResult {
  const nestedMarkets = event.markets ?? [];

  // Slice 1 happy path: source the Event's closesAt from the first child
  // Market's expected_expiration_time. Phase 2 will add an
  // `inconsistent_close_times` reject for siblings that disagree.
  const rawCloseTime = nestedMarkets[0]?.expected_expiration_time ?? "";
  const closesAt = Date.parse(rawCloseTime);
  if (!Number.isFinite(closesAt)) {
    return { kind: "unparseable_close_time", raw: rawCloseTime };
  }

  const quoted: { quote: Quote; market: KalshiMarket }[] = [];
  for (const m of nestedMarkets) {
    const q = quote(m);
    if (q === null) {
      return { kind: "no_initial_price", eventTicker: event.event_ticker };
    }
    quoted.push({ quote: q, market: m });
  }

  const reasons: InsufficientConfidenceReason[] = [];
  for (const { quote: q, market: m } of quoted) {
    if (q.spread > MAX_SPREAD) {
      reasons.push({ ticker: m.ticker, reason: "spread_too_wide" });
    }
  }
  if (reasons.length > 0) {
    return { kind: "insufficient_confidence", eventTicker: event.event_ticker, reasons };
  }

  const eventRow: TranslatedEventRow = {
    id: `kalshi-${event.event_ticker}`,
    sport,
    name: event.title,
    closesAt,
  };

  const translatedMarkets: TranslatedMarket[] = quoted.map(({ quote: q, market: m }) => ({
    market: {
      id: `kalshi-${m.ticker}`,
      sport,
      name: m.yes_sub_title,
      ticker: m.ticker,
      // Legacy A/B columns still required by the schema during Slice 1's
      // additive transition; dropped in Phase 1.
      teamA: m.yes_sub_title,
      teamB: "",
      tickerA: m.ticker,
      tickerB: null,
      closesAt,
      resolvedAs: null,
      resolvedOutcome: null,
      resolvedAt: null,
    },
    seedAmount: SEED_AMOUNT,
    initialProbabilityYes: q.mid,
  }));

  return {
    kind: "ok",
    value: { event: eventRow, markets: translatedMarkets },
  };
}

type Quote = { mid: number; spread: number };

function quote(market: KalshiMarket): Quote | null {
  const bid = Number(market.yes_bid_dollars);
  const ask = Number(market.yes_ask_dollars);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0) return null;
  return { mid: (bid + ask) / 2, spread: ask - bid };
}
