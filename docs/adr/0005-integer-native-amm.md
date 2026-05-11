# The AMM operates on integers end-to-end

The CPMM in `lib/amm.ts` operates on `bigint` inputs and outputs with no floating-point arithmetic in the trade path. Share counts, WPM amounts, `k`, and derived quantities (`swapOut`, new reserves) are all integers. Float appears only in display-layer price/probability outputs (`calculatePrices`, `calculateOdds`) and in a single one-shot conversion at seed time, where each Kalshi Market's float midpoint probability is used to split an integer `seedAmount * 2` into integer YES/NO reserves on its corresponding Wampum Market.

## Why not floats with `Math.round`

The prior implementation operated in JS `number` and rounded at DB insert. Every trade introduced up to ±0.5 units of rounding per field, compounding over a Market's lifetime into measurable drift between `wpmReserve` and `sum(outstandingShares)`. At **Resolution**, that drift was indistinguishable from a genuine AMM solvency shortfall: both manifested as "treasury covers the gap," with no way to tell noise from signal in the log. We would learn nothing from a `TreasuryBackstop` count of 47 — were those real skew events, or cumulative dust?

## Rounding direction: always toward the pool

Integer division truncates. If we compute `newTarget = k / newOther` by truncation, the post-trade product `newTarget * newOther` is *smaller* than `k`, leaking value to the trader. Accumulated across trades, this would make pool insolvency a matter of when, not if.

The discipline (borrowed from Uniswap V2): on every buy, round the side the trader receives *against* the trader and the side the pool retains *in favor of* the pool. Concretely, compute `newTarget = ceil(k / newOther)` on YES-buys (and symmetrically on NO-buys, though under ADR-0007 only YES-buys are user-exposed). The effective `k` only ever grows or stays the same; users may receive one integer unit less than the "real-valued fair" amount in edge cases and never more. This is a feature, not a bug — it is how integer CPMMs stay solvent.

## No sell path means no `isqrt`

Under ADR-0007 there is no sell. The previous integer-square-root machinery (`isqrt` via Newton's method, plus a "nudge `wpmReturned` down until the invariant holds" loop) existed solely to solve `(P - w) * (Q - w) = k` for the sell quantity `w`. That code is removed. The remaining trade path is `calculateBuy` (plus `initializePool` and the display-only `calculatePrices` / `calculateOdds`).

## Consequences

- Every caller of `lib/amm.ts` (`data/trading.ts`, `data/markets.ts` seeding) passes and receives `bigint`. No `Math.round` in the trade path.
- `TreasuryBackstop` at settlement becomes a high-signal event: if it fires, the AMM is genuinely under-collateralised for the YES outcome that resolved, not merely experiencing dust. This is the observable consequence of seeding a skewed `initialProbabilityYes` that turned out to be wrong — exactly the signal we want for tuning the ingestion confidence gate.
- Display prices (`priceYes`, `priceNo` in `[0, 1]`) remain floats. They are derived from integer reserves on read; they are never stored.
- The one-shot float-to-integer conversion at seed time is the only rounding event in a Market's lifetime. With sell removed, *every* state change after seeding is a buy, and every buy preserves integer-tight solvency by construction.
