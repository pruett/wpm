import { describe, expect, it } from "vitest";

import binaryHealthy from "./fixtures/binary-healthy.json" with { type: "json" };
import nonBinary from "./fixtures/non-binary.json" with { type: "json" };
import unparseableCloseTime from "./fixtures/unparseable-close-time.json" with { type: "json" };
import zeroSpread from "./fixtures/zero-spread.json" with { type: "json" };
import { KalshiEventsResponse } from "./index.js";
import { translateKalshiEvent } from "./translator.js";

describe("translateKalshiEvent", () => {
  it("translates a healthy binary event", () => {
    const { events } = KalshiEventsResponse.parse(binaryHealthy);
    const result = translateKalshiEvent(events[0], "mlb");

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const { market, seedAmount, initialProbabilityA } = result.value;
    expect(market.id).toBe("kalshi-KXMLBGAME-25APR24NYYBOS");
    expect(market.sport).toBe("mlb");
    expect(market.name).toBe("New York Yankees at Boston Red Sox");
    expect(market.teamA).toBe("Yankees");
    expect(market.teamB).toBe("Red Sox");
    expect(market.tickerA).toBe("KXMLBGAME-25APR24NYYBOS-NYY");
    expect(market.tickerB).toBe("KXMLBGAME-25APR24NYYBOS-BOS");
    expect(market.closesAt).toBe(Date.parse("2026-04-25T02:00:00Z"));
    expect(seedAmount).toBe(1000);
    expect(initialProbabilityA).toBeCloseTo(0.56, 5);
  });

  it("skips events with zero-spread on either side", () => {
    const { events } = KalshiEventsResponse.parse(zeroSpread);
    const result = translateKalshiEvent(events[0], "mlb");

    expect(result).toEqual({
      kind: "no_initial_price",
      eventTicker: "KXMLBGAME-25APR24LADSFG",
    });
  });

  it("skips events with more than two nested markets", () => {
    const { events } = KalshiEventsResponse.parse(nonBinary);
    const result = translateKalshiEvent(events[0], "mlb");

    expect(result).toEqual({ kind: "non_binary", count: 3 });
  });

  it("skips events with an unparseable close timestamp", () => {
    const { events } = KalshiEventsResponse.parse(unparseableCloseTime);
    const result = translateKalshiEvent(events[0], "mlb");

    expect(result).toEqual({ kind: "unparseable_close_time", raw: "not-a-timestamp" });
  });
});
