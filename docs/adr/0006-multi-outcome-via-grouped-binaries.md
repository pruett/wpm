# Multi-outcome events via grouped binary markets

Wampum represents a multi-outcome real-world contest as one **Wampum Event** holding N independent binary **Markets** — each its own YES/NO contract with its own CPMM pool — rather than as a single Market with N outcomes priced by a multi-outcome AMM. This mirrors Kalshi's data shape 1:1 and applies uniformly to *all* events, including formerly-binary sports: a basketball game is now one Event with two Markets (`Lakers-WIN`, `Celtics-WIN`), not one Market with two outcomes `A`/`B`.

## Why

The alternative — one Wampum Market with N outcomes, priced by LMSR or a multi-asset CPMM — would let the AMM enforce `sum(probabilities) = 1` across outcomes by construction, which is mathematically attractive. We chose grouped-binaries anyway because:

- **Kalshi already gives us N independent YES/NO contracts.** A Grammy event is one Kalshi Event with N nested Kalshi Markets, each a separate `yes`/`no` contract that settles on its own `result`. Fusing them into a single Wampum entity means fighting the source format and re-projecting it on every read. Mirroring it means the translator is a straight map.
- **CPMM survives unchanged.** ADR-0003 chose CPMM specifically for "one function does pricing, buys, and sells, ~20 lines." A multi-outcome AMM (LMSR most prominently) introduces a tunable parameter `b` per market — the exact knob ADR-0003 rejected — and accumulates slippage across N reserves in ways the integer-rounding discipline of ADR-0005 doesn't extend to cleanly.
- **One code path for all event types.** Sports and multi-outcome contests share the same domain model, same pricing math, same resolution flow, same UI primitives. The unified shape is the simplification.
- **Settlement is naturally per-Market.** Each Kalshi Market settles independently; Wampum mirrors that. A Market resolves on its own underlying Kalshi `result` — Resolution doesn't have to reason about a multi-outcome winner-takes-all event as an atomic object. (Event-level synchronization of *commit timing* is a separate concern — see ADR-0008.)

## Considered options

- **One Market with N outcomes, LMSR-priced.** Rejected: re-introduces a tunable parameter, doesn't mirror Kalshi, requires a second pricing implementation alongside CPMM for the legacy A/B case (or a wholesale rewrite). The enforced sum-to-1 invariant is not worth the architectural cost at play-money scale.
- **B-mixed: keep binary sports as 1-Market-with-A/B, add a separate "group of N binaries" model for multi-outcome only.** Rejected: two domain shapes coexist forever; every consumer (cost basis, position display, settlement, UI) has to handle both; the vocabulary forks ("Outcome" means an A/B slot in one shape and means "the whole binary Market" in the other). Defeats the unification.
- **Status quo (binary only, reject multi-outcome at the translator).** Rejected: the platform exists to ingest prediction markets, and a large fraction of interesting prediction markets are not binary. Continuing to reject them caps the product.

## Consequences

- **A new `events` table** owns Event-level state (`id`, `sport`, `name`, `closesAt`, `status`, `createdAt`). `markets` carries an `eventId` FK and represents one binary YES/NO contract.
- **The A/B model is retired end-to-end.** `markets.teamA/B`, `markets.tickerA/B`, `markets.resolvedOutcome ('A'|'B')`, `ammPools.reserveA/B`, `positions.sharesA/B` all disappear. They are replaced by per-Market `name`, `ticker`, `resolvedAs ('yes'|'no'|null)`, `reserveYes/No`, and a single `shares` column on positions (see ADR-0007 for why one `shares` column is sufficient).
- **The AMM-enforced sum-to-1 invariant is lost** *across* sibling Markets of an Event — each Market is its own pool with its own price. Within a single binary Market, `priceYes + priceNo = 1` still holds by construction. Drift between siblings (e.g., `Lakers-WIN` priced at 0.55 and `Celtics-WIN` at 0.50, summing to 1.05) is normal and converges only via new-buyer arbitrage. This is accepted as a structural property, not a defect.
- **Existing data is wiped at the migration boundary.** A "split each old A/B Market into two new YES/NO Markets" data migration has no canonical pool-splitting rule and would arbitrarily redistribute reserves. At this project's stage the simpler call is to drop existing market/position/transaction rows and let the next ingest cron repopulate from Kalshi under the new schema.
- **Ingestion is all-or-nothing per Event.** If any child Kalshi Market fails the per-Market confidence gate, the entire Event is rejected. The Event is consulted exactly once and all its Markets are created together — see ADR-0001 as refreshed.
- **The cap on N is 30 Markets per Event.** Larger fields are rejected as `too_many_markets`. Pragmatic ceiling; revisited if real Events bump against it.
