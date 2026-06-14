#!/usr/bin/env bash
#
# Mirror production's betting data into the local Docker Postgres so we can
# rehearse crons (e.g. /api/summary) against real numbers.
#
# Copies OUR tables (events, markets, users, bets, ledger + any migration
# state) and DELIBERATELY skips the chat SDK's chat_* tables. That's the point:
# local keeps its own bot subscriptions, so a rehearsal posts to your local
# test group — never the real production chats — while still seeing prod's bets.
#
# Both pg_dump and psql run from INSIDE the db container (Postgres 17 client),
# so there's no client/server version mismatch with a modern prod server the
# way the Homebrew pg_dump (v14) would hit.
#
# Usage: bun run db:pull:prod   (or: bash scripts/db-pull-prod.sh)
set -euo pipefail

cd "$(dirname "$0")/.."

DB_SERVICE="wpm2-db"
LOCAL_URL="postgres://wpm2:wpm2@localhost:5432/wpm2" # inside the container
PROD_ENV_FILE=".env.production.local"

# Prod creds are only needed for the dump — don't leave them on disk after.
cleanup() { rm -f "$PROD_ENV_FILE"; }
trap cleanup EXIT

echo "→ Pulling production env from Vercel…"
vercel env pull "$PROD_ENV_FILE" --environment=production --yes >/dev/null

PROD_URL="$(grep -E '^DATABASE_URL=' "$PROD_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'")"
if [ -z "$PROD_URL" ]; then
  echo "✗ No DATABASE_URL found in $PROD_ENV_FILE" >&2
  exit 1
fi

echo "→ Ensuring the local '$DB_SERVICE' container is up…"
docker compose up -d "$DB_SERVICE" >/dev/null
CID="$(docker compose ps -q "$DB_SERVICE")"
if [ -z "$CID" ]; then
  echo "✗ Could not find the '$DB_SERVICE' container (is Docker running?)" >&2
  exit 1
fi

echo "→ Dumping prod (excluding chat_*) and restoring into local…"
# --clean --if-exists  : drop & recreate our tables so the copy is exact
# --no-owner/privileges: don't carry prod roles into the local DB
# --exclude-table=chat_*: leave the chat SDK's tables (local subscriptions) alone
# psql --single-transaction + ON_ERROR_STOP: all-or-nothing, never half-applied
docker exec -i "$CID" pg_dump "$PROD_URL" \
  --clean --if-exists --no-owner --no-privileges \
  --exclude-table='chat_*' \
| docker exec -i "$CID" psql "$LOCAL_URL" \
    --set ON_ERROR_STOP=on --single-transaction --quiet

echo "✓ Local DB now mirrors prod's betting tables. chat_* left untouched."
