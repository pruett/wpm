import {
  Configuration,
  type ConfigurationParameters,
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

export type KalshiEvent = EventData;
export type KalshiMarket = Market;

// Authenticated requests use the SDK's built-in signer: BaseAPI installs an
// axios interceptor that signs every call with RSA-PSS-SHA256 over
// `timestamp + METHOD + path`, putting us in the documented per-account read
// bucket (Basic = 200 tokens/sec).
function buildConfig(): Configuration {
  const apiKey = process.env.KALSHI_KEY_ID;
  if (!apiKey) throw new Error("KALSHI_KEY_ID is required");

  const pemRaw = process.env.KALSHI_PRIVATE_KEY;
  const privateKeyPem = pemRaw?.includes("\\n") ? pemRaw.replace(/\\n/g, "\n") : pemRaw;
  const privateKeyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!privateKeyPem && !privateKeyPath) {
    throw new Error("KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH is required");
  }

  const params: ConfigurationParameters = { basePath: KALSHI_BASE_URL, apiKey };
  if (privateKeyPem) params.privateKeyPem = privateKeyPem;
  else params.privateKeyPath = privateKeyPath;
  return new Configuration(params);
}

let cachedClient: EventsApi | null = null;

export function kalshiEvents(): EventsApi {
  if (!cachedClient) {
    cachedClient = new EventsApi(buildConfig());
  }
  return cachedClient;
}

export function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export { GetEventsStatusEnum };
