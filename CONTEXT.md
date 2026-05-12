# Wampum (WPM)

Prediction-market platform with a CPMM-based AMM. Markets are ingested from external providers (currently Kalshi) and translated into our internal representation before any betting, resolution, or payout logic runs against them.

A Wampum **Event** is a real-world contest (a basketball game, the Grammys, a golf tournament). An Event holds one or more **Markets**, each a single YES/NO contract on one specific outcome of that Event (a team winning, a nominee winning, a golfer winning). Every Market has its own AMM pool and resolves independently. Betting is buy-only on the YES side; users cannot sell shares back to the pool, nor buy NO shares.

## Language

### Ingestion (external shape)

**Kalshi Event**:
A container returned by the Kalshi API representing a single real-world contest. Holds one or more **Kalshi Markets** — one per outcome being offered (one per team in a binary game; one per nominee in a multi-outcome contest).
_Avoid_: bare "event" without context (use **Wampum Event** for the internal counterpart, **Kalshi Event** for the external), "Kalshi game".

**Kalshi Market**:
A single YES/NO contract attached to a **Kalshi Event**, representing one specific outcome's chance of resolving YES (e.g. one team winning, one nominee winning).
_Avoid_: "Kalshi outcome", "sub-market", "leg".

**Kalshi Settlement**:
The terminal state of a **Kalshi Market** where Kalshi has posted a `result` (`yes`, `no`, or `scalar`) and its `status` has reached a terminal value (`settled`, `finalized`, or `determined`). Each **Kalshi Market** in an Event settles independently. **Void**: Kalshi has no dedicated void status; if every **Kalshi Market** under an Event settles `no`, the Event is treated as voided. Kalshi Settlement is the external signal Wampum reads to drive internal **Resolution**.
_Avoid_: "Kalshi resolution" (collides with our internal **Resolution**), "Kalshi result" unqualified.

### Internal (Wampum shape)

**Wampum Event** (or **Event** in unambiguous contexts):
Wampum's internal representation of a real-world contest. Mirrors a **Kalshi Event** one-to-one. Holds one or more **Markets**, each on one outcome of the contest.
_Avoid_: "game" or "contest" as type names (fine in domain prose), bare "event" when ambiguous with **Kalshi Event**.

**Market**:
Wampum's internal representation of a single YES/NO contract on one specific outcome of a **Wampum Event**. Backed by a constant-product AMM pool. One **Market** per **Kalshi Market**, one-to-one. The unit of pricing, betting, resolution, and settlement.
_Avoid_: "outcome" (the noun is retired — see below), "Kalshi market" (always prefix when referring to the external).

> **Note on the previous A/B model.** Earlier versions of Wampum collapsed a binary **Kalshi Event** into a single **Market** with two outcomes named `A` and `B`, sharing one pool. That model is retired: a binary game is now one **Wampum Event** with two **Markets** (one per team), each its own binary YES/NO contract with its own AMM pool. The term **Outcome** as a domain noun is retired with that model — Markets resolve YES or NO, full stop.

### Trading (AMM)

Wampum's trading model follows the standard binary prediction-market convention (Kalshi, Polymarket): each **Market** is a single YES/NO contract priced between 0 and 1 WPM, where the price is interpreted as the market's implied probability of YES.

**Share**:
A contingent claim on 1 WPM, contingent on a specific **Market** resolving YES. Pays 1 WPM at **Resolution** if YES, 0 otherwise. Shares are the unit users buy — you never "bet on a Market" in the abstract, you acquire YES-shares of that Market.
_Avoid_: "token", "contract", "bet unit", "ticket", "A-share" / "B-share" (the A/B model is retired).

**Price** (of a Share):
The current cost in WPM to acquire one YES-share of a **Market**, always between 0 and 1. Derived from pool reserves, not stored. Also the market's **Implied Probability** of YES (price = probability, because a YES share pays exactly 1 WPM).
_Avoid_: "odds" unqualified (reserved for the multiplier form), "cents" (Kalshi-side; we denominate in WPM).

**Implied Probability**:
The probability the market assigns to YES, equal to its **Price** in WPM. _Within_ a single **Market**, YES-probability + NO-probability = 1 by construction of the pool. _Across_ the **Markets** of a multi-outcome Event, the sum of YES-probabilities is **not** enforced to equal 1 — each Market prices independently and arbitrage by new buyers is the only convergence force. Drift between sibling Markets is a market-inefficiency feature, not a bug.
_Avoid_: "chance", "confidence".

