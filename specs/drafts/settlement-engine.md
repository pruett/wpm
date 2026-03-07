# Settlement Engine — Component Specification

## Overview

The settlement engine is built into the blockchain node, not a standalone service. It is triggered when a `ResolveMarket` or `CancelMarket` transaction is processed. Its job is to compute payouts, generate `SettlePayout` transactions, and return treasury liquidity.

## Trigger Conditions

### Resolution (ResolveMarket)

When the node processes a valid `ResolveMarket` transaction:

1. Read the market's winning outcome (`A` or `B`)
2. Look up all share positions for this market across all users
3. Compute payouts for winning share holders
4. Return remaining pool liquidity to treasury
5. Generate `SettlePayout` transactions for all payouts

### Cancellation (CancelMarket)

When the node processes a valid `CancelMarket` transaction:

1. Look up all share positions for this market across all users
2. Compute refund amounts based on each user's cost basis
3. Return all pool liquidity to treasury
4. Generate `SettlePayout` transactions with `payoutType: "refund"`

## Payout Logic — Resolution

### Step 1: Identify Winners

All users holding shares of the winning outcome are winners. Each winning share pays out exactly **1.00 WPM**.

Losing shares pay out **0.00 WPM**.

### Step 2: Calculate User Payouts

```
For each user with winning shares:
  payout = user.shares[winningOutcome] * 1.00
```

### Step 3: Treasury Liquidity Return

The treasury seeded the market with initial liquidity. After paying all winners, any remaining value in the pool returns to treasury.

```
totalWinningShares = sum of all winning shares held by users + winning shares still in pool
totalLosingShares = sum of all losing shares held by users + losing shares still in pool

// Pool shares that treasury still holds (not traded away)
treasuryWinningShares = pool.shares[winningOutcome]
treasuryLosingShares = pool.shares[losingOutcome]

// Treasury payout = its winning shares * 1.00
treasuryReturn = treasuryWinningShares * 1.00
```

### Step 4: Generate SettlePayout Transactions

One `SettlePayout` transaction per recipient:

```typescript
{
  type: "SettlePayout",
  marketId: market.marketId,
  recipient: userAddress,       // or treasury address
  amount: payoutAmount,
  payoutType: "winnings"        // or "liquidity_return" for treasury
}
```

All `SettlePayout` transactions are added to the same block as the `ResolveMarket` transaction.

## Payout Logic — Cancellation

When a market is cancelled, all users should be made whole.

### Refund Calculation

Each user's refund equals the WPM they spent buying shares, minus any WPM they received from selling shares. The simplest approach:

```
For each user who holds shares in this market:
  // Calculate current value of their shares at the AMM's current price
  refundA = user.shares.A * currentPriceA
  refundB = user.shares.B * currentPriceB
  totalRefund = refundA + refundB
```

This is an approximation — users may have bought at different prices. But for a cancellation (rare event), returning value at current pool prices is fair and simple.

### Treasury Reclamation

After all user refunds, remaining pool value returns to treasury.

## Edge Cases

### Zero Bets

No users hold shares. Treasury reclaims the full seed amount. One `SettlePayout` transaction with `payoutType: "liquidity_return"`.

### All Bets on One Side

All users bet on outcome A, outcome A wins.

- All users hold A shares, which each pay 1.00 WPM
- Users paid less than 1.00 per share (they bought before the price reached 1.00) → they profit
- The pool holds mostly B shares (worthless) and few A shares
- Treasury's LP position loses value, but this loss is bounded and offset by the 1% fees collected

This is the expected worst case for treasury. The system remains solvent because winning shares always pay 1.00 and the total payout is funded by the WPM that entered the pool through trading.

### Tie / No Contest / Postponement

The oracle submits a `CancelMarket` transaction instead of `ResolveMarket`. All bets are refunded per the cancellation logic above.

### User Has Shares From Both Sides

A user might hold both A and B shares (from separate trades). They receive payout only for their winning shares. Losing shares pay 0.

## Solvency Guarantee

The constant product AMM guarantees that the pool always has enough WPM to cover payouts:

- Every share in existence was funded by WPM entering the pool
- The total WPM in the system equals total WPM that entered the pool via trades + seed amount
- Winning shares pay 1.00 each, and the total winning shares outstanding can never exceed the total WPM in the pool
- The 1% fee adds a buffer beyond exact solvency

No external funding or treasury bailout is ever needed.

## Verification Criteria

1. **Winning share holders** receive exactly `shares * 1.00 WPM`
2. **Losing share holders** receive 0
3. **Treasury** reclaims its remaining LP position
4. **Cancelled markets** refund all users at current pool prices
5. **Zero-bet markets** return full seed to treasury
6. **Solvency** — total payouts never exceed total WPM in the pool + seed
7. **All SettlePayout transactions** are generated in the same block as the triggering ResolveMarket/CancelMarket
8. **Market status** transitions correctly: `open → resolved` or `open → cancelled`
