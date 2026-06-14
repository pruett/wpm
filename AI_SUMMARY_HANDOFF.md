# Weekly Recap Cron — Handoff

> Status: **implemented, locally tested, not yet committed or deployed.**
> This doc hands off the "weekly AI-written betting recap" feature so a fresh
> session can understand and extend it without re-deriving context.

## 1. What this feature does

A weekly Vercel cron (`/api/summary`) that recaps the past 7 days of betting in
the subscribed Telegram group chats. It:

1. Tallies the week's activity **deterministically from the books** (bets placed,
   bets settled, realized P&L per user, biggest win/loss).
2. Feeds those exact, pre-formatted facts to a **cheap LLM** (Anthropic Haiku via
   the Vercel AI Gateway) which writes a playful, roasty, "between friends" recap.
3. Converts the bare player names in the LLM output into Telegram `tg://` mentions
   (so people get pinged), then posts a headline + celebratory GIF + the recap to
   every subscribed group.

**Core design principle:** the LLM never invents numbers. All figures are computed
in code and handed to the model pre-formatted (e.g. `"+$11,275"`); the model only
writes prose around them. If the model call fails (e.g. missing credentials), a
deterministic fallback recap is used so the cron always posts something.

## 2. Schedule & the DST caveat (important)

`vercel.json` cron: `{ "path": "/api/summary", "schedule": "0 16 * * SUN" }`

- `0 16 * * SUN` = **16:00 UTC Sunday**.
- That is **noon ET Sunday during EDT (summer)** but **11am ET Sunday during EST
  (winter)** — Vercel crons are UTC-only and not DST-aware.
- This does **not** affect correctness: stats use a **rolling 7-day window off the
  invocation time** (`new Date()` minus 7 days), not a calendar week. The hour
  drift only changes *when* it posts.
- If exact-noon matters more in winter, `0 17 * * SUN` gives noon EST / 1pm EDT.

The recap is branded **"The Sunday Rundown"** (headline in `announce.ts`, prompt
copy in `summary.ts`).

## 3. Files

### New files
| File | Purpose |
|------|---------|
| `src/api/summary.ts` | Cron HTTP handler. `CRON_SECRET` bearer auth (same as `src/api/sync.ts`), skips on a dead week, orchestrates collect → generate → linkMentions → announce. |
| `src/utils/summary.ts` | The brains: `collectWeeklyStats`, `generateWeeklyRecap`, `hadActivity`, `saveRecap`, types, the LLM system prompt, the facts builder, and the deterministic `fallbackRecap`. |
| `scripts/db-pull-prod.sh` | Mirrors prod's betting tables into the local Docker Postgres (excludes `chat_*`). Wired as `bun run db:pull:prod`. |

### Modified files
| File | Change |
|------|--------|
| `src/utils/announce.ts` | Added `announceWeeklyRecap(recapMarkdown)` — reuses the module's private `groupThreadIds()`, `state.connect()`, GIF pool (`VICTORY_GIFS`), and `pickRandom()`. Posts headline + GIF + recap markdown to each subscribed thread. |
| `src/utils/format.ts` | Added `linkMentions(text, people)` — rewrites bare display names in free text into `tg://user?id=` mentions. Single-pass regex alternation, longest names first, `\w` lookarounds (so `@username` display names anchor correctly). |
| `src/utils/cli.ts` | Added the `summary [post]` command — local rehearsal runner. Prints the per-player table + generated recap; `post` sends it to local groups. |
| `package.json` | Added script `db:pull:prod`; added `src/api/summary.ts` to the `build:api` bundle entrypoints; added dependency `ai` (Vercel AI SDK v6, `ai@6.0.204`). |
| `vercel.json` | Added the `/api/summary` cron entry. |
| `.env.example` | Documented `CRON_SECRET`, `AI_GATEWAY_API_KEY`, `SUMMARY_MODEL`. |
| `api/*.mjs` | Rebuilt bundles (build artifacts; regenerated on deploy via `buildCommand`). `api/summary.mjs` is new; `sync.mjs`/`telegram.mjs` changed because they import the edited `announce.ts`/`format.ts`. |

## 4. Data model

### New table: `recaps` (migration `0002_lazy_annihilus`)
Every generation is saved **before** posting, so a recap is never lost and a web
surface can render it later. Columns (`src/db/schema.ts:recaps`):
- `periodStart` / `periodEnd` — the rolling 7-day window.
- `body` — the recap as the model wrote it: Telegram-flavored markdown with
  **bare display names** (no `tg://` mentions baked in). Mentions are
  platform-specific, so names stay plain and get re-linked per surface
  (`linkMentions()` for Telegram; profile links for the web).
