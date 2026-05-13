import { describe, expect, it } from "vitest";

import {
  computeEventSettlement,
  type EventSettlementChildInput,
  type EventSettlementPosition,
} from "./settlement";

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

  it("settles a 5-child Event with 10 holders distributed across children", () => {
    // 10 holders, each holding a position on a subset of 5 children. Each
    // (holder, child) pair has a deterministic share/costBasis derived from
    // its index, so the test can assert exact per-child totals.
    const HOLDERS = Array.from({ length: 10 }, (_, i) => `u-${i}`);
    const CHILDREN = Array.from({ length: 5 }, (_, i) => `m-${i}`);

    // holder i participates on child c when (i + c) % 2 === 0 — yields a
    // mix of 2-or-3-holder children and 2-or-3-child holders.
    const participates = (holderIdx: number, childIdx: number) => (holderIdx + childIdx) % 2 === 0;
    const sharesFor = (holderIdx: number, childIdx: number) =>
      BigInt(100 * (holderIdx + 1) + 10 * (childIdx + 1));
    const costBasisFor = (holderIdx: number, childIdx: number) =>
      sharesFor(holderIdx, childIdx) / 2n;

    const perChildInput = CHILDREN.map((marketId, childIdx) => {
      const positions = HOLDERS.flatMap((userId, holderIdx) =>
        participates(holderIdx, childIdx)
          ? [epos(userId, sharesFor(holderIdx, childIdx), costBasisFor(holderIdx, childIdx))]
          : [],
      );
      // Generous wpmReserve so no child triggers a backstop.
      return child(marketId, "resolved_yes", 1_000_000n, positions);
    });

    const out = computeEventSettlement({ perChild: perChildInput });

    expect(out.perChild).toHaveLength(5);

    // Every child resolved cleanly on YES.
    for (const c of out.perChild) {
      expect(c.finalStatus).toBe("resolved");
      expect(c.resolvedAs).toBe("yes");
      expect(c.backstopAmount).toBe(0n);
    }

    // Exactly one payout per (holder, child-with-position).
    let expectedPayoutCount = 0;
    for (let childIdx = 0; childIdx < CHILDREN.length; childIdx++) {
      const expectedChildPositions = HOLDERS.filter((_, holderIdx) =>
        participates(holderIdx, childIdx),
      );
      const childOut = out.perChild[childIdx];
      expect(childOut.payouts).toHaveLength(expectedChildPositions.length);
      expectedPayoutCount += expectedChildPositions.length;

      // Per-child total = sum of winning shares.
      const expectedTotal = expectedChildPositions.reduce(
        (s, _userId, k) =>
          s +
          sharesFor(
            HOLDERS.findIndex((h) => h === expectedChildPositions[k]),
            childIdx,
          ),
        0n,
      );
      expect(childOut.totalPayouts).toBe(expectedTotal);
      expect(childOut.treasuryDelta).toBe(1_000_000n - expectedTotal);

      // Every payout credits the holder `amount = shares` (resolved_yes).
      for (const payout of childOut.payouts) {
        expect(payout.kind).toBe("win");
        expect(payout.amount).toBe(payout.shares);
      }
    }

    const flatPayouts = out.perChild.flatMap((c) => c.payouts);
    expect(flatPayouts).toHaveLength(expectedPayoutCount);
  });
});
