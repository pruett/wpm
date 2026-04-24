# Wampum (WPM)

Prediction-market platform with an A/B AMM. Markets are ingested from external providers (currently Kalshi) and translated into our internal representation before any betting, resolution, or payout logic runs against them.

## Language

### Ingestion (external shape)

**Kalshi Event**:
A container returned by the Kalshi API representing a single real-world contest (e.g. a baseball game). A binary-moneyline **Kalshi Event** holds exactly two **Kalshi Markets** — one per team.
_Avoid_: "event" unqualified (collides with domain events like bets), "Kalshi game".

**Kalshi Market**:
A single YES/NO contract attached to a **Kalshi Event**, representing one team's chance of winning. For binary-moneyline events there are always two — one for each team.
_Avoid_: "Kalshi outcome", "sub-market", "leg".

**Binary-moneyline Kalshi Event**:
The only **Kalshi Event** shape Wampum currently ingests: exactly two **Kalshi Markets** representing which team wins. Events with any other structure (e.g. props, totals, multi-outcome) are rejected at the translator — this is an invariant, not a filter.

### Internal (Wampum shape)

**Market**:
Wampum's internal representation of a tradable contest. Has exactly two outcomes, `A` and `B`, backed by a constant-product AMM pool. Identified by a stable string id derived from the source (e.g. `kalshi-KXMLBGAME-...`).
_Avoid_: "game", "event", "contest", "Kalshi market".

**Outcome**:
One of the two sides of a **Market** — always literally `"A"` or `"B"`. Populated from the `yes_sub_title` of the corresponding **Kalshi Market** at ingest time.
_Avoid_: "side", "team" (teams are rendered into outcomes but the domain concept is the outcome slot).

## Relationships

- One **binary-moneyline Kalshi Event** → one **Market**
- Two **Kalshi Markets** (one per team) → two **Outcomes** (`A` and `B`) on the same **Market**
- A **Market** owns exactly one AMM pool and is referenced by positions, transactions, and the resolution/cancellation flows

## Ingestion invariants

- **Ingestion is one-shot discovery.** Kalshi data is consulted exactly once per **Market** — at the moment we create it — to seed the AMM's initial probability. After creation, the **Market** is an independent Wampum entity; Kalshi is never re-queried for it. Live Kalshi price movement does not touch our rows.
- **The AMM is the sole source of truth for prices** after creation. The Wampum **Market** intentionally diverges from Kalshi from t=0 onward.

## Example dialogue

> **Dev:** "The Kalshi response has an array of markets under each event — are those our Markets?"
> **Domain expert:** "No. A **Kalshi Event** becomes one of our **Markets**. The two **Kalshi Markets** underneath it become the two **Outcomes** (A and B) of that single Wampum **Market**."

## Flagged ambiguities

- "Market" was used to mean both a **Kalshi Market** (YES/NO contract on one team) and a **Market** (our internal A/B contest). Resolved: always prefix the Kalshi-side type (`KalshiMarket`) in code; unqualified "Market" refers to the Wampum internal concept.
