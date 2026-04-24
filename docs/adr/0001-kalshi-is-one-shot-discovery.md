# Kalshi ingestion is one-shot discovery

Wampum ingests **Markets** from Kalshi by translating a binary-moneyline **Kalshi Event** into one Wampum **Market** exactly once — at creation time — and then never re-queries Kalshi for that **Market** again. The Wampum AMM is the sole source of price truth from t=0 onward; live Kalshi price movement does not update our rows, and our AMM is free to diverge from Kalshi arbitrarily.

## Why

The alternative (keeping Kalshi snapshot fields fresh via periodic refresh) creates a second price authority alongside the AMM and invites ambiguity in every downstream consumer ("which number do I show?"). We chose Kalshi as a *seeding* oracle, not a *tracking* oracle: we use its bid/ask midpoint to initialize the AMM with a reasonable real-world prior, and after that the market is a purely internal Wampum entity.

## Consequences

- The `markets` table stores no live-Kalshi state. The ten snapshot columns (`yesBidCentsA`/`B`, `yesAskCentsA`/`B`, `noBidCentsA`/`B`, `noAskCentsA`/`B`, `volume24hA`, `volume24hB`) were added under the old reading and are being dropped in the ingestion refactor.
- A **Kalshi Event** with a zero-spread (no usable initial price) cannot be ingested at all — there's no "pick it up later when prices arrive" because we don't refresh. The translator rejects these with a `no_initial_price` skip reason; the next cron run re-evaluates them with fresh Kalshi data. This makes cron cadence load-bearing: it must be frequent enough that an event is unlikely to stay zero-spread from Kalshi-open until Wampum-close.
- The `createMarket` function takes no Kalshi-specific inputs. The translator is the only place Kalshi's wire format touches Wampum code.
