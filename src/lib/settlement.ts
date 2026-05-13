export type PayoutKind = "win" | "loss" | "refund" | "zero";

export type PayoutIntent = {
  userId: string;
  kind: PayoutKind;
  amount: bigint;
  shares: bigint;
};

// Event-atomic, YES-only settlement (multi-outcome model). Takes a commit plan
// covering every child Market in an Event along with each child's pool reserve
// + flat YES position list, and returns one payout/treasury/status bundle per
// child. `commitEvent` in `data/events.ts` applies this batch in a single DB
// tx so the whole Event commits or none of it does.
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
