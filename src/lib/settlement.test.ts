import { describe, expect, it } from "vitest";

import { computeSettlement, type SettlementPosition } from "./settlement";

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
