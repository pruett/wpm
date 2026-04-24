# Kalshi is also the resolution oracle

Wampum resolves **Markets** by reading **Kalshi Settlement** data automatically — no human approval, no secondary feed, no override. This extends the one-shot-discovery stance from ADR-0001 to the terminal moment: Kalshi is consulted exactly twice per **Market** (once at creation for the pricing seed, once after `closesAt` for the winning outcome), and its answer the second time is final.

## Why

The alternative — a human-in-the-loop approval step between Kalshi Settlement and user payout — doesn't scale past toy volume (MLB alone is ~2,400 games/season across all 30 teams, and we run four sports) and offers little real protection: binary-moneyline settlements on a regulated US exchange are overwhelmingly unambiguous, and in the rare case Kalshi mis-settles a market our users are mis-paid the same way every Kalshi trader is. We chose automation end-to-end rather than building a dashboard and a staffing model.

## Considered options

- **Human-in-the-loop approval.** Rejected: operator cost + no meaningful accuracy gain.
- **Secondary resolution feed cross-checked against Kalshi.** Rejected: no clear second source for US sports binary-moneylines that wouldn't itself need reconciliation; adds complexity without clearly better answers.
- **Kalshi-side-driven polling** (enumerate Kalshi's settled events, match to our DB). Rejected in favor of our-side-driven polling (start from our open-past-close **Markets**, ask Kalshi about each). Our-side is simpler to bound, trivially integrates the **Settlement Deadline**, and structurally eliminates the "Kalshi told us about an event we never ingested" edge case.
- **Stored `closed` lifecycle state** (`open → closed → resolved | cancelled`). Rejected: "closed" is a pure function of `(status = 'open', closesAt < now)` — denormalizing it as a stored state introduces a consistency-maintenance burden (what if the close-sweep cron misses a run?) for no user-visible gain. The status enum drops `"closed"` and we keep a flat `open → resolved | cancelled` lifecycle.
- **Explicit "voided" signal from Kalshi.** Kalshi has no dedicated void status; they encode voids as both nested markets settling `no`. We accept that convention at face value rather than waiting for a signal that doesn't exist.
- **No deadline — wait forever for settlement.** Rejected: leaves user positions locked indefinitely if Kalshi orphans an event. The **Settlement Deadline** of 48 hours trades a rare wrong-cancellation risk (Kalshi takes longer than 48h to settle a legitimate event) against the certainty of never-locked positions. 48h absorbs weather delays and overtime into next-day windows; longer buys little, shorter risks cancelling real delays.

## Consequences

- A misdirected Kalshi Settlement → a misdirected Wampum payout. No unwind path after `resolveMarket` completes. Accepted risk; mitigation is "Kalshi is careful," not "we double-check Kalshi."
- The resolver runs our-side-driven: it selects `markets WHERE status = 'open' AND closesAt < now`, batches the derived Kalshi event tickers by series, and makes one `/events?event_tickers=...` call per series. No `unknown_market` case is possible because we only ask about events we own.
- Cancellations take two distinct reasons: `kalshi_voided` (Kalshi settled both sides `no`) and `kalshi_no_settlement` (48h past `closesAt` with no settlement). Both funnel through the existing `cancelMarket` and refund each holder their **Cost Basis**. The reasons live in the `CancelMarket` transaction payload for ops grep.
- The `markets.status` enum drops `"closed"`. A migration is required. No code currently writes that value, so no data migration — only the enum narrowing.
- `KalshiMarketSchema` gains a `result: z.enum(["yes","no",""]).optional().default("")` field. The contract test continues to verify the live API shape.
- No heartbeat integration — `oracleHeartbeats` write path is dead code; observability is the cron response summary, consistent with the ingest pipeline.
- The `SellShares` path remains a complication for the **Cost Basis** refund story (a partial seller gets refunded less than their remaining shares' market value). This is intentionally out of scope for this ADR: disabling sell is a separate trading-policy decision; if taken later, the refund code continues to work correctly and reads more cleanly.
