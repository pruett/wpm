# CPMM (Uniswap-style) as our AMM algorithm

"AMM" in the codebase (`src/lib/amm.ts`, `AMMPool`, the `ammPools` table) is the umbrella term. The *specific* algorithm we implement is a **constant-product market maker** (CPMM): `sharesYes * sharesNo = k`, preserved on every buy. Each Wampum **Market** (one binary YES/NO contract under ADR-0006) has its own CPMM pool. Polymarket uses the same family. We are not building a Kalshi-style order book, and we are not using LMSR.

## Why CPMM fits this codebase

- **One function does pricing and buys.** No order matching, no bid/ask spread, no market-maker queue, no sell (see ADR-0007) — a trade is a closed-form swap against two reserves, ~15 lines in `amm.ts`.
- **The pool is self-contained.** Worst-case payout for the Market is bounded by its `wpmReserve`; there's no external liability the house has to cap. Compare LMSR, where the maker's loss is bounded by a parameter `b` that has to be chosen and tuned per Market — another knob we don't want, especially under ADR-0006 where each Event creates N pools that would each need tuning.
- **No counterparties to coordinate.** Users trade against the pool, not each other. An order book only pays off with enough concurrent traders to fill both sides; at our scale that would leave most Markets with no quote.
- **CPMM extends trivially to grouped-binaries.** Under ADR-0006, every Wampum Market is one binary YES/NO contract regardless of whether its parent Event is a 2-Market sports game or a 30-Market golf field. CPMM serves every Market identically — a multi-outcome AMM (LMSR or multi-asset CPMM) would only be needed if we represented multi-outcome events as a single Market with N outcomes, which we don't.

## What we're giving up (and are fine with)

- **Slippage on thin pools.** CPMM moves price with every trade proportional to `tradeSize / liquidity`. Our 1000 WPM **Seed** is small, so early trades will move the price noticeably. Acceptable — this is a play-money app, not capital markets.
- **No limit orders.** CPMM only supports market orders. Not a product requirement.
- **Fixed liquidity curve.** We don't let users add/remove liquidity (no LPs). The **Seed** is the entire pool for the Market's lifetime. Simpler accounting, no LP token bookkeeping.
- **No AMM-enforced sum-to-1 across siblings.** Within a single Market, `priceYes + priceNo = 1` is enforced by the constant-product invariant. *Across* the N sibling Markets of an Event, the YES-prices can sum to anything — convergence depends on new-buyer arbitrage (see ADR-0006). Accepted as the structural cost of mirroring Kalshi.

## Naming

Keep the code and prose saying "AMM" — that's the umbrella concept and matches the file/table names. Reach for "CPMM" or "constant-product" only when the specific algorithm matters (pricing math, slippage reasoning, comparisons like this one).
