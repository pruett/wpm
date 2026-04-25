# Positions are an immutable ledger

The `positions` table records what a user holds or held **in relation to a given market**. Rows are written by `placeBet` and decremented by `sellShares`, but are **never mutated by Resolution or Cancellation** — the terminal state of a **Market** is signalled by `markets.status`, not by zeroing out position rows.

## Division of responsibility

- **`positions`** — what a user holds or held in relation to a given market. Scoped per `(userId, marketId)`.
- **`markets.status`** — whether that position has been settled (`resolved` / `cancelled`) or is currently live/ongoing (`open`).
- **`transactions`** — what was paid: `PlaceBet`, `SellShares`, `SettlePayout`, `CancelMarket`, etc.

The three tables have non-overlapping roles. A consumer asking "what does this user currently hold?" filters positions by `markets.status = 'open'`. A consumer asking "what was paid out?" reads transactions. A consumer asking "what did the user hold at settlement?" reads positions directly — the row still carries the `sharesA`, `sharesB`, and `costBasis` values frozen at the last trade.

## Why not zero on resolve/cancel

The prior `cancelMarket` implementation zeroed `sharesA`, `sharesB`, and `costBasis` after refunding. That denormalised `markets.status` into the position row (two sources of truth for liveness) and destroyed history — most importantly `costBasis`, which cannot be losslessly reconstructed from the `transactions` log across partial sells.

`resolveMarket` already *didn't* zero, creating an asymmetry: on resolve, losers kept their row intact; on cancel, everyone lost theirs. Queries that read positions without joining on `markets.status` (e.g. `getMarket`'s `bettorCount`) gave different answers for resolved vs cancelled markets of otherwise identical shape. The ledger model resolves both issues.

## Consequences

- Every query that treats "non-zero shares" as a synonym for "live position" is now wrong and must filter on `markets.status = 'open'` (or join accordingly). `getMarket`'s `bettorCount` is the first known offender.
- `cancelMarket` stops mutating position rows. It still credits refunds, writes `SettlePayout` transactions, and flips `markets.status`.
- The `costBasis` on a resolved or cancelled market is a historical fact, not a claim on future payout. Payouts are evidenced solely by `SettlePayout` rows in `transactions` and by balance credits.
