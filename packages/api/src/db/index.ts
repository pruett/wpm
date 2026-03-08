import { Database } from "bun:sqlite";

const DB_PATH = process.env.DB_PATH ?? "wpm-api.db";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  db = openDatabase(DB_PATH);
  return db;
}

export function openDatabase(path: string): Database {
  const instance = new Database(path);

  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec("PRAGMA foreign_keys = ON");
  instance.exec("PRAGMA busy_timeout = 5000");

  migrate(instance);

  return instance;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                     TEXT    PRIMARY KEY,
      name                   TEXT    NOT NULL,
      email                  TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      wallet_address         TEXT    NOT NULL UNIQUE,
      wallet_private_key_enc BLOB   NOT NULL,
      role                   TEXT    NOT NULL DEFAULT 'user',
      created_at             INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      credential_id TEXT    PRIMARY KEY,
      user_id       TEXT    NOT NULL REFERENCES users(id),
      public_key    BLOB    NOT NULL,
      counter       INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code       TEXT    PRIMARY KEY,
      created_by TEXT    NOT NULL,
      referrer   TEXT,
      max_uses   INTEGER NOT NULL,
      use_count  INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
