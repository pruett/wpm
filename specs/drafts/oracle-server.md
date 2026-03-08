# Oracle Server — Component Specification

## Overview

The oracle server bridges real-world sports data onto the WPM blockchain. It runs as a separate Docker container, communicating with the blockchain node via the API server's internal endpoints. It has two jobs: **ingest** (create markets from upcoming games) and **resolve** (settle markets from completed games). It uses ESPN's public API as its sole data source.

## Oracle Identity

The oracle has its own RSA key pair, distinct from the PoA signer key. The node recognizes this key as an authorized oracle — only transactions signed by this key are accepted for `CreateMarket` and `ResolveMarket`.

The oracle key is generated at system initialization and registered with the node.

## Schedule

All times are Eastern Time (ET). The schedule is public and documented in the web app.

| Job         | Schedule                                | Purpose                               |
| ----------- | --------------------------------------- | ------------------------------------- |
| **Ingest**  | Daily at 6:00 AM ET                     | Fetch upcoming games, create markets  |
| **Resolve** | Every 30 minutes, 12:00 PM – 1:00 AM ET | Check completed games, settle markets |

Implementation: cron jobs within the Docker container (or a lightweight scheduler like `node-cron`).

## Ingest Job

### Flow

1. Query ESPN API for upcoming games across enabled sports
2. For each game:
   a. Check if a market already exists for this `externalEventId`
   b. If not, create a `CreateMarket` transaction
3. Submit transactions to the node via `POST /internal/transaction`

### Market Creation Details

For each new game:

```typescript
{
  type: "CreateMarket",
  marketId: uuid(),
  sport: "NFL",                         // From adapter
  homeTeam: "Kansas City Chiefs",       // From ESPN
  awayTeam: "Philadelphia Eagles",      // From ESPN
  outcomeA: "Kansas City Chiefs win",   // homeTeam win
  outcomeB: "Philadelphia Eagles win",  // awayTeam win
  eventStartTime: 1699999200000,        // Game start time from ESPN
  seedAmount: 1000,                     // Default, overridable by admin
  externalEventId: "401547417"          // ESPN event ID
}
```

### Deduplication

The oracle maintains a local mapping of `externalEventId → marketId` to avoid creating duplicate markets. This mapping is rebuilt on startup by querying the node for all existing markets.

### Lookahead Window

The ingest job fetches games within the next **14 days**. This gives users time to browse and bet on upcoming games. Games further out are ignored until they fall within the window.

## Resolve Job

### Flow

1. Query the node for all markets with status `open` where `eventStartTime` has passed
2. For each market:
   a. Query ESPN API for the game's current status using `externalEventId`
   b. If game status is `final`:
   - Determine winning team from the score
   - Submit `ResolveMarket` transaction
     c. If game status is `postponed` or `cancelled`:
   - Submit `CancelMarket` transaction
     d. If game status is `in_progress` or `scheduled`:
   - Skip (game hasn't finished yet)

### Score Interpretation

```typescript
// ESPN returns something like:
{
  competitions: [{
    status: { type: { completed: true } },
    competitors: [
      { team: { displayName: "Chiefs" }, score: "27", homeAway: "home" },
      { team: { displayName: "Eagles" }, score: "24", homeAway: "away" }
    ]
  }]
}

// Oracle logic:
if (homeScore > awayScore) winningOutcome = "A"  // home team = outcome A
if (awayScore > homeScore) winningOutcome = "B"  // away team = outcome B
if (homeScore === awayScore) → CancelMarket      // tie → refund
```

### Tie Handling

If a game ends in a tie (possible in NFL regular season):

- Submit `CancelMarket` with reason `"Game ended in a tie"`
- All bettors are refunded

## Sport Adapters

Each sport has an adapter module that knows how to:

1. Query ESPN for upcoming games
2. Parse the response into a normalized format
3. Query ESPN for game results
4. Determine the winner from the result

### Adapter Interface

```typescript
interface SportAdapter {
  sport: string; // "NFL", "NBA", etc.
  fetchUpcomingGames(days: number): Promise<RawGame[]>;
  fetchGameResult(externalEventId: string): Promise<GameResult>;
}

interface RawGame {
  externalEventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: number; // Unix timestamp
  sport: string;
}

interface GameResult {
  externalEventId: string;
  status: "final" | "in_progress" | "scheduled" | "postponed" | "cancelled";
  homeScore?: number;
  awayScore?: number;
  winnerHomeAway?: "home" | "away";
}
```

### NFL Adapter (Launch)

ESPN API endpoints:

```
# Upcoming games (scoreboard)
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
    ?dates=YYYYMMDD-YYYYMMDD

# Specific game
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary
    ?event={eventId}
```

These are public, unauthenticated endpoints. No API key required.

### Future Adapters

Adding a new sport requires:

1. Create a new adapter implementing `SportAdapter`
2. Register it in the adapter registry
3. ESPN URL pattern is consistent: `/sports/{category}/{league}/scoreboard`

Planned:

- NBA: `/sports/basketball/nba/scoreboard`
- NHL: `/sports/hockey/nhl/scoreboard`
- MLB: `/sports/baseball/mlb/scoreboard`
- Tennis: `/sports/tennis/scoreboard`
- Golf: `/sports/golf/pga/scoreboard`

## Error Handling

### ESPN API Unavailable

- Log the error
- Retry once after 5 seconds
- If retry fails, skip this cycle (next run will catch up)
- Do NOT create partial markets or submit bad data

### Market Creation Fails

- Log the error with the game details
- The game will be retried on the next ingest cycle (deduplication check will see it's still missing)

### Resolution Ambiguity

- If ESPN data is unclear or the adapter can't determine a winner, skip the game
- Log a warning for admin review
- Admin can manually resolve via the admin portal

## Oracle State

The oracle is stateless between runs — it queries the node for current market state each time. The only local state is the `externalEventId → marketId` mapping, which is rebuilt from the node on startup.

This means the oracle can be restarted at any time without data loss.

## Configuration

```typescript
interface OracleConfig {
  nodeApiUrl: string; // Internal API URL (e.g. "http://wpm-api:3000")
  oracleKeyPath: string; // Path to oracle's RSA private key
  enabledSports: string[]; // ["NFL"] at launch
  ingestCron: string; // "0 6 * * *" (6am ET daily)
  resolveCron: string; // "*/30 12-24 * * *" (every 30min, 12pm-1am ET)
  lookaheadDays: number; // 14
  defaultSeedAmount: number; // 1000
}
```

## Verification Criteria

1. **Ingest** creates markets for all upcoming games within the lookahead window
2. **Deduplication** — no duplicate markets for the same ESPN event
3. **Resolution** correctly identifies winners from ESPN score data
4. **Ties** trigger `CancelMarket` instead of `ResolveMarket`
5. **Postponed/cancelled games** trigger `CancelMarket`
6. **ESPN API failures** do not produce bad on-chain data
7. **Adapter interface** is consistent across sports
8. **Schedule** runs at the documented times
9. **Stateless** — oracle produces correct behavior after a clean restart
