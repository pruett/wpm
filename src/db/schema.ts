import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// All money columns are integer cents. A contract pays 100 cents on a win.
// Balances are never stored — always derived as SUM(ledger.amount_cents).

export const betSide = pgEnum("bet_side", ["yes", "no"]);
export const betStatus = pgEnum("bet_status", ["open", "won", "lost", "voided"]);
export const ledgerKind = pgEnum("ledger_kind", ["seed", "bet_place", "bet_settle", "bet_void"]);

// --- Kalshi mirror (written by sync, read-only for the app) ---

export const events = pgTable("events", {
  eventTicker: text("event_ticker").primaryKey(),
  seriesTicker: text("series_ticker").notNull(),
  title: text("title").notNull(),
  mutuallyExclusive: boolean("mutually_exclusive").notNull(),
  // Scheduled start from the milestone's start_date; betting locks here.
  startsAt: timestamp("starts_at", { withTimezone: true }),
  // Live game state from the milestone's details.status (e.g. "not_started").
  gameStatus: text("game_status").notNull().default(""),
  // True once the group's "betting locks soon" last-call alert has gone out
  // for this event, so the cron sweep announces each kickoff exactly once.
  bettableAnnounced: boolean("bettable_announced").notNull().default(false),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const markets = pgTable("markets", {
  ticker: text("ticker").primaryKey(),
  eventTicker: text("event_ticker")
    .notNull()
    .references(() => events.eventTicker),
  outcome: text("outcome").notNull(), // Kalshi yes_sub_title, e.g. "Panama"
  status: text("status").notNull(),
  result: text("result").notNull().default(""),
  openTime: timestamp("open_time", { withTimezone: true }),
  // Backstop only, NOT kickoff — Kalshi trades sports in-play.
  closeTime: timestamp("close_time", { withTimezone: true }).notNull(),
  expectedExpirationTime: timestamp("expected_expiration_time", { withTimezone: true }),
  yesBid: integer("yes_bid"),
  yesAsk: integer("yes_ask"),
  noBid: integer("no_bid"),
  noAsk: integer("no_ask"),
  lastPrice: integer("last_price"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Ours (the house) ---

export const users = pgTable("users", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // Telegram user id — the immutable identity key. Text because Telegram ids
  // exceed 32-bit integer range and the chat SDK hands them to us as strings.
  telegramId: text("telegram_id").notNull().unique(),
  // Mutable Telegram profile fields, refreshed as users interact. Display
  // only — usernames can change or be unset, so never use them as identity.
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  languageCode: text("language_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bets = pgTable("bets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  marketTicker: text("market_ticker")
    .notNull()
    .references(() => markets.ticker),
  side: betSide("side").notNull(),
  contracts: integer("contracts").notNull(),
  priceCents: integer("price_cents").notNull(),
  costCents: integer("cost_cents").notNull(),
  status: betStatus("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

export const ledger = pgTable("ledger", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  amountCents: integer("amount_cents").notNull(),
  kind: ledgerKind("kind").notNull(),
  betId: integer("bet_id").references(() => bets.id),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
});
