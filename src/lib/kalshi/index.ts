import {
  Configuration,
  type EventData,
  EventsApi,
  GetEventsStatusEnum,
  type Market,
} from "kalshi-typescript";

const KALSHI_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

export const KALSHI_SERIES = {
  MLB: "KXMLBGAME",
  NFL: "KXNFLGAME",
  NBA: "KXNBAGAME",
  NHL: "KXNHLGAME",
} as const;

export type KalshiSeriesTicker = (typeof KALSHI_SERIES)[keyof typeof KALSHI_SERIES];

// Re-exported under our domain names. The two ingest/resolve flows only ever
// touch the Events surface, so the SDK Configuration is intentionally
// credential-less — /events is a public endpoint.
export type KalshiEvent = EventData;
export type KalshiMarket = Market;

let cachedClient: EventsApi | null = null;

export function kalshiEvents(): EventsApi {
  if (!cachedClient) {
    cachedClient = new EventsApi(new Configuration({ basePath: KALSHI_BASE_URL }));
  }
  return cachedClient;
}

export function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export { GetEventsStatusEnum };
