import { describe, expect, it } from "vitest";

import {
  computeEventSettlement,
  computeSettlement,
  type EventSettlementChildInput,
  type EventSettlementPosition,
  type SettlementPosition,
} from "./settlement";

function pos(
  userId: string,
  sharesA: bigint,
  sharesB: bigint,
  costBasis: bigint,
): SettlementPosition {
  return { userId, sharesA, sharesB, costBasis };
}

describe("computeSettlement – resolve", () => {
  it("pays winners exactly their winning share count", () => {
    const out = computeSettlement({
      kind: "resolve",
      outcome: "A",
      wpmReserve: 1000n,
      positions: [pos("alice", 200n, 0n, 150n), pos("bob", 0n, 300n, 300n)],
    });

    expect(out.payouts).toEqual([
      { userId: "alice", kind: "win", amount: 200n, shares: 200n },
      { userId: "bob", kind: "loss", amount: 0n, shares: 300n },
    ]);
    expect(out.totalPayouts).toBe(200n);
  });

  it("emits loss rows with amount 0 for holders who held only losing shares", () => {
    const out = computeSettlement({
      kind: "resolve",
      outcome: "B",
      wpmReserve: 500n,
      positions: [pos("alice", 100n, 0n, 100n)],
    });
    expect(out.payouts).toEqual([{ userId: "alice", kind: "loss", amount: 0n, shares: 100n }]);
  });

  it("skips holders with no outstanding shares", () => {
    const out = computeSettlement({
      kind: "resolve",
      outcome: "A",
      wpmReserve: 500n,
      positions: [pos("alice", 0n, 0n, 0n)],
    });
    expect(out.payouts).toEqual([]);
  });

  it("pays holders who hold shares on both sides the winning side only", () => {
    const out = computeSettlement({
      kind: "resolve",
      outcome: "A",
      wpmReserve: 500n,
      positions: [pos("alice", 100n, 50n, 200n)],
    });
    expect(out.payouts).toEqual([{ userId: "alice", kind: "win", amount: 100n, shares: 100n }]);
  });

  it("sweeps liquidity remainder to the treasury when wpmReserve exceeds payouts", () => {
    const out = computeSettlement({
      kind: "resolve",
      outcome: "A",
      wpmReserve: 1000n,
      positions: [pos("alice", 200n, 0n, 150n)],
    });
    expect(out.treasuryDelta).toBe(800n);
    expect(out.backstopAmount).toBe(0n);
  });

  it("draws from the treasury when total winning shares exceed wpmReserve", () => {
    const out = computeSettlement({
      kind: "resolve",
      outcome: "A",
      wpmReserve: 500n,
      positions: [pos("alice", 800n, 0n, 400n)],
    });
    expect(out.totalPayouts).toBe(800n);
    expect(out.treasuryDelta).toBe(-300n);
    expect(out.backstopAmount).toBe(300n);
  });

  it("has zero treasuryDelta and zero backstop when payouts == wpmReserve", () => {
    const out = computeSettlement({
      kind: "resolve",
      outcome: "A",
      wpmReserve: 500n,
      positions: [pos("alice", 500n, 0n, 250n)],
    });
    expect(out.treasuryDelta).toBe(0n);
    expect(out.backstopAmount).toBe(0n);
  });

  it("handles zero-position markets without emitting payouts", () => {
    const out = computeSettlement({
      kind: "resolve",
      outcome: "A",
      wpmReserve: 1000n,
      positions: [],
    });
    expect(out.payouts).toEqual([]);
    expect(out.treasuryDelta).toBe(1000n);
  });
});

