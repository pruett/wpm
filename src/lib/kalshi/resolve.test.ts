import { describe, expect, it } from "vitest";

import type { KalshiEvent } from "./index.js";

import notSettledYet from "./fixtures/not-settled-yet.json" with { type: "json" };
import settledAWins from "./fixtures/settled-a-wins.json" with { type: "json" };
import settledScalar from "./fixtures/settled-scalar.json" with { type: "json" };
import settledVoided from "./fixtures/settled-voided.json" with { type: "json" };
import { decideEventCommit, type WampumEventForDecision } from "./resolve.js";

// Fixtures only carry the subset of the SDK's EventData shape that the decision
// core reads — the cast lets us drive behavior without fabricating every field
// the full SDK type requires.
const eventOf = (fixture: unknown): KalshiEvent => (fixture as { events: KalshiEvent[] }).events[0];

const CLOSES_AT = Date.parse("2026-04-25T02:00:00Z");
const BEFORE_DEADLINE = CLOSES_AT + 60 * 60 * 1000; // closesAt + 1h
const AFTER_DEADLINE = CLOSES_AT + 49 * 60 * 60 * 1000; // closesAt + 49h

describe("decideEventCommit", () => {
  it("commits with resolved_yes/resolved_no when every child settles cleanly", () => {
    const kalshi = eventOf(settledAWins);
    const wampum: WampumEventForDecision = {
      id: `kalshi-${kalshi.event_ticker}`,
      closesAt: CLOSES_AT,
      markets: (kalshi.markets ?? []).map((m) => ({
        id: `kalshi-${m.ticker}`,
        ticker: m.ticker,
      })),
    };

    const decision = decideEventCommit(wampum, kalshi, BEFORE_DEADLINE);

    expect(decision.kind).toBe("commit");
    if (decision.kind !== "commit") return;
    expect(decision.perChild).toEqual([
      { marketId: "kalshi-KXMLBGAME-25APR24NYYBOS-NYY", outcome: "resolved_yes" },
      { marketId: "kalshi-KXMLBGAME-25APR24NYYBOS-BOS", outcome: "resolved_no" },
    ]);
  });

  it("voids the event when every child settled `no`", () => {
    const kalshi = eventOf(settledVoided);
    const wampum: WampumEventForDecision = {
      id: `kalshi-${kalshi.event_ticker}`,
      closesAt: CLOSES_AT,
      markets: (kalshi.markets ?? []).map((m) => ({
        id: `kalshi-${m.ticker}`,
        ticker: m.ticker,
      })),
    };

    const decision = decideEventCommit(wampum, kalshi, BEFORE_DEADLINE);

    expect(decision.kind).toBe("commit");
    if (decision.kind !== "commit") return;
    expect(decision.perChild).toEqual([
      { marketId: "kalshi-KXMLBGAME-25APR24RAINOUT-A", outcome: "cancelled_voided" },
      { marketId: "kalshi-KXMLBGAME-25APR24RAINOUT-B", outcome: "cancelled_voided" },
    ]);
  });

  it("waits when any child is non-terminal and the deadline has not been reached", () => {
    const kalshi = eventOf(notSettledYet);
    const wampum: WampumEventForDecision = {
      id: `kalshi-${kalshi.event_ticker}`,
      closesAt: CLOSES_AT,
      markets: (kalshi.markets ?? []).map((m) => ({
        id: `kalshi-${m.ticker}`,
        ticker: m.ticker,
      })),
    };

    const decision = decideEventCommit(wampum, kalshi, BEFORE_DEADLINE);

    expect(decision).toEqual({ kind: "wait" });
  });

  it("commits cancelled_scalar for a scalar child alongside cleanly-resolved siblings", () => {
    // Mixed payload: a yes-settled child from one event paired with a
    // scalar-settled child from another. The scalar child should commit as
    // `cancelled_scalar` while the sibling resolves normally on its `result`.
    const settledA = eventOf(settledAWins);
    const scalar = eventOf(settledScalar);
    const yesChild = (settledA.markets ?? [])[0];
    const scalarChild = (scalar.markets ?? [])[0];

    const kalshi: KalshiEvent = {
      ...settledA,
      markets: [yesChild, scalarChild],
    };

    const wampum: WampumEventForDecision = {
      id: `kalshi-${kalshi.event_ticker}`,
      closesAt: CLOSES_AT,
      markets: [
        { id: `kalshi-${yesChild.ticker}`, ticker: yesChild.ticker },
        { id: `kalshi-${scalarChild.ticker}`, ticker: scalarChild.ticker },
      ],
    };

    const decision = decideEventCommit(wampum, kalshi, BEFORE_DEADLINE);

    expect(decision.kind).toBe("commit");
    if (decision.kind !== "commit") return;
    expect(decision.perChild).toEqual([
      { marketId: `kalshi-${yesChild.ticker}`, outcome: "resolved_yes" },
      { marketId: `kalshi-${scalarChild.ticker}`, outcome: "cancelled_scalar" },
    ]);
  });

  it("commits mixed outcomes (cancelled_scalar + cancelled_no_settlement + three resolved_*) past the deadline", () => {
    // Synthesise a 5-child event combining: one yes-settled child, one
    // no-settled child, another yes-settled child (so void semantics doesn't
    // trip), one scalar-settled child, and one still-active child. Past the
    // deadline, the active child degrades to cancelled_no_settlement; the
    // others commit on their respective Kalshi results.
    const settledA = eventOf(settledAWins);
    const scalar = eventOf(settledScalar);
    const pending = eventOf(notSettledYet);
    const yesChild = (settledA.markets ?? [])[0];
    const noChild = (settledA.markets ?? [])[1];
    const scalarChild = (scalar.markets ?? [])[0];
    const pendingChild = (pending.markets ?? [])[0];

    // Clone yesChild with a fresh ticker so the third clean child has a
    // distinct match key on the wampum side.
    const yesChild2 = { ...yesChild, ticker: `${yesChild.ticker}-CLONE` };

    const children = [yesChild, noChild, yesChild2, scalarChild, pendingChild];

    const kalshi: KalshiEvent = {
      ...settledA,
      markets: children,
    };

    const wampum: WampumEventForDecision = {
      id: `kalshi-${kalshi.event_ticker}`,
      closesAt: CLOSES_AT,
      markets: children.map((m) => ({ id: `kalshi-${m.ticker}`, ticker: m.ticker })),
    };

    const decision = decideEventCommit(wampum, kalshi, AFTER_DEADLINE);

    expect(decision.kind).toBe("commit");
    if (decision.kind !== "commit") return;
    expect(decision.perChild).toEqual([
      { marketId: `kalshi-${yesChild.ticker}`, outcome: "resolved_yes" },
      { marketId: `kalshi-${noChild.ticker}`, outcome: "resolved_no" },
      { marketId: `kalshi-${yesChild2.ticker}`, outcome: "resolved_yes" },
      { marketId: `kalshi-${scalarChild.ticker}`, outcome: "cancelled_scalar" },
      { marketId: `kalshi-${pendingChild.ticker}`, outcome: "cancelled_no_settlement" },
    ]);
  });

  it("degrades unsettled children to cancelled_no_settlement past the deadline alongside cleanly-settled siblings", () => {
    // Mixed payload: child A is settled with result=yes, child B is still active.
    const settledA = eventOf(settledAWins);
    const pending = eventOf(notSettledYet);
    const terminalChild = (settledA.markets ?? [])[0];
    const pendingChild = (pending.markets ?? [])[1];

    const kalshi: KalshiEvent = {
      ...settledA,
      markets: [terminalChild, pendingChild],
    };

    const wampum: WampumEventForDecision = {
      id: `kalshi-${kalshi.event_ticker}`,
      closesAt: CLOSES_AT,
      markets: [
        { id: `kalshi-${terminalChild.ticker}`, ticker: terminalChild.ticker },
        { id: `kalshi-${pendingChild.ticker}`, ticker: pendingChild.ticker },
      ],
    };

    const decision = decideEventCommit(wampum, kalshi, AFTER_DEADLINE);

    expect(decision.kind).toBe("commit");
    if (decision.kind !== "commit") return;
    expect(decision.perChild).toEqual([
      { marketId: `kalshi-${terminalChild.ticker}`, outcome: "resolved_yes" },
      { marketId: `kalshi-${pendingChild.ticker}`, outcome: "cancelled_no_settlement" },
    ]);
  });
});
