import { Schema } from "effect";

const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

export const KALSHI_SERIES = {
  MLB: "KXMLBGAME",
  NFL: "KXNFLGAME",
  NBA: "KXNBAGAME",
  NHL: "KXNHLGAME",
} as const;

export type KalshiSeriesTicker = (typeof KALSHI_SERIES)[keyof typeof KALSHI_SERIES];

export const kalshiEventsUrl = (seriesTicker: string) =>
  `${KALSHI_BASE_URL}/events?series_ticker=${seriesTicker}&status=open&with_nested_markets=true`;

// --- Market schema (nested inside each event) ---

const KalshiMarket = Schema.Struct({
  ticker: Schema.String,
  status: Schema.String,
  yes_sub_title: Schema.String,
  yes_bid_dollars: Schema.String,
  yes_ask_dollars: Schema.String,
  no_bid_dollars: Schema.String,
  no_ask_dollars: Schema.String,
  volume_24h_fp: Schema.String,
  expected_expiration_time: Schema.String,
});

export type KalshiMarket = typeof KalshiMarket.Type;

// --- Event schema ---

const KalshiEvent = Schema.Struct({
  event_ticker: Schema.String,
  series_ticker: Schema.String,
  title: Schema.String,
  strike_date: Schema.optionalWith(Schema.String, { default: () => "" }),
  markets: Schema.Array(KalshiMarket),
});

export type KalshiEvent = typeof KalshiEvent.Type;

// --- Events list response ---

export const KalshiEventsResponse = Schema.Struct({
  events: Schema.Array(KalshiEvent),
});

export type KalshiEventsResponse = typeof KalshiEventsResponse.Type;
