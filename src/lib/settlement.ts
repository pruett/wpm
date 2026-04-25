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
