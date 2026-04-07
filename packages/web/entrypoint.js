import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");
const db = new Database("data/wpm.db");

// Run migrations
db.exec(
  "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
);

const applied = new Set(
  db
    .prepare("SELECT name FROM _migrations")
    .all()
    .map((row) => row.name),
);

const pending = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => !applied.has(f));

if (pending.length > 0) {
  db.transaction(() => {
    for (const file of pending) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
      db.prepare(
        "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
      ).run(file, new Date().toISOString());
    }
  })();
  console.log(`Applied ${pending.length} migration(s): ${pending.join(", ")}`);
}

db.close();

// Start the server
await import("./build/index.js");
