import { EventsApi, MarketApi } from "kalshi-typescript";

// Public market-data endpoints (/events, /series, /markets) need no auth,
// so a bare client against the default base path is all we need.
export const eventsApi = new EventsApi();
export const marketApi = new MarketApi();
