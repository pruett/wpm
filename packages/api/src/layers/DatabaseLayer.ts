import { Layer, Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "@effect/sql"
import { AppConfigService } from "../Config"

export const SqliteLive = AppConfigService.pipe(
  Effect.map((config) =>
    SqliteClient.layer({
      filename: config.dbPath,
    })
  ),
  Layer.unwrapEffect,
)

// Run migrations after connection
const MigrationLive = Layer.effectDiscard(
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe("PRAGMA journal_mode = WAL")
    yield* sql.unsafe("PRAGMA foreign_keys = ON")
    yield* sql.unsafe("PRAGMA busy_timeout = 5000")

    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        id                     TEXT    PRIMARY KEY,
        name                   TEXT    NOT NULL,
        email                  TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        wallet_address         TEXT    NOT NULL UNIQUE,
        wallet_private_key_enc BLOB   NOT NULL,
        role                   TEXT    NOT NULL DEFAULT 'user',
        created_at             INTEGER NOT NULL
      )
    `)
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT    PRIMARY KEY,
        user_id       TEXT    NOT NULL REFERENCES users(id),
        public_key    BLOB    NOT NULL,
        counter       INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      )
    `)
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        code       TEXT    PRIMARY KEY,
        created_by TEXT    NOT NULL,
        referrer   TEXT,
        max_uses   INTEGER NOT NULL,
        use_count  INTEGER NOT NULL DEFAULT 0,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `)
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS auth_challenges (
        id         TEXT    PRIMARY KEY,
        challenge  TEXT    NOT NULL,
        type       TEXT    NOT NULL,
        user_data  TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
  }),
)

export const DatabaseLive = SqliteLive.pipe(
  Layer.provideMerge(MigrationLive),
)