- `stats` — `jsonb`, the full `WeeklyStats` snapshot (numbers + user roster, so
  any surface can re-link mentions without re-querying). Typed `unknown` in the
  schema to keep `schema.ts` a dependency-free leaf (no `schema ↔ summary`
  import cycle); writes go through `summary.saveRecap` (typed `WeeklyStats`),
  reads cast. Dates serialize to ISO strings.
- `model` — Gateway model id that wrote `body`, or `"fallback"`.
- `createdAt` — defaults to now.

`drizzle.config.ts` `tablesFilter` now includes `recaps`. Apply with
`bun run db:migrate` (auto-applied on prod via `buildCommand`).

### Tables it reads

All money is **integer cents**; a contract pays 100¢ on a win. Balances are never
stored — derived as `SUM(ledger.amount_cents)`. Relevant tables in
`src/db/schema.ts`:

- `bets` — `userId, marketTicker, side ('yes'|'no'), contracts, priceCents,
  costCents, status ('open'|'won'|'lost'|'voided'), createdAt, settledAt`.
- `markets` — `ticker (pk), eventTicker, outcome, result, …`.
- `events` — `eventTicker (pk), title, …`.
- `users` — `id (pk), telegramId (immutable identity), username, firstName,
  lastName, …`.
- `ledger` — immutable transaction log; not directly read by the recap (P&L is
  computed from settled bets instead, matching `announce.ts`'s settlement math).

**Realized P&L per settled bet** (same as `settleMarketBets` in `src/utils/house.ts`):
- won → `contracts * 100 - costCents`
- lost → `-costCents`
- voided → `0` (refunded)

### `collectWeeklyStats(until = new Date())` shape
Returns `WeeklyStats` (`src/utils/summary.ts`):
- Window: `since = until - 7 days`.
- `players: WeeklyPlayer[]` sorted by `realizedCents` desc. Each player folds two
  query sets: **bets placed this week** (`createdAt` in window → volume:
  `betsPlaced`, `stakedCents`) and **bets settled this week** (`settledAt` in
  window, status in won/lost/voided → `realizedCents`, `wins`, `losses`, `voids`).
  Note the two id sets don't fully overlap (a bet placed last week can settle this
  week), so users are hydrated from the union.
- `biggestWin` / `biggestLoss`: `BetHighlight` with market `outcome` + event
  `title` for the callouts.
- Aggregate counts: `betsPlaced, totalStakedCents, betsSettled, wins, losses,
  voids, uniqueBettors`.

> Subtlety to remember: the per-player table shows **net realized P&L** (settled
> bets only), while "placed" is volume. A heavy staker with open (unsettled) bets
> can show negative net even with lots of money still in play.

## 5. LLM integration (Vercel AI SDK + AI Gateway)

- Package: `ai` (v6). Import: `import { generateText } from "ai"`.
- Model: plain Gateway string. Default `anthropic/claude-haiku-4.5`, overridable
  via env `SUMMARY_MODEL`. (Gateway model IDs use dot notation, e.g.
  `anthropic/claude-haiku-4.5`, `openai/gpt-4o-mini`. List them:
  `curl -s https://ai-gateway.vercel.sh/v1/models | jq -r '.data[].id'`.)
- Call uses `system`, `prompt`, `temperature: 0.8`, `maxOutputTokens: 500`
  (v6 param name is `maxOutputTokens`, not `maxTokens`).

### Auth — and why prod needs no key
- **Production (Vercel):** the platform injects a short-lived OIDC token
  (`VERCEL_OIDC_TOKEN`) into the function runtime; the Gateway provider uses it
  automatically and bills the team. **No API key to manage.**
- **Local:** your machine isn't a Vercel deployment, so there's no injected OIDC
  token. You need a manually created **`AI_GATEWAY_API_KEY`** in `.env`
  (vercel.com → AI Gateway → API Keys). The SDK falls back to this key.

> ⚠️ SECURITY NOTE: during local setup, the live `AI_GATEWAY_API_KEY` value got
> printed into a previous session's terminal/transcript. **Rotate that key**
> (delete + recreate in the AI Gateway dashboard, update `.env`). It is local-only,
> so rotation has no prod impact.

## 6. Local testing workflow

```bash
# 1. (optional) mirror prod's bets into the local Docker DB for realistic data
bun run db:pull:prod

# 2. ensure .env has a valid AI_GATEWAY_API_KEY (see security note above)

# 3. dry run — prints the per-player table + the generated recap, posts nothing
bun run cli summary

# 4. when happy, actually post to the LOCAL bot's subscribed groups
bun run cli summary post
```

### `scripts/db-pull-prod.sh` details
- Local DB is **Docker `postgres:17-alpine`** on `127.0.0.1:5434` (see
  `docker-compose.yml`, service `wpm2-db`). Local `.env` `DATABASE_URL` =
  `postgres://wpm2:wpm2@localhost:5434/wpm2`.