describe("computeSettlement – cancel", () => {
  it("refunds costBasis to holders with outstanding shares", () => {
    const out = computeSettlement({
      kind: "cancel",
      wpmReserve: 1000n,
      positions: [pos("alice", 100n, 0n, 80n), pos("bob", 0n, 200n, 150n)],
    });
    expect(out.payouts).toEqual([
      { userId: "alice", kind: "refund", amount: 80n, shares: 100n },
      { userId: "bob", kind: "refund", amount: 150n, shares: 200n },
    ]);
    expect(out.totalPayouts).toBe(230n);
  });

  it("does not refund users who sold all their shares prior to cancel", () => {
    const out = computeSettlement({
      kind: "cancel",
      wpmReserve: 1000n,
      positions: [pos("alice", 0n, 0n, 50n)],
    });
    expect(out.payouts).toEqual([]);
  });

  it("emits a zero-amount row for holders with outstanding shares but zero costBasis", () => {
    const out = computeSettlement({
      kind: "cancel",
      wpmReserve: 500n,
      positions: [pos("alice", 100n, 0n, 0n)],
    });
    expect(out.payouts).toEqual([{ userId: "alice", kind: "zero", amount: 0n, shares: 100n }]);
  });

  it("sweeps remainder to the treasury when total refunds < wpmReserve", () => {
    const out = computeSettlement({
      kind: "cancel",
      wpmReserve: 1000n,
      positions: [pos("alice", 100n, 0n, 80n)],
    });
    expect(out.treasuryDelta).toBe(920n);
    expect(out.backstopAmount).toBe(0n);
  });
});

function epos(userId: string, shares: bigint, costBasis: bigint): EventSettlementPosition {
  return { userId, shares, costBasis };
}

function child(
  marketId: string,
  outcome: EventSettlementChildInput["outcome"],
  wpmReserve: bigint,
  positions: EventSettlementPosition[],
): EventSettlementChildInput {
  return { marketId, outcome, wpmReserve, positions };
}

describe("computeEventSettlement – per-child outcomes", () => {
  it("pays YES holders one WPM per share on resolved_yes", () => {
    const out = computeEventSettlement({
      perChild: [
        child("m-yes", "resolved_yes", 1000n, [epos("alice", 200n, 150n), epos("bob", 50n, 40n)]),
      ],
    });

    const [c] = out.perChild;
    expect(c.finalStatus).toBe("resolved");
    expect(c.resolvedAs).toBe("yes");
    expect(c.payouts).toEqual([
      { userId: "alice", kind: "win", amount: 200n, shares: 200n },
      { userId: "bob", kind: "win", amount: 50n, shares: 50n },
    ]);
    expect(c.totalPayouts).toBe(250n);
  });

  it("emits zero-amount loss rows for every YES holder on resolved_no", () => {
    const out = computeEventSettlement({
      perChild: [
        child("m-no", "resolved_no", 1000n, [epos("alice", 200n, 150n), epos("bob", 50n, 40n)]),
      ],
    });

    const [c] = out.perChild;
    expect(c.finalStatus).toBe("resolved");
    expect(c.resolvedAs).toBe("no");
    expect(c.payouts).toEqual([
      { userId: "alice", kind: "loss", amount: 0n, shares: 200n },
      { userId: "bob", kind: "loss", amount: 0n, shares: 50n },
    ]);
    expect(c.totalPayouts).toBe(0n);
  });

  it("refunds costBasis to YES holders on cancelled_* outcomes", () => {
    const cancelledOutcomes = [
      "cancelled_voided",
      "cancelled_scalar",
      "cancelled_no_settlement",
    ] as const;

    for (const outcome of cancelledOutcomes) {
      const out = computeEventSettlement({
        perChild: [
          child(`m-${outcome}`, outcome, 1000n, [epos("alice", 200n, 150n), epos("bob", 100n, 0n)]),
        ],
      });

      const [c] = out.perChild;
      expect(c.finalStatus).toBe("cancelled");
      expect(c.resolvedAs).toBeNull();
      expect(c.payouts).toEqual([
        { userId: "alice", kind: "refund", amount: 150n, shares: 200n },
        { userId: "bob", kind: "zero", amount: 0n, shares: 100n },
      ]);
      expect(c.totalPayouts).toBe(150n);
    }
  });

  it("fires the treasury backstop only on the under-collateralised child", () => {
    const out = computeEventSettlement({
      perChild: [
        // healthy: wpmReserve covers all winning payouts (200) with leftover
        child("m-healthy", "resolved_yes", 1000n, [epos("alice", 200n, 150n)]),
        // under-collateralised: 800 winning shares > 500 wpmReserve
        child("m-short", "resolved_yes", 500n, [epos("bob", 800n, 400n)]),
      ],
    });

    const [healthy, short] = out.perChild;
    expect(healthy.backstopAmount).toBe(0n);
    expect(healthy.treasuryDelta).toBe(800n);
    expect(short.backstopAmount).toBe(300n);
    expect(short.treasuryDelta).toBe(-300n);
  });
});
