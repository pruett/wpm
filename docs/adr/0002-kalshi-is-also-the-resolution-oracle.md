# Kalshi is also the resolution oracle

Wampum resolves **Events** by reading **Kalshi Settlement** data automatically — no human approval, no secondary feed, no override. This extends the one-shot-discovery stance from ADR-0001 to the terminal moment: Kalshi is consulted exactly twice per Event (once at creation for pricing seeds across all child Markets, once after `closesAt` for per-child winning outcomes), and its answer the second time is final. *How* per-child Kalshi Settlements are committed into Wampum's Event/Market structure is detailed in ADR-0008 (per-Event synchronized commit with per-Market deadline degradation).

## Why

The alternative — a human-in-the-loop approval step between Kalshi Settlement and user payout — doesn't scale past toy volume (MLB alone is ~2,400 games/season across all 30 teams, and we run four sports plus an open-ended set of multi-outcome events) and offers little real protection: binary settlements on a regulated US exchange are overwhelmingly unambiguous, and in the rare case Kalshi mis-settles a Market our users are mis-paid the same way every Kalshi trader is. We chose automation end-to-end rather than building a dashboard and a staffing model.

## Considered options

- **Human-in-the-loop approval.** Rejected: operator cost + no meaningful accuracy gain.
- **Secondary resolution feed cross-checked against Kalshi.** Rejected: no clear second source for US sports binaries or for multi-outcome contests like the Grammys that wouldn't itself need reconciliation; adds complexity without clearly better answers.
- **Kalshi-side-driven polling** (enumerate Kalshi's settled events, match to our DB). Rejected in favor of our-side-driven polling (start from our open-past-close Events, ask Kalshi about each). Our-side is simpler to bound, trivially integrates the **Settlement Deadline**, and structurally eliminates the "Kalshi told us about an event we never ingested" edge case.
- **Stored `closed` lifecycle state.** Rejected: "closed" is a pure function of `(status = 'open', closesAt < now)` — denormalising it would introduce a consistency-maintenance burden for no user-visible gain. The Event status enum is `open | terminal`; per-child Market status is `open | resolved | cancelled`.
- **Explicit "voided" signal from Kalshi.** Kalshi has no dedicated void status; they encode an Event-level void as every nested Kalshi Market settling `no`. We accept that convention at face value.
- **No deadline — wait forever for settlement.** Rejected: leaves user positions locked indefinitely if Kalshi orphans an Event or a single child Market. The 48-hour **Settlement Deadline** is the upper bound. Its interaction with multi-Market Events — degrading to per-Market on deadline so cleanly-settled siblings still pay out — is the subject of ADR-0008.

## Consequences

- A misdirected Kalshi Settlement → a misdirected Wampum payout for that specific child Market. No unwind path after the Event-commit DB transaction completes. Accepted risk; mitigation is "Kalshi is careful," not "we double-check Kalshi."
- The resolver runs our-side-driven and Event-level: it selects `events WHERE status = 'open' AND closesAt < now`, batches the derived Kalshi event tickers by series, and makes one `/events?event_tickers=...` call per series. No `unknown_event` case is possible because we only ask about Events we own.
- **Cancellations have two reasons:** `kalshi_voided` (every nested Kalshi Market settled `no`) and `kalshi_no_settlement` (deadline elapsed with the child Kalshi Market still unsettled — applied per-child under ADR-0008's deadline degradation, not Event-wide). A third reason, `kalshi_scalar`, fires when Kalshi pays a partial settlement amount our binary AMM has no path for. All reasons funnel through the per-Market cancellation path and refund each holder their **Cost Basis** (which under ADR-0007 is simply their full money in, since there is no sell).
- The `events.status` enum is `open | terminal`. Per-child `markets.status` is `open | resolved | cancelled`. No `closed` state at either granularity.
- `KalshiMarketSchema` carries `result: z.enum(["yes","no","scalar",""]).optional().default("")`. The contract test continues to verify the live API shape.
- No heartbeat integration — observability is the cron response summary, consistent with the ingest pipeline.
- The partial-seller complication that previously lived in the **Cost Basis** refund story is gone end-to-end: ADR-0007 retires the sell path entirely, so `costBasis` is monotonic and refunds are unambiguous.