**Multiplier** (decimal odds):
The payout ratio per WPM staked if the **Market** resolves YES — i.e. `1 / price`. Surfaced to users as an "odds" display alongside the raw price.
_Avoid_: "American odds", "moneyline" (we don't render those).

**AMM** (Automated Market Maker):
The algorithm and pool state that continuously quote prices and execute trades without an order book or counterparty. Every **Market** has exactly one AMM. The AMM is the sole source of price truth after market creation (see ADR-0001).
_Avoid_: "order book", "matching engine".

**Constant-product invariant**:
The rule `sharesYes * sharesNo = k` that the **Pool** preserves across trades. Buying YES removes YES-shares from reserves and adds to the NO-side, moving price along the curve.

**Pool** (AMM Pool):
The reserves and liquidity state backing a single **Market**'s AMM: `reserveYes`, `reserveNo` (outstanding shares held by the market maker), `wpmReserve` (total WPM locked), and `seedAmount`. One-to-one with **Market**.

**Reserves**:
The YES- and NO-share counts held by the **Pool**. YES-reserve shrinks on YES buys; NO-reserve grows. The ratio between reserves sets the **Price**. Even though only YES is sold to users, the NO reserve is the AMM's accounting counterpart and must be tracked.

**Seed** / **Seed Amount**:
The WPM committed at **Market** creation to bootstrap the **Pool**. Sets initial liquidity depth and is split into initial YES- and NO-shares according to the **Initial Probability**. Currently a constant (`1000`) per Market.

**Initial Probability**:
The real-world prior used to skew the **Pool**'s starting reserves — derived at ingest time from the corresponding **Kalshi Market**'s bid/ask midpoint and never refreshed. A 70% initial probability of YES produces fewer YES-shares in reserve (making them scarce and expensive).

**Liquidity** / **Slippage**:
Unchanged. **Liquidity** is depth (`wpmReserve`); **Slippage** is the price impact a trade incurs against that depth, governed by the **Constant-product invariant**.

**Bet** / **Place Bet**:
A YES-buy: deposit WPM, receive YES-shares of a chosen **Market** at the current AMM-quoted **Price**. Corresponds to the `PlaceBet` transaction type. Wampum exposes no NO-side and no sell — every bet is a YES-buy on exactly one **Market**.
_Avoid_: "wager", "stake".

**Position**:
A user's current holding in a single **Market**: YES-shares plus a running **Cost Basis**. One row per (user, market). Zero shares is a no-position; we don't delete the row. A user's stake "in an Event" is the union of their **Positions** across that Event's **Markets** — there is no per-Event aggregate row.
_Avoid_: "holding", "bag", "bet" (a bet is an action; a position is state).

**Cost Basis**:
Total WPM the user has spent acquiring their **Position** in a **Market**. Monotonic — Wampum has no sell path, so cost basis only grows. Used as the refund amount on **Cancellation** and as the denominator for P&L vs. current share value.
_Avoid_: "invested", "stake", "principal".

**Resolution**:
The terminal event where a **Market** is marked YES or NO based on its corresponding **Kalshi Market**'s settlement. Resolution is **per-Market** — each Market in a multi-outcome Event resolves on its own Kalshi-side `result`. Kalshi is the sole resolution oracle (see ADR-0002). Triggers **Settlement**.
_Avoid_: "close" (betting cutoff is derived from `closesAt`, not a lifecycle state), "Kalshi resolution" (that's a **Kalshi Settlement**).

**Settlement** / **Payout**:
The act of paying out 1 WPM per YES-share to each holder of a **Market** that resolved YES, and zero per share of a Market that resolved NO. **Resolution and Settlement commit atomically per Market**. There is no user-initiated claim — payouts are pushed.

**Cancellation**:
The terminal event where a **Market** is marked cancelled because it cannot be resolved (Kalshi voided, Kalshi paid scalar, or the **Settlement Deadline** elapsed without Kalshi Settlement). Refunds each holder their full **Cost Basis**. Per-Market, like Resolution — within a multi-outcome Event, some Markets may resolve while others cancel.
_Avoid_: "void" as a Wampum term (void is a Kalshi-side input, not a Wampum status).

## Relationships

- One **Kalshi Event** ↔ one **Wampum Event** (1:1)
- One **Kalshi Market** ↔ one **Wampum Market** (1:1)
- One **Wampum Event** → N **Markets** (N ≥ 1)
- A **Market** owns exactly one **Pool** and is referenced by **Positions** and transactions
- A **Pool** holds YES- and NO-**Reserves** plus a WPM reserve; **Price**, **Implied Probability**, and **Multiplier** are all derived from it, never stored
- A **Bet** debits the user's balance, credits the **Pool**'s `wpmReserve`, shifts **Reserves** along the **Constant-product invariant**, and mints YES-**Shares** into the user's **Position**
- **Resolution** is per-**Market**; **Settlement** pays 1 WPM per YES-share if YES, 0 if NO, atomically with Resolution
- A user's stake "in an Event" is the union of their **Positions** across that Event's **Markets**

## Ingestion invariants

- **Ingestion is one-shot discovery.** Kalshi data is consulted exactly once per **Market** — at creation — to seed the AMM's initial probability. After creation, the **Market** is an independent Wampum entity; Kalshi is never re-queried for _pricing_. Live Kalshi price movement does not touch our rows.
- **The AMM is the sole source of truth for prices** after creation.
- **Ingestion gates per-Market on Kalshi confidence.** The translator rejects a **Kalshi Market** whose bid-ask spread exceeds a threshold — a wide spread means buyers and sellers have not consolidated on a price and the midpoint is a phantom. The gate asks "has Kalshi agreed on _a_ number?"; it never filters on _which_ number.
- **Per-Event gating is all-or-nothing.** If any child **Kalshi Market** fails the spread gate (or any other ingestion check), the whole **Event** is rejected with `insufficient_confidence` and the failing tickers reported per-child. We do not partially ingest the passing children; every Market under an Event shares the same fate at ingest.

## Resolution invariants

- **Kalshi is also the sole resolution oracle** (ADR-0002). The resolver re-queries Kalshi after a **Market**'s `closesAt` and reads the corresponding **Kalshi Market**'s `result` field.
- **Kalshi is consulted twice per Market**: once at creation (pricing seed) and once at resolution (winning side).
- **Resolution is our-side-driven and per-Market.** The resolver starts from Wampum — `markets WHERE status = 'open' AND closesAt < now` — and asks Kalshi about each one's underlying Kalshi Market. Each Market in an Event resolves independently on its own `result`.
- **Void is inferred per-Event.** A **Kalshi Event** whose every **Kalshi Market** settles `no` is treated as voided; every Wampum Market under that Event becomes `kalshi_voided` **Cancellation**.
- **The Settlement Deadline bounds user lockup**, applied per-Market: 48 hours past `closesAt` with no **Kalshi Settlement** → `kalshi_no_settlement` Cancellation.
- **Resolution and Settlement commit atomically per Market.** No intermediate `resolved`-but-unpaid state, no settlement queue, no user-initiated claim.
- **The treasury is the explicit backstop for AMM shortfalls** at Settlement. Per-Market.
- **Cancellation refunds full Cost Basis.** With sell removed, cost basis equals total WPM put in; no partial-seller complication.
- **Every holder gets a `SettlePayout` row.** On both **Resolution** and **Cancellation**, every user with a non-zero holding at settlement time gets exactly one row — winners with `amount = winningShares`, losers with `amount = 0`, cancel refunds with `amount = costBasis`.

## Example dialogue

> **Dev:** "The Kalshi response has an array of markets under each event — what do those become?"
> **Domain expert:** "One **Kalshi Event** becomes one **Wampum Event**. Each **Kalshi Market** under it becomes one **Wampum Market** — a single binary YES/NO contract with its own AMM pool. A basketball game becomes one Event with two Markets (Lakers-WIN, Celtics-WIN). The Grammys with five nominees becomes one Event with five Markets. Every Market resolves independently on its own Kalshi-side `result`."

> **Dev:** "If a user wants to bet against the Lakers, what do they do?"
> **Domain expert:** "They buy YES-shares of the `Celtics-WIN` **Market**. There's no NO-side and no sell — every bet is a YES-buy on exactly one Market."

> **Dev:** "If a user bets 100 WPM on Lakers winning, what happens?"
> **Domain expert:** "They buy YES-shares of the `Lakers-WIN` **Market**. The **Pool**'s YES reserve shrinks, NO reserve grows, the user receives YES-shares at an average price below 1 WPM. Their **Position** in that Market gets `shares += received` and `costBasis += 100`. Their **Position** in the sibling `Celtics-WIN` Market is untouched — those are independent Markets with independent pools."

> **Dev:** "Can the YES-prices of `Lakers-WIN` and `Celtics-WIN` add up to more than 1?"
> **Domain expert:** "Yes. They're independent pools. The constraint that complementary outcomes' prices sum to 1 is _no longer_ an AMM-enforced invariant — it's an arbitrage-driven convergence. New buyers will tend to push toward sum-to-1 by buying the under-priced side. Drift on small pools is expected."

## Flagged ambiguities

- **"Market"** once meant a Wampum A/B contest with two outcomes sharing one pool. It now means a single binary YES/NO contract with its own pool. The A/B model is retired.
- **"Event"** was previously avoided unqualified because of theoretical collision with domain events. Domain events in this codebase are called _transactions_, so the collision was theoretical, not real. **Event** is now a first-class Wampum noun. Always say **Wampum Event** when distinguishing from **Kalshi Event** in code; bare "Event" is fine in unambiguous prose.
- **"Outcome"** is retired as a domain noun. Markets resolve YES or NO; we don't need a separate noun for "the slot."
- **"Sell"** / **"SellShares"** is retired as a product capability. Wampum is buy-YES-only by design.
- **"Settlement"** still collides with Kalshi vocabulary (their Markets _settle_ with a `result`). Resolved as before: **Kalshi Settlement** = external signal; bare **Settlement** = Wampum payout. **Resolution** = Wampum status transition that Kalshi Settlement triggers.
