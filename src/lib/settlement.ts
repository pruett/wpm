export type SettlementPosition = {
  userId: string;
  sharesA: bigint;
  sharesB: bigint;
  costBasis: bigint;
};

export type SettlementInput =
  | {
      kind: "resolve";
      outcome: "A" | "B";
      wpmReserve: bigint;
      positions: SettlementPosition[];
    }
  | {
      kind: "cancel";
      wpmReserve: bigint;
      positions: SettlementPosition[];
    };

export type PayoutKind = "win" | "loss" | "refund" | "zero";

export type PayoutIntent = {
  userId: string;
  kind: PayoutKind;
  amount: bigint;
  shares: bigint;
};

export type SettlementOutput = {
  payouts: PayoutIntent[];
  totalPayouts: bigint;
  treasuryDelta: bigint;
  backstopAmount: bigint;
};

export function computeSettlement(input: SettlementInput): SettlementOutput {
  const payouts: PayoutIntent[] = [];
  let totalPayouts = 0n;

  for (const p of input.positions) {
    const hasShares = p.sharesA > 0n || p.sharesB > 0n;
    if (!hasShares) continue;

    if (input.kind === "resolve") {
      const winningShares = input.outcome === "A" ? p.sharesA : p.sharesB;
      if (winningShares > 0n) {
        payouts.push({
          userId: p.userId,
          kind: "win",
          amount: winningShares,
          shares: winningShares,
        });
        totalPayouts += winningShares;
      } else {
        payouts.push({
          userId: p.userId,
          kind: "loss",
          amount: 0n,
          shares: p.sharesA + p.sharesB,
        });
      }
    } else {
      const shares = p.sharesA + p.sharesB;
      if (p.costBasis > 0n) {
        payouts.push({
          userId: p.userId,
          kind: "refund",
          amount: p.costBasis,
          shares,
        });
        totalPayouts += p.costBasis;
      } else {
        payouts.push({
          userId: p.userId,
          kind: "zero",
          amount: 0n,
          shares,
        });
      }
    }
  }

  const treasuryDelta = input.wpmReserve - totalPayouts;
  const backstopAmount = treasuryDelta < 0n ? -treasuryDelta : 0n;

  return { payouts, totalPayouts, treasuryDelta, backstopAmount };
}

// ─── Event-level settlement (multi-outcome model) ──────────────────────────
//
// `computeEventSettlement` is the YES-only, event-atomic replacement for the
// legacy per-child `computeSettlement` above. It takes a commit plan covering
// every child Market in an Event along with each child's pool reserve + flat
// YES position list, and returns one payout/treasury/status bundle per child.
// `commitEvent` in `data/events.ts` applies this batch in a single DB tx so
// the whole Event commits or none of it does.
//
// Per-child outcome mapping:
//   resolved_yes  → YES holders get `amount = shares`; (no NO holders exist)
//   resolved_no   → emit `loss` rows with `amount = 0` for every holder
//   cancelled_*   → refund `costBasis` per holder (zero-row if costBasis = 0)

export type ChildSettlementOutcome =
  | "resolved_yes"
  | "resolved_no"
  | "cancelled_voided"
  | "cancelled_scalar"
  | "cancelled_no_settlement";

export type EventSettlementPosition = {
  userId: string;
  shares: bigint;
  costBasis: bigint;
};

export type EventSettlementChildInput = {
  marketId: string;
  outcome: ChildSettlementOutcome;
  wpmReserve: bigint;
  positions: EventSettlementPosition[];
};

export type EventSettlementInput = {
  perChild: EventSettlementChildInput[];
};

export type EventSettlementChildOutput = {
  marketId: string;
  outcome: ChildSettlementOutcome;
  payouts: PayoutIntent[];
  totalPayouts: bigint;
  treasuryDelta: bigint;
  backstopAmount: bigint;
  finalStatus: "resolved" | "cancelled";
  resolvedAs: "yes" | "no" | null;
};

export type EventSettlementOutput = {
  perChild: EventSettlementChildOutput[];
};

export function computeEventSettlement(input: EventSettlementInput): EventSettlementOutput {
  const perChild = input.perChild.map(settleChild);
  return { perChild };
}

function settleChild(child: EventSettlementChildInput): EventSettlementChildOutput {
  const payouts: PayoutIntent[] = [];
  let totalPayouts = 0n;

  const isResolveYes = child.outcome === "resolved_yes";
  const isResolveNo = child.outcome === "resolved_no";
  const isCancel = !isResolveYes && !isResolveNo;

  for (const p of child.positions) {
    if (p.shares <= 0n) continue;

    if (isResolveYes) {
      payouts.push({
        userId: p.userId,
        kind: "win",
        amount: p.shares,
        shares: p.shares,
      });
      totalPayouts += p.shares;
    } else if (isResolveNo) {
      payouts.push({ userId: p.userId, kind: "loss", amount: 0n, shares: p.shares });
    } else if (isCancel) {
      if (p.costBasis > 0n) {
        payouts.push({
          userId: p.userId,
          kind: "refund",
          amount: p.costBasis,
          shares: p.shares,
        });
        totalPayouts += p.costBasis;
      } else {
        payouts.push({ userId: p.userId, kind: "zero", amount: 0n, shares: p.shares });
      }
    }
  }

  const treasuryDelta = child.wpmReserve - totalPayouts;
  const backstopAmount = treasuryDelta < 0n ? -treasuryDelta : 0n;

  return {
    marketId: child.marketId,
    outcome: child.outcome,
    payouts,
    totalPayouts,
    treasuryDelta,
    backstopAmount,
    finalStatus: isCancel ? "cancelled" : "resolved",
    resolvedAs: isResolveYes ? "yes" : isResolveNo ? "no" : null,
  };
}
