# Vocabulary

Shared terms for how Kalshi structures data, and how we use it. Grounded in
live `KXWCGAME` (World Cup 2026) data — see `src/kalshi/ingest.ts`.

## Kalshi terms

**Series** — A template for recurring events of the same format.
Identified by a ticker, e.g. `KXWCGAME` (World Cup games), `KXWCSCORE`
(correct score), `KXMWORLDCUP` (tournament winner). Discover via
`GET /series` (`listSeries()`).

**Event** — One real-world occurrence within a series, e.g.
`KXWCGAME-26JUN27PANENG` ("Panama vs England"). Contains markets.
`mutually_exclusive: true` means exactly one of its markets resolves yes.

**Market** — One binary yes/no contract on a single outcome of an event.
There is no deeper "outcome items" layer — the outcome *is* the market.
A soccer game event always has 3 markets: home win, away win, tie
(e.g. `…PANENG-PAN`, `…PANENG-ENG`, `…PANENG-TIE`). A golf event would
have one market per player.

**Price** — Kalshi has no "odds" field; the contract price is the odds.
Contracts pay $1 on yes, so price ≈ implied probability
(England at `yes_ask` 0.77 ≈ 77%). Use the bid/ask midpoint or
`last_price` as the probability estimate.

## Derived concepts (ours)

**Implied probability** — Midpoint of `yes_bid`/`yes_ask` for a market.

**Overround (vig)** — Implied probabilities across an event's markets sum
slightly above 1.00. Normalize before deriving our own odds.

**Liquidity** — `volume` / `open_interest` on a market. Thin markets have
unreliable prices; weight accordingly when generating odds.