- **Why it dumps from inside the container:** the Homebrew `pg_dump` is v14, which
  refuses to dump a modern (v16/17) prod server. The script runs both `pg_dump`
  and `psql` via `docker exec` using the container's **v17** client — no version
  mismatch.
- Pulls prod `DATABASE_URL` with `vercel env pull .env.production.local
  --environment=production` (same pattern as the existing `db:migrate:prod`
  script), then **deletes that creds file on exit** via a trap.
- `pg_dump --clean --if-exists --no-owner --no-privileges --exclude-table='chat_*'`
  piped to `psql --single-transaction --set ON_ERROR_STOP=on`.
- **Excludes `chat_*` on purpose.** Those are the chat SDK's tables, including
  `chat_state_subscriptions` (which groups the bot posts to). Keeping *local*
  subscriptions means a rehearsal posts to your local test group
  (`@wpm_cash_bot`), **never the real prod chats**, while still operating on
  prod's real bets. Verified: only `bets, events, ledger, markets, users` copy;
  the 5 `chat_state_*` tables are skipped.
- Requires: Docker running + logged into the Vercel CLI.

## 7. Telegram bot context (two-bot split — relevant when testing posting)

- **Prod:** `@OracleWampumBot`, webhook mode.
- **Local:** `@wpm_cash_bot`, getUpdates polling mode.
- Subscribed group threads come from `chat_state_subscriptions` rows where
  `thread_id LIKE 'telegram:-%'` (group ids are negative). See
  `groupThreadIds()` in `src/utils/announce.ts`.
- Posting needs `state.connect()` (connects the chat SDK's Postgres state pool
  without starting a polling loop). `announceWeeklyRecap` does this; the preview
  runner closes the pool with `state.disconnect()` + `sql.end()` so the process
  exits (mirrors `src/utils/cli.ts`).

## 8. Build & deploy notes

- `bun run build:api` bundles `src/api/{sync,summary,telegram,health}.ts` →
  `api/*.mjs` (Bun, `--target node --format esm`). `summary.mjs` is ~2.8 MB
  (includes the AI SDK).
- Deploy runs `buildCommand` in `vercel.json`: builds the API, and on production
  also runs Drizzle migrations + `setMyCommands`. Migration `0002_lazy_annihilus`
  (the `recaps` table) is applied automatically by that step.
- Env vars to set on the Vercel project for prod: `CRON_SECRET` (already used by
  `/api/sync`). `AI_GATEWAY_API_KEY` is **not** needed in prod (OIDC). Optionally
  set `SUMMARY_MODEL` to override the model.
- `typecheck` (`bun run typecheck`) and `build:api` both pass as of handoff.

## 9. Current state / what's left

- ✅ Implemented, typechecks, builds, locally verified producing real Haiku recaps.
- ⛔ **Not committed.** Files to stage: the 4 new source/script files, the 6
  modified files (`announce.ts`, `format.ts`, `package.json`, `vercel.json`,
  `.env.example`, `bun.lock`), and the rebuilt `api/*.mjs`.
- ⛔ **Not deployed.**
- 🔐 Rotate the local `AI_GATEWAY_API_KEY` (see §5).

### Ideas for extending (not yet done)
- Tune the recap tone/length via `RECAP_SYSTEM` in `src/utils/summary.ts`.
- Add more highlight dimensions to `WeeklyStats` (longest win streak, most
  contrarian winning bet, biggest single stake, house's net take, etc.) and
  surface them in `recapFacts` for the model to use.
- A monthly/season-long variant, or a leaderboard delta vs. all-time balance.
- Consider whether the recap should also tag users who placed but didn't settle.
- The recap currently picks a `VICTORY_GIFS` GIF regardless of the week's mood —
  could choose based on whether the group was net up/down.

## 10. Key references (file:symbol)

- `src/api/summary.ts:GET` — cron entrypoint.
- `src/utils/summary.ts:collectWeeklyStats` — the tally.
- `src/utils/summary.ts:generateWeeklyRecap` / `recapFacts` / `RECAP_SYSTEM` /
  `fallbackRecap` — LLM generation + safety net.
- `src/utils/summary.ts:hadActivity` — dead-week gate.
- `src/utils/announce.ts:announceWeeklyRecap` — group posting.
- `src/utils/format.ts:linkMentions` — name → mention rewriting.
- `src/utils/format.ts:formatDollars` / `mention` / `displayName` / `formatEastern`
  — existing formatting helpers reused.
- `src/utils/house.ts:settleMarketBets` — the canonical P&L math this mirrors.
- `scripts/db-pull-prod.sh` — prod→local sync.
