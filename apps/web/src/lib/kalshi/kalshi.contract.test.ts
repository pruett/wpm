import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { KALSHI_SERIES, KalshiEventsResponse, kalshiEventsUrl } from "./index.js";

describe("Kalshi API contract", () => {
  it(
    "MLB events?series=KXMLBGAME response matches our schema with nested markets",
    { timeout: 30_000 },
    async () => {
      const res = await fetch(kalshiEventsUrl(KALSHI_SERIES.MLB));
      expect(res.status).toBe(200);

      const parsed = Schema.decodeUnknownSync(KalshiEventsResponse)(await res.json());
      expect(Array.isArray(parsed.events)).toBe(true);
      expect(parsed.events.length).toBeGreaterThan(0);

      for (const event of parsed.events) {
        expect(event.event_ticker.startsWith(`${KALSHI_SERIES.MLB}-`)).toBe(true);
        expect(event.series_ticker).toBe(KALSHI_SERIES.MLB);
        // Binary moneyline games always have exactly two sides
        expect(event.markets.length).toBe(2);

        for (const market of event.markets) {
          expect(market.ticker.startsWith(`${event.event_ticker}-`)).toBe(true);
          expect(typeof market.yes_sub_title).toBe("string");
          expect(market.yes_sub_title.length).toBeGreaterThan(0);
          // Dollar fields come back as strings — must parse as finite numbers in [0, 1]
          for (const priceField of [
            market.yes_bid_dollars,
            market.yes_ask_dollars,
            market.no_bid_dollars,
            market.no_ask_dollars,
          ]) {
            const n = Number(priceField);
            expect(Number.isFinite(n)).toBe(true);
            expect(n).toBeGreaterThanOrEqual(0);
            expect(n).toBeLessThanOrEqual(1);
          }
          expect(Number.isFinite(Number(market.volume_24h_fp))).toBe(true);
          expect(Number.isFinite(Date.parse(market.expected_expiration_time))).toBe(true);
        }
      }
    },
  );

  it(
    "NFL events?series=KXNFLGAME response decodes (may be empty during offseason)",
    { timeout: 30_000 },
    async () => {
      const res = await fetch(kalshiEventsUrl(KALSHI_SERIES.NFL));
      expect(res.status).toBe(200);

      const parsed = Schema.decodeUnknownSync(KalshiEventsResponse)(await res.json());
      expect(Array.isArray(parsed.events)).toBe(true);

      for (const event of parsed.events) {
        expect(event.series_ticker).toBe(KALSHI_SERIES.NFL);
        expect(event.markets.length).toBeGreaterThanOrEqual(2);
      }
    },
  );
});
