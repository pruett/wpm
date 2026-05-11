import { describe, expect, it } from "vitest";

import type { KalshiEvent } from "./index.js";

import binaryHealthy from "./fixtures/binary-healthy.json" with { type: "json" };
import notSettledYet from "./fixtures/not-settled-yet.json" with { type: "json" };
import settledAWins from "./fixtures/settled-a-wins.json" with { type: "json" };
import settledAmbiguous from "./fixtures/settled-ambiguous.json" with { type: "json" };
import settledBWins from "./fixtures/settled-b-wins.json" with { type: "json" };
import settledScalar from "./fixtures/settled-scalar.json" with { type: "json" };
import settledVoided from "./fixtures/settled-voided.json" with { type: "json" };
import skewedHealthy from "./fixtures/skewed-healthy.json" with { type: "json" };
import unparseableCloseTime from "./fixtures/unparseable-close-time.json" with { type: "json" };
import wideSpread from "./fixtures/wide-spread.json" with { type: "json" };
import zeroSpread from "./fixtures/zero-spread.json" with { type: "json" };
import { translateKalshiEvent, translateKalshiResolution } from "./translator.js";

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
});

describe("translateKalshiResolution", () => {
  it("maps A yes / B no to resolved_a", () => {
    expect(translateKalshiResolution(eventOf(settledAWins))).toEqual({ kind: "resolved_a" });
  });

  it("maps A no / B yes to resolved_b", () => {
    expect(translateKalshiResolution(eventOf(settledBWins))).toEqual({ kind: "resolved_b" });
  });

  it("maps both-no to voided", () => {
    expect(translateKalshiResolution(eventOf(settledVoided))).toEqual({ kind: "voided" });
  });

  it("maps a scalar (partial) settlement to scalar_settled with payout details", () => {
    const result = translateKalshiResolution(eventOf(settledScalar));
    expect(result.kind).toBe("scalar_settled");
    if (result.kind !== "scalar_settled") return;
    expect(result.reason).toContain("0.5000");
  });

  it("returns not_settled_yet when either side is non-terminal", () => {
    expect(translateKalshiResolution(eventOf(notSettledYet))).toEqual({ kind: "not_settled_yet" });
  });

  it("returns ambiguous when both sides terminal but results are both yes", () => {
    const result = translateKalshiResolution(eventOf(settledAmbiguous));
    expect(result.kind).toBe("ambiguous");
  });

  it("returns not_settled_yet when result fields are empty (pre-settlement)", () => {
    expect(translateKalshiResolution(eventOf(binaryHealthy))).toEqual({ kind: "not_settled_yet" });
  });
});
