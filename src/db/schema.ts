import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// All money columns are integer cents. A contract pays 100 cents on a win.
// Balances are never stored — always derived as SUM(ledger.amount_cents).

export const betSide = pgEnum("bet_side", ["yes", "no"]);
export const betStatus = pgEnum("bet_status", ["open", "won", "lost", "voided"]);
export const ledgerKind = pgEnum("ledger_kind", [
  "seed",
  "bet_place",
  "bet_settle",
  "bet_void",
  // Admin-initiated bankroll infusion (the /gift command) — like "seed" but
  // for existing accounts, so seed stays exactly one-per-user.
  "gift",
]);

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

// Hand-curated, light-hearted personalization used to flavor the LLM-generated
// group announcements (see utils/announce.ts). Author-written only — never
// user-editable — so the contents are trusted prompt context. Every field is
// optional; a bettor with no persona just gets the deterministic phrasing.
export interface UserPersona {
  /** Free-form personal asides: "drives a Miata he won't shut up about". */
  bullets?: string[];
  /** What the group actually calls them, for the model to use. */
  nicknames?: string[];
  /** Other bettors worth needling them about. */
  rivalries?: string[];
  /** Team allegiance to tease: "insufferable Cowboys fan". */
  team?: string;
  /** Steering for the roast intensity: "roast hard, he can take it". */
  tone?: string;
}

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
  // Hand-curated personalization for the LLM announcers. Nullable on purpose:
  // most bettors have none and fall back to the deterministic phrasing.
  persona: jsonb("persona").$type<UserPersona>(),
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
  // Set once this bet's settlement (or void) has been recapped in the groups.
  // Kept distinct from settledAt on purpose: settling and announcing are now
  // separate steps, so a Telegram failure leaves this null and the next sweep
  // re-announces instead of losing the recap (settlement is no longer
  // fire-once — see claimUnannouncedSettlements / releaseAnnouncements).
  announcedAt: timestamp("announced_at", { withTimezone: true }),
});

// One row per generated "Sunday Rundown" recap, saved before it's posted so a
// generation is never lost and the web surface can render it later.
export const recaps = pgTable("recaps", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // The rolling 7-day window this recap covers.
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  // The recap as the model wrote it: Telegram-flavored markdown with BARE
  // display names — no tg:// mentions baked in. Mentions are platform-specific,
  // so names stay plain here and get re-linked per surface (linkMentions() for
  // Telegram, profile links for the web) using the roster in `stats`.
  body: text("body").notNull(),
  // Full WeeklyStats snapshot — the numbers plus the user roster — so any
  // surface can render structured tables and re-link mentions without
  // re-querying. Left untyped here (so schema.ts stays a dependency-free leaf);
  // writers go through summary.saveRecap (typed WeeklyStats) and readers cast.
  // Dates serialize to ISO strings inside the JSON.
  stats: jsonb("stats").notNull(),
  // Gateway model id that wrote `body`, or "fallback" when the deterministic
  // safety-net recap was used.
  model: text("model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
