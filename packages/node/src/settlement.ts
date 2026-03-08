import { randomUUID } from "node:crypto";
import { sign } from "@wpm/shared";
import type { SettlePayoutTx, ResolveMarketTx, CancelMarketTx, SharePosition } from "@wpm/shared";
import type { ChainState } from "./state.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function signTx(tx: SettlePayoutTx, poaPrivateKey: string): SettlePayoutTx {
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, poaPrivateKey);
  return tx;
}

export function generateResolvePayouts(
  tx: ResolveMarketTx,
  state: ChainState,
  poaPublicKey: string,
  poaPrivateKey: string,
): SettlePayoutTx[] {
  const pool = state.pools.get(tx.marketId);
  if (!pool) return [];

  const userPayouts: SettlePayoutTx[] = [];
  let totalPaidOut = 0;

  // For each address holding winning shares, generate a payout of shares * 1.00
  for (const [address, byMarket] of state.sharePositions) {
    const byOutcome = byMarket.get(tx.marketId);
    if (!byOutcome) continue;

    const winningPosition: SharePosition | undefined = byOutcome.get(tx.winningOutcome);
    if (!winningPosition || winningPosition.shares <= 0) continue;

    const amount = round2(winningPosition.shares * 1.0);
    if (amount <= 0) continue;

    totalPaidOut += amount;

    userPayouts.push(
      signTx(
        {
          id: randomUUID(),
          type: "SettlePayout",
          timestamp: tx.timestamp,
          sender: poaPublicKey,
          marketId: tx.marketId,
          recipient: address,
          amount,
          payoutType: "winnings",
          signature: "",
        },
        poaPrivateKey,
      ),
    );
  }

  // Sort user payouts by recipient address ascending
  userPayouts.sort((a, b) => a.recipient.localeCompare(b.recipient));

  const payouts: SettlePayoutTx[] = [...userPayouts];

  // Treasury receives the remainder (conservation: sum(payouts) + treasury = wpmLocked)
  const treasuryReturn = round2(pool.wpmLocked - totalPaidOut);
  if (treasuryReturn > 0) {
    payouts.push(
      signTx(
        {
          id: randomUUID(),
          type: "SettlePayout",
          timestamp: tx.timestamp,
          sender: poaPublicKey,
          marketId: tx.marketId,
          recipient: poaPublicKey,
          amount: treasuryReturn,
          payoutType: "liquidity_return",
          signature: "",
        },
        poaPrivateKey,
      ),
    );
  }

  return payouts;
}

export function generateCancelPayouts(
  tx: CancelMarketTx,
  state: ChainState,
  poaPublicKey: string,
  poaPrivateKey: string,
): SettlePayoutTx[] {
  const pool = state.pools.get(tx.marketId);
  if (!pool) return [];

  const userRefunds: SettlePayoutTx[] = [];
  let totalUserRefunds = 0;

  // Refund each user their tracked costBasis (sum across both outcomes)
  for (const [address, byMarket] of state.sharePositions) {
    const byOutcome = byMarket.get(tx.marketId);
    if (!byOutcome) continue;

    let costBasis = 0;
    for (const [, position] of byOutcome) {
      costBasis += position.costBasis;
    }
    costBasis = round2(costBasis);
    if (costBasis <= 0) continue;

    totalUserRefunds += costBasis;

    userRefunds.push(
      signTx(
        {
          id: randomUUID(),
          type: "SettlePayout",
          timestamp: tx.timestamp,
          sender: poaPublicKey,
          marketId: tx.marketId,
          recipient: address,
          amount: costBasis,
          payoutType: "refund",
          signature: "",
        },
        poaPrivateKey,
      ),
    );
  }

  // Sort user refunds by recipient address ascending
  userRefunds.sort((a, b) => a.recipient.localeCompare(b.recipient));

  const payouts: SettlePayoutTx[] = [...userRefunds];

  // Treasury receives the remainder
  const treasuryReturn = round2(pool.wpmLocked - totalUserRefunds);
  if (treasuryReturn > 0) {
    payouts.push(
      signTx(
        {
          id: randomUUID(),
          type: "SettlePayout",
          timestamp: tx.timestamp,
          sender: poaPublicKey,
          marketId: tx.marketId,
          recipient: poaPublicKey,
          amount: treasuryReturn,
          payoutType: "liquidity_return",
          signature: "",
        },
        poaPrivateKey,
      ),
    );
  }

  return payouts;
}
