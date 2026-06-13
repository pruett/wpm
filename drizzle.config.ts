import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Scope drizzle-kit to our own tables. The chat SDK (@chat-adapter/state-pg)
  // creates and owns chat_state_* at runtime and they're not in schema.ts.
  // This keeps `push` clean on a fresh local DB — but it does NOT make `push`
  // safe against a DB that already holds the chat tables: excluding them
  // orphans their sequences, which `push` then tries to DROP. So NEVER run
  // push/pull against prod. Apply prod schema changes with hand-written SQL
  // (a plain ALTER), which touches nothing it isn't told to.
  tablesFilter: ["events", "markets", "users", "bets", "ledger"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost/wpm2",
  },
});
