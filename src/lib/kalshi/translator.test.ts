import { describe, expect, it } from "vitest";

import binaryHealthy from "./fixtures/binary-healthy.json" with { type: "json" };
import nonBinary from "./fixtures/non-binary.json" with { type: "json" };
import notSettledYet from "./fixtures/not-settled-yet.json" with { type: "json" };
import settledAWins from "./fixtures/settled-a-wins.json" with { type: "json" };
import settledAmbiguous from "./fixtures/settled-ambiguous.json" with { type: "json" };
import settledBWins from "./fixtures/settled-b-wins.json" with { type: "json" };
import settledVoided from "./fixtures/settled-voided.json" with { type: "json" };
import unparseableCloseTime from "./fixtures/unparseable-close-time.json" with { type: "json" };
import zeroSpread from "./fixtures/zero-spread.json" with { type: "json" };
import { KalshiEventsResponse } from "./index.js";
import { translateKalshiEvent, translateKalshiResolution } from "./translator.js";

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

describe("translateKalshiResolution", () => {
  it("maps A yes / B no to resolved_a", () => {
    const { events } = KalshiEventsResponse.parse(settledAWins);
    expect(translateKalshiResolution(events[0])).toEqual({ kind: "resolved_a" });
  });

  it("maps A no / B yes to resolved_b", () => {
    const { events } = KalshiEventsResponse.parse(settledBWins);
    expect(translateKalshiResolution(events[0])).toEqual({ kind: "resolved_b" });
  });

  it("maps both-no to voided", () => {
    const { events } = KalshiEventsResponse.parse(settledVoided);
    expect(translateKalshiResolution(events[0])).toEqual({ kind: "voided" });
  });

  it("returns not_settled_yet when either side is non-terminal", () => {
    const { events } = KalshiEventsResponse.parse(notSettledYet);
    expect(translateKalshiResolution(events[0])).toEqual({ kind: "not_settled_yet" });
  });

  it("returns ambiguous when both sides terminal but results are both yes", () => {
    const { events } = KalshiEventsResponse.parse(settledAmbiguous);
    const result = translateKalshiResolution(events[0]);
    expect(result.kind).toBe("ambiguous");
  });

  it("returns not_settled_yet when result fields are empty (pre-settlement)", () => {
    const { events } = KalshiEventsResponse.parse(binaryHealthy);
    expect(translateKalshiResolution(events[0])).toEqual({ kind: "not_settled_yet" });
  });

  it("returns ambiguous for non-binary events", () => {
    const { events } = KalshiEventsResponse.parse(nonBinary);
    const result = translateKalshiResolution(events[0]);
    expect(result.kind).toBe("ambiguous");
  });
});
