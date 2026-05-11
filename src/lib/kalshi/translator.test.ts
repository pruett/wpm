import { describe, expect, it } from "vitest";

import type { KalshiEvent } from "./index.js";

import binaryHealthy from "./fixtures/binary-healthy.json" with { type: "json" };
import multiOutcomeHealthy from "./fixtures/multi-outcome-healthy.json" with { type: "json" };
import skewedHealthy from "./fixtures/skewed-healthy.json" with { type: "json" };
import unparseableCloseTime from "./fixtures/unparseable-close-time.json" with { type: "json" };
import wideSpread from "./fixtures/wide-spread.json" with { type: "json" };
import zeroSpread from "./fixtures/zero-spread.json" with { type: "json" };
import { translateKalshiEvent } from "./translator.js";

// Fixtures only carry the subset of the SDK's EventData/Market shape that the
// translator reads — the cast lets us exercise translator behavior without
// fabricating every field the full SDK type requires.
const eventOf = (fixture: unknown): KalshiEvent => (fixture as { events: KalshiEvent[] }).events[0];

describe("translateKalshiEvent", () => {
  it("translates a healthy 2-Market event into one Event row + two Market rows", () => {
    const result = translateKalshiEvent(eventOf(binaryHealthy), "mlb");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const { event, markets } = result.value;
    expect(event.id).toBe("kalshi-KXMLBGAME-25APR24NYYBOS");
    expect(event.sport).toBe("mlb");
    expect(event.name).toBe("New York Yankees at Boston Red Sox");
    expect(event.closesAt).toBe(Date.parse("2026-04-25T02:00:00Z"));

    expect(markets).toHaveLength(2);

    const [yankees, redSox] = markets;
    expect(yankees.market.id).toBe("kalshi-KXMLBGAME-25APR24NYYBOS-NYY");
    expect(yankees.market.name).toBe("Yankees");
    expect(yankees.market.ticker).toBe("KXMLBGAME-25APR24NYYBOS-NYY");
    expect(yankees.seedAmount).toBe(1000n);
    expect(yankees.initialProbabilityYes).toBeCloseTo(0.56, 5);

    expect(redSox.market.id).toBe("kalshi-KXMLBGAME-25APR24NYYBOS-BOS");
    expect(redSox.market.name).toBe("Red Sox");
    expect(redSox.market.ticker).toBe("KXMLBGAME-25APR24NYYBOS-BOS");
    expect(redSox.initialProbabilityYes).toBeCloseTo(0.44, 5);
  });

  it("translates a healthy 5-Market multi-outcome event into one Event row + five Market rows", () => {
    const result = translateKalshiEvent(eventOf(multiOutcomeHealthy), "nba");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const { event, markets } = result.value;
    expect(event.id).toBe("kalshi-KXNBACHAMP-26");
    expect(event.sport).toBe("nba");
    expect(event.name).toBe("Who will win the 2026 NBA Championship?");
    expect(event.closesAt).toBe(Date.parse("2026-06-21T03:00:00Z"));

    expect(markets).toHaveLength(5);

    const expected: { id: string; name: string; ticker: string; prob: number }[] = [
      {
        id: "kalshi-KXNBACHAMP-26-BOS",
        name: "Boston Celtics",
        ticker: "KXNBACHAMP-26-BOS",
        prob: 0.3,
      },
      {
        id: "kalshi-KXNBACHAMP-26-DEN",
        name: "Denver Nuggets",
        ticker: "KXNBACHAMP-26-DEN",
        prob: 0.25,
      },
      {
        id: "kalshi-KXNBACHAMP-26-OKC",
        name: "Oklahoma City Thunder",
        ticker: "KXNBACHAMP-26-OKC",
        prob: 0.2,
      },
      {
        id: "kalshi-KXNBACHAMP-26-MIN",
        name: "Minnesota Timberwolves",
        ticker: "KXNBACHAMP-26-MIN",
        prob: 0.15,
      },
      {
        id: "kalshi-KXNBACHAMP-26-NYK",
        name: "New York Knicks",
        ticker: "KXNBACHAMP-26-NYK",
        prob: 0.1,
      },
    ];

    for (const [i, want] of expected.entries()) {
      const child = markets[i];
      expect(child.market.id).toBe(want.id);
      expect(child.market.name).toBe(want.name);
      expect(child.market.ticker).toBe(want.ticker);
      expect(child.market.closesAt).toBe(event.closesAt);
      expect(child.seedAmount).toBe(1000n);
      expect(child.initialProbabilityYes).toBeCloseTo(want.prob, 5);
    }
  });

  it("skips events with zero-spread on any child", () => {
    const result = translateKalshiEvent(eventOf(zeroSpread), "mlb");

    expect(result).toEqual({
      kind: "no_initial_price",
      eventTicker: "KXMLBGAME-25APR24LADSFG",
    });
  });

  it("skips events with an unparseable close timestamp", () => {
    const result = translateKalshiEvent(eventOf(unparseableCloseTime), "mlb");

    expect(result).toEqual({ kind: "unparseable_close_time", raw: "not-a-timestamp" });
  });

  it("rejects events where any child Kalshi Market has a wide bid-ask spread", () => {
    const result = translateKalshiEvent(eventOf(wideSpread), "mlb");

    expect(result.kind).toBe("insufficient_confidence");
    if (result.kind !== "insufficient_confidence") return;
    expect(result.eventTicker).toBe("KXMLBGAME-25APR24WIDESPREAD");
    expect(result.reasons.some((r) => r.reason === "spread_too_wide")).toBe(true);
  });

  it("accepts a skewed but healthy event and seeds each child with its own YES probability", () => {
    const result = translateKalshiEvent(eventOf(skewedHealthy), "mlb");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Each child Market's initialProbabilityYes is now its own YES midpoint —
    // no pair-averaging, since under the multi-outcome model each Market is
    // an independent YES/NO contract.
    const [first, second] = result.value.markets;
    expect(first.initialProbabilityYes).toBeCloseTo(0.86, 5);
    expect(second.initialProbabilityYes).toBeCloseTo(0.14, 5);
  });

  it("computes per-child initialProbabilityYes from that child's own bid/ask midpoint", () => {
    const result = translateKalshiEvent(eventOf(binaryHealthy), "mlb");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const [yankees, redSox] = result.value.markets;
    expect(yankees.initialProbabilityYes).toBeCloseTo(0.56, 5);
    expect(redSox.initialProbabilityYes).toBeCloseTo(0.44, 5);
  });

  it("rejects events where siblings disagree on expected_expiration_time", () => {
    const base = eventOf(binaryHealthy);
    const [first, second] = base.markets ?? [];
    const mismatched: KalshiEvent = {
      ...base,
      event_ticker: "KXMLBGAME-MISMATCHED-CLOSE",
      markets: [first, { ...second, expected_expiration_time: "2026-05-01T02:00:00Z" }],
    };

    const result = translateKalshiEvent(mismatched, "mlb");

    expect(result.kind).toBe("inconsistent_close_times");
    if (result.kind !== "inconsistent_close_times") return;
    expect(result.eventTicker).toBe("KXMLBGAME-MISMATCHED-CLOSE");
    expect(result.expected).toBe(first.expected_expiration_time);
    expect(result.offenders).toEqual([{ ticker: second.ticker, raw: "2026-05-01T02:00:00Z" }]);
  });

  it("rejects events with more than 30 child markets", () => {
    const base = eventOf(binaryHealthy);
    const [child] = base.markets ?? [];
    const oversized: KalshiEvent = {
      ...base,
      event_ticker: "KXMLBGAME-OVERSIZED",
      markets: Array.from({ length: 31 }, (_, i) => ({
        ...child,
        ticker: `KXMLBGAME-OVERSIZED-${i}`,
      })),
    };

    const result = translateKalshiEvent(oversized, "mlb");

    expect(result).toEqual({
      kind: "too_many_markets",
      eventTicker: "KXMLBGAME-OVERSIZED",
      count: 31,
    });
  });
});
