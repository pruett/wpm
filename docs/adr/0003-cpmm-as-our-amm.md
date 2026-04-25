# CPMM (Uniswap-style) as our AMM algorithm

"AMM" in the codebase (`src/lib/amm.ts`, `AMMPool`, the `ammPools` table) is the umbrella term. The *specific* algorithm we implement is a **constant-product market maker** (CPMM): `sharesA * sharesB = k`, preserved on every trade. This is the same family Polymarket uses. We are not building a Kalshi-style order book, and we are not using LMSR.

## Why CPMM fits this codebase

- **One function does pricing, buys, and sells.** No order matching, no bid/ask spread, no market-maker queue. A trade is a closed-form swap against two reserves — ~20 lines in `amm.ts`.
- **The pool is self-contained.** Worst-case payout is bounded by `wpmReserve`; there's no external liability the house has to cap. Compare LMSR, where the maker's loss is bounded by a parameter `b` that has to be chosen and tuned per market — another knob we don't want.
- **No counterparties to coordinate.** Users trade against the pool, not each other. An order book only pays off with enough concurrent traders to fill both sides; at our scale that would leave most **Markets** with no quote.

## What we're giving up (and are fine with)

- **Slippage on thin pools.** CPMM moves price with every trade proportional to `tradeSize / liquidity`. Our 1000 WPM **Seed** is small, so early trades will move the price noticeably. Acceptable — this is a play-money app, not capital markets.
- **No limit orders.** CPMM only supports market orders. Not a product requirement.
- **Fixed liquidity curve.** We don't let users add/remove liquidity (no LPs). The **Seed** is the entire pool for the **Market**'s lifetime. Simpler accounting, no LP token bookkeeping.

## Naming

Keep the code and prose saying "AMM" — that's the umbrella concept and matches the file/table names. Reach for "CPMM" or "constant-product" only when the specific algorithm matters (pricing math, slippage reasoning, comparisons like this one).
