import type { Sport } from "@/lib/types";

import { markets } from "@/lib/db/schema";

import type { KalshiEvent, KalshiMarket } from "./index";

const SEED_AMOUNT = 1000n;

// Maximum tolerated bid-ask spread on either Kalshi Market before we reject
// the event. A wide spread means buyers and sellers have not agreed on a
// price and the midpoint is a phantom.
const MAX_SPREAD = 0.1;
// Maximum tolerated disagreement between midProb_a and (1 - midProb_b) across
// the two Kalshi Markets of a single Event. Disagreement beyond this means
// the order book is internally inconsistent.
const MAX_PAIR_DISAGREEMENT = 0.05;

type MarketInsert = typeof markets.$inferInsert;

export type TranslatedMarketRow = Omit<MarketInsert, "status" | "createdAt">;

export type TranslatedMarket = {
  market: TranslatedMarketRow;
  seedAmount: bigint;
  initialProbabilityA: number;
};

export type InsufficientConfidenceReason =
  | "spread_a_too_wide"
  | "spread_b_too_wide"
  | "pair_inconsistent";

export type TranslationResult =
  | { kind: "ok"; value: TranslatedMarket }
  | { kind: "non_binary"; count: number }
  | { kind: "unparseable_close_time"; raw: string }
  | { kind: "no_initial_price"; eventTicker: string }
  | {
      kind: "insufficient_confidence";
      eventTicker: string;
      reasons: InsufficientConfidenceReason[];
    };

export function translateKalshiEvent(event: KalshiEvent, sport: Sport): TranslationResult {
  const nestedMarkets = event.markets ?? [];
  if (nestedMarkets.length !== 2) {
    return { kind: "non_binary", count: nestedMarkets.length };
  }

  const [a, b] = nestedMarkets;

  const rawCloseTime = a.expected_expiration_time ?? "";
  const closesAt = Date.parse(rawCloseTime);
  if (!Number.isFinite(closesAt)) {
    return { kind: "unparseable_close_time", raw: rawCloseTime };
  }

  const quoteA = quote(a);
  const quoteB = quote(b);
  if (quoteA === null || quoteB === null) {
    return { kind: "no_initial_price", eventTicker: event.event_ticker };
  }

  const reasons: InsufficientConfidenceReason[] = [];
  if (quoteA.spread > MAX_SPREAD) reasons.push("spread_a_too_wide");
  if (quoteB.spread > MAX_SPREAD) reasons.push("spread_b_too_wide");

  const impliedFromA = quoteA.mid;
  const impliedFromB = 1 - quoteB.mid;
  if (Math.abs(impliedFromA - impliedFromB) > MAX_PAIR_DISAGREEMENT) {
    reasons.push("pair_inconsistent");
  }

  if (reasons.length > 0) {
    return { kind: "insufficient_confidence", eventTicker: event.event_ticker, reasons };
  }

  const initialProbabilityA = (impliedFromA + impliedFromB) / 2;

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
      initialProbabilityA,
    },
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

// "settled" is included alongside the SDK's MarketStatusEnum terminal values
// because the live Kalshi API still emits it on the elections host even though
// the SDK enum omits it.
const TERMINAL_KALSHI_STATUSES = new Set<string>(["settled", "finalized", "determined"]);

function isTerminalKalshiStatus(status: string): boolean {
  return TERMINAL_KALSHI_STATUSES.has(status);
}

export type ResolutionTranslation =
  | { kind: "resolved_a" }
  | { kind: "resolved_b" }
  | { kind: "voided" }
  | { kind: "not_settled_yet" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "kalshi_event_missing" };

export function translateKalshiResolution(event: KalshiEvent): ResolutionTranslation {
  const nestedMarkets = event.markets ?? [];
  if (nestedMarkets.length !== 2) {
    return {
      kind: "ambiguous",
      reason: `expected 2 nested markets, got ${nestedMarkets.length}`,
    };
  }
  const [a, b] = nestedMarkets;

  if (!isTerminalKalshiStatus(a.status) || !isTerminalKalshiStatus(b.status)) {
    return { kind: "not_settled_yet" };
  }

  const ra = a.result;
  const rb = b.result;

  if (ra === "yes" && rb === "no") return { kind: "resolved_a" };
  if (ra === "no" && rb === "yes") return { kind: "resolved_b" };
  if (ra === "no" && rb === "no") return { kind: "voided" };

  return {
    kind: "ambiguous",
    reason: `terminal but unexpected result pair: a=${ra || "<empty>"} b=${rb || "<empty>"}`,
  };
}
