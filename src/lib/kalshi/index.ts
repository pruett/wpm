import { z } from "zod";

const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

export const KALSHI_SERIES = {
  MLB: "KXMLBGAME",
  NFL: "KXNFLGAME",
  NBA: "KXNBAGAME",
  NHL: "KXNHLGAME",
} as const;

export type KalshiSeriesTicker = (typeof KALSHI_SERIES)[keyof typeof KALSHI_SERIES];

export const kalshiEventsUrl = (seriesTicker: string, minCloseTs: number = currentUnixSeconds()) =>
  `${KALSHI_BASE_URL}/events?series_ticker=${seriesTicker}&status=open&with_nested_markets=true&min_close_ts=${minCloseTs}`;

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const KalshiMarketSchema = z.object({
  ticker: z.string(),
  status: z.string(),
  yes_sub_title: z.string(),
  yes_bid_dollars: z.string(),
  yes_ask_dollars: z.string(),
  no_bid_dollars: z.string(),
  no_ask_dollars: z.string(),
  volume_24h_fp: z.string(),
  expected_expiration_time: z.string(),
});

export type KalshiMarket = z.infer<typeof KalshiMarketSchema>;

const KalshiEventSchema = z.object({
  event_ticker: z.string(),
  series_ticker: z.string(),
  title: z.string(),
  strike_date: z.string().default(""),
  markets: z.array(KalshiMarketSchema),
});

export type KalshiEvent = z.infer<typeof KalshiEventSchema>;

export const KalshiEventsResponse = z.object({
  events: z.array(KalshiEventSchema),
});

export type KalshiEventsResponse = z.infer<typeof KalshiEventsResponse>;
