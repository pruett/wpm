# Positions are an immutable ledger

The `positions` table records what a user holds or held **in relation to a given Market** — and under ADR-0006 every Market is a single binary YES/NO contract, so a position is just (user, market) → YES-shares + cost basis. Rows are written by `placeBet`, but are **never mutated by Resolution or Cancellation** — the terminal state of a Market is signalled by `markets.status`, not by zeroing out position rows. With ADR-0007 retiring the sell path, the ledger is also strictly append-only on the cost-basis dimension: `shares` and `costBasis` only grow until the parent Event terminally commits.

## Division of responsibility

- **`positions`** — what a user holds or held in relation to a given Market. Scoped per `(userId, marketId)`. A single `shares` column (YES-shares) and a monotonic `costBasis`.
- **`markets.status`** — whether the position has been settled (`resolved` / `cancelled`) or is currently live (`open`). `events.status` (`open | terminal`) gives the same answer at Event granularity (every child terminal ↔ Event terminal — see ADR-0008).
- **`transactions`** — what was paid: `PlaceBet`, `SettlePayout`, `CancelMarket`, etc. No `SellShares` under ADR-0007.

The three tables have non-overlapping roles. A consumer asking "what does this user currently hold?" filters positions by `markets.status = 'open'`. A consumer asking "what was paid out?" reads transactions. A consumer asking "what did the user hold at settlement?" reads positions directly — the row still carries the `shares` and `costBasis` values frozen at the user's last buy.

## Why not zero on resolve/cancel

A prior `cancelMarket` implementation zeroed `sharesA`, `sharesB`, and `costBasis` after refunding. That denormalised `markets.status` into the position row (two sources of truth for liveness) and destroyed history — most importantly `costBasis`, which the old design couldn't losslessly reconstruct from the transaction log because of partial sells.

`resolveMarket` already *didn't* zero, creating an asymmetry: on resolve, losers kept their row intact; on cancel, everyone lost theirs. Queries that read positions without joining on `markets.status` gave different answers for resolved vs cancelled markets of otherwise identical shape. The ledger model resolves both issues.

Under ADR-0007 (no sell), `costBasis` is now trivially reconstructable from `transactions` as `sum(PlaceBet payloads for this user × this market)` — but the ledger property still matters for read-side ergonomics, and zeroing rows on terminal state would re-introduce the asymmetry above.

## Consequences

- Every query that treats "non-zero shares" as a synonym for "live position" must filter on `markets.status = 'open'` (or `events.status = 'open'`).
- `cancelMarket` does not mutate position rows. It credits refunds (= `costBasis` under ADR-0007), writes `SettlePayout` transactions, and flips `markets.status` (and, if the cancellation is part of an Event-commit, `events.status` — see ADR-0008).
- The `costBasis` on a resolved or cancelled Market is a historical fact, not a claim on future payout. Payouts are evidenced solely by `SettlePayout` rows in `transactions` and by balance credits.
- Under ADR-0008's Event-synchronized commit, a user with positions across multiple child Markets of an Event sees all those positions transition status in the same DB transaction. Their per-Market position rows preserve the pre-commit `shares`/`costBasis`; the commit only flips `markets.status` and writes payout rows.
