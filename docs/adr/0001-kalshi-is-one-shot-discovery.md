# Kalshi ingestion is one-shot discovery

Wampum ingests a **Kalshi Event** by translating it into one **Wampum Event** plus N child **Markets** (one per nested Kalshi Market) exactly once — at creation time — and then never re-queries Kalshi for that Event's pricing again. Each child Market's AMM is the sole source of price truth from t=0 onward; live Kalshi price movement does not update our rows, and our AMM is free to diverge from Kalshi arbitrarily. The ingest is atomic at the Event level: either all child Markets are created together, or the entire Event is rejected and re-evaluated on the next cron tick (see ADR-0006).

## Why

The alternative (keeping Kalshi snapshot fields fresh via periodic refresh) creates a second price authority alongside each Market's AMM and invites ambiguity in every downstream consumer ("which number do I show?"). We chose Kalshi as a *seeding* oracle, not a *tracking* oracle: we use each nested Kalshi Market's bid/ask midpoint to initialize its corresponding Wampum Market's AMM with a reasonable real-world prior, and after that each Market is a purely internal Wampum entity.

## Consequences

- The `markets` table stores no live-Kalshi state. Live snapshot columns (bids, asks, 24h volumes) are not part of the schema. Each Market's `seedAmount` and the **Initial Probability** baked into its pool reserves are the only Kalshi-derived state, frozen at creation.
- A **Kalshi Event** with *any* nested Kalshi Market failing the per-Market confidence gate (e.g., zero-spread, missing quote) cannot be ingested at all — there's no "pick up the missing children later when prices arrive" because we don't refresh. The translator rejects the whole Event; the next cron tick re-evaluates with fresh Kalshi data. This makes cron cadence load-bearing: it must be frequent enough that an Event is unlikely to stay partially-quoted from Kalshi-open until Wampum-close.
- The `createEvent` / `createMarket` functions take no Kalshi-specific inputs. The translator is the only place Kalshi's wire format touches Wampum code.
- "Kalshi is consulted exactly once per Event for pricing" — followed by "exactly once at resolution for per-child outcomes" (ADR-0002 / ADR-0008). Two reads total per Event, regardless of N.
