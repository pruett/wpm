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

**Kalshi Settlement**:
The terminal state of a **Kalshi Market** where Kalshi has posted a `result` (`yes` or `no`) and its `status` has reached a terminal value (`settled`, `finalized`, or `determined`). For a binary-moneyline **Kalshi Event**, the two **Kalshi Markets** settle together — winner's side `yes`, loser's side `no`. Kalshi encodes **void** (game didn't happen) by settling *both* sides `no`; there is no dedicated void status. Kalshi Settlement is the external signal Wampum reads to drive internal **Resolution**.
_Avoid_: "Kalshi resolution" (collides with our internal **Resolution**), "Kalshi result" unqualified.

### Internal (Wampum shape)

**Market**:
Wampum's internal representation of a tradable contest. Has exactly two outcomes, `A` and `B`, backed by a constant-product AMM pool. Identified by a stable string id derived from the source (e.g. `kalshi-KXMLBGAME-...`).
_Avoid_: "game", "event", "contest", "Kalshi market".

**Outcome**:
One of the two sides of a **Market** — always literally `"A"` or `"B"`. Populated from the `yes_sub_title` of the corresponding **Kalshi Market** at ingest time.
_Avoid_: "side", "team" (teams are rendered into outcomes but the domain concept is the outcome slot).

### Trading (AMM)

Wampum's trading model follows the standard binary prediction-market convention (Kalshi, Polymarket): each **Outcome** is a separately-traded contingent claim, priced between 0 and 1 WPM, where the price is interpreted as the market's implied probability.

**Share**:
A contingent claim on 1 WPM, contingent on a specific **Outcome** winning. An A-share pays 1 WPM at resolution if the **Market** resolves `A` and 0 otherwise; same for B-shares. Shares are the unit users buy and sell — you never "bet on A" in the abstract, you acquire A-shares.
_Avoid_: "token", "contract", "bet unit", "ticket".

**Price** (of a **Share**):
The current cost in WPM to acquire one **Share** of a given **Outcome**, always between 0 and 1. Derived from pool reserves, not stored. Also the market's **Implied Probability** for that outcome (price = probability, because a winning share pays exactly 1 WPM).
_Avoid_: "odds" unqualified (reserved for the multiplier form), "cents" (Kalshi-side; we denominate in WPM).

**Implied Probability**:
The probability the market assigns to an **Outcome**, equal to its **Price** in WPM. Within a single **Market** the two outcomes' implied probabilities sum to 1. Not stored — computed from the **Pool**.
_Avoid_: "chance", "confidence".

**Multiplier** (decimal odds):
The payout ratio per WPM staked if the **Outcome** wins — i.e. `1 / price`. Surfaced to users as an "odds" display alongside the raw price.
_Avoid_: "American odds", "moneyline" (we don't render those).

**AMM** (Automated Market Maker):
The algorithm and pool state that continuously quote prices and execute trades without an order book or counterparty. Every **Market** has exactly one AMM. The AMM is the sole source of price truth after market creation (see ADR-0001).
_Avoid_: "order book", "matching engine" (we have neither).

**Constant-product invariant**:
The rule `sharesA * sharesB = k` that the **Pool** preserves across trades. Buying one **Outcome** removes **Shares** of that outcome from reserves and adds the other, moving price along the curve. Defines the AMM's pricing and slippage behavior.
_Avoid_: "constant sum", "LMSR" (we use neither).

**Pool** (AMM Pool):
The reserves and liquidity state backing a single **Market**'s AMM: `reserveA`, `reserveB` (outstanding **Shares** held by the market maker), `wpmReserve` (total WPM locked), and `seedAmount` (the bootstrap value — see **Seed**). One-to-one with **Market**.
_Avoid_: "vault", "book".

**Reserves**:
The per-outcome **Share** counts held by the **Pool** (`reserveA`, `reserveB`). Shrink on buys of that outcome, grow on sells. The ratio between reserves sets the **Price**.
_Avoid_: "inventory", "supply" (supply is a money concept — see `INITIAL_SUPPLY`).

**Seed** / **Seed Amount**:
The WPM committed at **Market** creation to bootstrap the **Pool**. Sets initial liquidity depth (how much price moves per unit traded) and is split into initial **Shares** according to the **Initial Probability**. Currently a constant (`1000`) per market.
_Avoid_: "subsidy", "float".

**Initial Probability**:
The real-world prior used to skew the **Pool**'s starting reserves — derived at ingest time from the Kalshi bid/ask midpoint and never refreshed. A 70% initial probability on A produces fewer A-**Shares** in reserve (making them scarce and expensive).
_Avoid_: "seed price", "opening line".

**Liquidity**:
The depth of the **Pool** — how much WPM can be traded before **Price** moves significantly. Larger **Seed** → higher liquidity → lower **Slippage** per trade. Reflected in `wpmReserve`.
_Avoid_: "volume" (volume is flow, liquidity is depth).

**Slippage** / **Price Impact**:
The amount a trade moves the **Price** against the trader due to the **Constant-product invariant**. A direct consequence of AMM mechanics — larger trades relative to **Liquidity** incur more slippage.
_Avoid_: "spread" (there is no bid/ask spread in a CPMM; a single price curve serves both sides).

**Bet** / **Place Bet**:
A buy trade: deposit WPM, receive **Shares** of a chosen **Outcome** at the current AMM-quoted **Price**. Corresponds to the `PlaceBet` transaction type and `placeBet` server action.
_Avoid_: "wager", "stake" (stake is a noun, see below).

**Sell** / **Sell Shares**:
Sell existing **Shares** back to the AMM in exchange for WPM at the current quote. Corresponds to `SellShares` transaction type.
_Avoid_: "cash out", "redeem" (redeem is reserved for post-resolution).

**Position**:
A user's current holdings in a single **Market**: `sharesA`, `sharesB`, and a running **Cost Basis**. One row per (user, market). Zero **Shares** on both sides is a no-position; we don't delete the row.
_Avoid_: "holding", "bag", "bet" (a bet is an action, a position is state).

**Cost Basis**:
The running WPM total a user has spent acquiring their current **Position** in a **Market**, net of sells. Used to compute P&L against current **Share** value. Reduced proportionally when **Shares** are sold.
_Avoid_: "invested", "stake", "principal".

**Resolution**:
The terminal event where a **Market** is marked with a winning **Outcome** (`A` or `B`). Triggers **Settlement**. Driven by **Kalshi Settlement** — the resolver reads Kalshi's `result` on both **Kalshi Markets** and maps it to the winning Wampum **Outcome**. No human approval layer; Kalshi is the sole resolution oracle (see ADR-0002). Corresponds to `ResolveMarket` transaction type.
_Avoid_: "close" (betting cutoff is derived from `closesAt`, not a lifecycle state), "finalize", "Kalshi resolution" (that's a **Kalshi Settlement**).

**Settlement** / **Payout**:
The act of paying out 1 WPM per winning **Share** to each holder after **Resolution**, and zero per losing **Share**. Corresponds to `SettlePayout` transaction type.
_Avoid_: "distribution" (distribution is a treasury operation, see `Distribute`), "claim".

**Cancellation**:
A **Market** terminated without a winning **Outcome**. Moves status to `cancelled` and refunds each holder their **Cost Basis** from the **Pool**. Reached only through the automated resolver — there is no user- or operator-facing cancel operation, and the UI never triggers it. Triggered by one of two conditions, recorded in the `CancelMarket` transaction payload's `reason`:
- `kalshi_voided` — the **Kalshi Event** settled with both **Kalshi Markets** `no` (Kalshi's void convention).
- `kalshi_no_settlement` — 48 hours have elapsed past the **Market**'s `closesAt` without Kalshi posting a settlement (the **Settlement Deadline**; see ADR-0002).
_Avoid_: "refund" (refund is the *consequence* of cancellation, not the event), "void" as a verb (prefer "Kalshi voided the event").

**Settlement Deadline**:
48 hours past a **Market**'s `closesAt`. If Kalshi has not posted a **Kalshi Settlement** by then, the resolver force-cancels the **Market** with reason `kalshi_no_settlement` rather than letting users' positions remain locked indefinitely. A policy knob — intentionally long enough to absorb weather delays and overtime, short enough to bound user lockup.
_Avoid_: "timeout" (ambiguous with HTTP/fetch timeouts), "expiry" (Kalshi uses `expected_expiration_time` for a different concept).

**Market Status** (lifecycle):
`open` → betting allowed until `closesAt`, after which the resolver is eligible to act; `resolved` → outcome decided and payouts processed; `cancelled` → terminated without a winner, cost basis refunded. There is intentionally no stored `closed` state — "past close, awaiting resolution" is derived from `(status = 'open', closesAt < now)` rather than stored.
_Avoid_: "active"/"inactive" (too coarse), "live" (ambiguous with UI state), "closed" (was an unused enum value, dropped in the resolution pipeline migration).

## Relationships

- One **binary-moneyline Kalshi Event** → one **Market**
- Two **Kalshi Markets** (one per team) → two **Outcomes** (`A` and `B`) on the same **Market**
- A **Market** owns exactly one **Pool** and is referenced by **Positions**, transactions, and the resolution/cancellation flows
- A **Pool** holds **Reserves** for both **Outcomes** plus a WPM reserve; **Price**, **Implied Probability**, and **Multiplier** are all derived from it, never stored
- A **Bet** debits the user's balance, credits the **Pool**'s `wpmReserve`, shifts **Reserves** along the **Constant-product invariant**, and mints **Shares** into the user's **Position**
- A **Sell** inverts a **Bet**: burns **Shares** from the **Position**, moves **Reserves** back along the curve, and pays WPM out of the **Pool**
- **Resolution** fixes a winning **Outcome**; **Settlement** pays 1 WPM per winning **Share** from the **Pool** to each holding **Position**; losing **Shares** pay 0

## Ingestion invariants

- **Ingestion is one-shot discovery.** Kalshi data is consulted exactly once per **Market** — at the moment we create it — to seed the AMM's initial probability. After creation, the **Market** is an independent Wampum entity; Kalshi is never re-queried for *pricing*. Live Kalshi price movement does not touch our rows.
- **The AMM is the sole source of truth for prices** after creation. The Wampum **Market** intentionally diverges from Kalshi from t=0 onward.

## Resolution invariants

- **Kalshi is also the sole resolution oracle.** After a **Market**'s `closesAt`, the resolver re-queries Kalshi for that specific **Kalshi Event** and reads the two **Kalshi Markets**' `result` fields. The resulting **Resolution** (or **Cancellation**) is final — no human approval layer (see ADR-0002).
- **Kalshi is consulted twice total per Market**, never more: once at creation (for pricing seed) and once at resolution (for the winning outcome). The two reads are the only Kalshi touchpoints in the **Market**'s lifetime.
- **Resolution is our-side-driven.** The resolver starts from Wampum — `markets WHERE status = 'open' AND closesAt < now` — and asks Kalshi about those specific events. It does not enumerate Kalshi's settled events and look for matches.
- **Void is inferred, not signalled.** Kalshi has no dedicated void status; a **Kalshi Event** whose two **Kalshi Markets** both settle `no` is treated as voided → `kalshi_voided` **Cancellation**.
- **The Settlement Deadline bounds user lockup.** 48 hours past `closesAt` with no **Kalshi Settlement** → force-cancel with `kalshi_no_settlement`. Trades the risk of mis-cancelling a slow-to-settle market against the risk of indefinite position lockup; we've chosen the former.

## Example dialogue

> **Dev:** "The Kalshi response has an array of markets under each event — are those our Markets?"
> **Domain expert:** "No. A **Kalshi Event** becomes one of our **Markets**. The two **Kalshi Markets** underneath it become the two **Outcomes** (A and B) of that single Wampum **Market**."

> **Dev:** "If a user bets 100 WPM on A, how many A-**Shares** do they get?"
> **Domain expert:** "Depends on the **Pool**'s current **Reserves**. The AMM quotes it via the **Constant-product invariant** — the 100 WPM enters the B-side reserve, the A-side reserve shrinks to keep `reserveA * reserveB = k`, and the user receives the difference plus their deposit as A-**Shares**. The average **Price** they paid is <1 WPM per share, and their trade pushes the next buyer's **Price** up. That movement is **Slippage**."

> **Dev:** "So if A-**Shares** cost 0.30 WPM, the market thinks A has a 30% chance?"
> **Domain expert:** "Right. **Price** and **Implied Probability** are the same number for us — a winning **Share** pays exactly 1 WPM, so the fair price *is* the probability. The **Multiplier** (`1 / 0.30 ≈ 3.33x`) is just that same information in payout-ratio form for the UI."

> **Dev:** "What seeds the pool? Is that where the **Initial Probability** comes in?"
> **Domain expert:** "Yes. At ingest we take Kalshi's bid/ask midpoint as the **Initial Probability** and use it to split the **Seed** (1000 WPM) into unequal **Reserves** — fewer shares on the favored side so its **Price** starts high. After that moment, Kalshi is never consulted again; the AMM is the sole price authority (ADR-0001)."

## Flagged ambiguities

- "Market" was used to mean both a **Kalshi Market** (YES/NO contract on one team) and a **Market** (our internal A/B contest). Resolved: always prefix the Kalshi-side type (`KalshiMarket`) in code; unqualified "Market" refers to the Wampum internal concept.
- "Settlement" collides between Kalshi's vocabulary (their markets *settle* with a `result`) and Wampum's (the post-**Resolution** payout step). Resolved: **Kalshi Settlement** always refers to the external Kalshi-side event; unqualified **Settlement** is always the Wampum payout. "Resolution" is the Wampum status transition that Kalshi Settlement triggers.
