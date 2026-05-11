# Buy-YES-only trading; no sell, no NO-side

Under the grouped-binaries model (ADR-0006), every Wampum **Market** is a single binary YES/NO contract. We expose exactly one trade type to users: **buy YES-shares of a chosen Market**. No sell-back to the pool, no NO-side buys. To bet against an outcome, the user buys YES on a sibling Market (e.g., to bet against the Lakers, buy YES on `Celtics-WIN`). This is a deliberate product stance baked into the architecture, not a v1 simplification.

## Why

- **Cost basis becomes monotonic.** With no sell path, `positions.costBasis` only ever grows — it is exactly `sum(WPM spent acquiring shares of this Market)`. The partial-seller refund complication flagged in ADR-0002 disappears entirely: on **Cancellation**, refund = `costBasis` = full money in. No nuance.
- **The AMM trade path shrinks.** `calculateSell`, `isqrt`, and the Newton's-method nudge loop that kept `(P - w) * (Q - w) >= k` after integer-square-root truncation (ADR-0005) are all removed. The AMM is reduced to `initializePool`, `calculateBuy`, and `calculatePrices` — ~30 lines instead of ~100. Less code, fewer rounding-direction decisions, fewer test cases.
- **One UI primitive per Market.** Every Market has exactly one user-facing action: a YES-buy button. Sports and multi-outcome Events render identically — a list of N Markets, each with one button. No asymmetric "buy A vs. buy B vs. sell A vs. sell B" quadrant.
- **NO-side is redundant under grouped-binaries.** Pre-ADR-0006, "bet against A" had no Market to point at except B-side of the same pool — that's what A-shares-vs-B-shares meant. Under ADR-0006 each sibling Market *is* an independent "against" bet, so a separate NO-side on the same Market would just duplicate what the sibling Market already does.

## Considered options

- **YES+NO buys with sell (the standard prediction-market shape).** Rejected: maximum expressiveness, maximum surface area. Every Market gets four buttons (buy YES, buy NO, sell YES-shares, sell NO-shares), positions track two share counts plus cost basis adjustments on sell, the AMM keeps its sell math. Worth it for a real money exchange; overkill at play-money learning-project scale.
- **YES+NO buys, no sell.** Rejected: under ADR-0006 the NO-side is already represented by the sibling Market(s). A user wanting "Celtics-NO" should buy "Lakers-YES" instead. Exposing NO-buys would create two paths to the same economic position with two different pools and confuse new users.
- **YES-only buys with sell.** Rejected: sell preserves user-exit capability but reintroduces every complication this ADR is trying to remove — partial-seller refunds, `calculateSell` math, `isqrt` rounding, cost-basis-net-of-sells.
- **YES-only, no sell** (chosen).

## Consequences

- `transactions.type` enum drops `SellShares`. No new code writes it. (Old transaction rows from before the schema reset don't exist post-wipe — see ADR-0006 — so the value can be dropped from the enum cleanly.)
- `lib/amm.ts` loses `calculateSell` and `isqrt`. The integer-rounding discipline of ADR-0005 still applies, but only on the buy path.
- `positions` collapses from `(sharesA, sharesB, costBasis)` to `(shares, costBasis)`. Only YES-shares are user-held; NO-side reserves live in the pool but are never owned by users.
- `placeBet` server action signature drops the outcome parameter — it's always YES on the specified Market.
- Cancellation refunds become trivial: `refund = costBasis` for any holder with `shares > 0`. No partial-seller branch.
- Users have **no exit before resolution**. A user who bets and changes their mind is committed until the Market resolves or cancels. This is the central cost of the decision and is accepted: a play-money platform where exits are not promised is acceptable; the simplification gained downstream is not.
- The "sum-to-1 across sibling Markets" arbitrage drift discussed in ADR-0006 is less efficient than it would be with sell, because the only convergence force is new buyers picking the under-priced side. Drift on small pools is more visible than it would be with sell+buy arbitrage. Accepted as a structural property at this scale.
