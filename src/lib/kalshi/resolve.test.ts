import { describe, expect, it } from "vitest";

import type { KalshiEvent } from "./index.js";

import settledVoided from "./fixtures/settled-voided.json" with { type: "json" };
import { decideEventCommit, type WampumEventForDecision } from "./resolve.js";

// Fixtures only carry the subset of the SDK's EventData shape that the decision
// core reads — the cast lets us drive behavior without fabricating every field
// the full SDK type requires.
const eventOf = (fixture: unknown): KalshiEvent => (fixture as { events: KalshiEvent[] }).events[0];

describe("decideEventCommit", () => {
  it("voids the event when every child settled `no`", () => {
    const kalshi = eventOf(settledVoided);
    const wampum: WampumEventForDecision = {
      id: `kalshi-${kalshi.event_ticker}`,
      closesAt: Date.parse("2026-04-25T02:00:00Z"),
      markets: (kalshi.markets ?? []).map((m) => ({
        id: `kalshi-${m.ticker}`,
        ticker: m.ticker,
      })),
    };

    const decision = decideEventCommit(wampum, kalshi, Date.parse("2026-04-25T03:00:00Z"));

    expect(decision.kind).toBe("commit");
    if (decision.kind !== "commit") return;
    expect(decision.perChild).toEqual([
      { marketId: "kalshi-KXMLBGAME-25APR24RAINOUT-A", outcome: "cancelled_voided" },
      { marketId: "kalshi-KXMLBGAME-25APR24RAINOUT-B", outcome: "cancelled_voided" },
    ]);
  });
});
