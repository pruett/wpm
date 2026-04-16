import { relations, sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, primaryKey, check } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const balances = sqliteTable("balances", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

// Singleton row representing the platform treasury. The CHECK constraint
// prevents inserting any row whose id is not 'treasury'.
export const treasury = sqliteTable(
  "treasury",
  {
    id: text("id").primaryKey().default("treasury"),
    amount: integer("amount").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [check("treasury_singleton", sql`${t.id} = 'treasury'`)],
);

export const markets = sqliteTable(
  "markets",
  {
    id: text("id").primaryKey(),
    sport: text("sport").notNull(),
    name: text("name").notNull(),
    teamA: text("team_a").notNull(),
    teamB: text("team_b").notNull(),
    logoA: text("logo_a"),
    logoB: text("logo_b"),
    leagueLogo: text("league_logo"),
    startTime: integer("start_time").notNull(),
    bettingClosesAt: integer("betting_closes_at").notNull(),
    status: text("status", {
      enum: ["open", "closed", "resolved", "cancelled"],
    }).notNull(),
    resolvedOutcome: text("resolved_outcome", { enum: ["A", "B"] }),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("ix_markets_status_start").on(t.status, t.startTime)],
);

export const ammPools = sqliteTable("amm_pools", {
  marketId: text("market_id")
    .primaryKey()
    .references(() => markets.id, { onDelete: "cascade" }),
  reserveA: integer("reserve_a").notNull(),
  reserveB: integer("reserve_b").notNull(),
  wpmReserve: integer("wpm_reserve").notNull(),
  seedAmount: integer("seed_amount").notNull(),
});

export const positions = sqliteTable(
  "positions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    sharesA: integer("shares_a").notNull().default(0),
    sharesB: integer("shares_b").notNull().default(0),
    costBasis: integer("cost_basis").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.marketId] }),
    index("ix_positions_market").on(t.marketId),
  ],
);

export const transactionTypes = [
  "Distribute",
  "Transfer",
  "Referral",
  "CreateMarket",
  "PlaceBet",
  "SellShares",
  "ResolveMarket",
  "SettlePayout",
  "CancelMarket",
] as const;

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: transactionTypes }).notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    marketId: text("market_id").references(() => markets.id, {
      onDelete: "set null",
    }),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("ix_tx_user").on(t.userId, t.createdAt),
    index("ix_tx_market").on(t.marketId, t.createdAt),
    index("ix_tx_type_ts").on(t.type, t.createdAt),
  ],
);

export const balanceRelations = relations(balances, ({ one }) => ({
  user: one(user, {
    fields: [balances.userId],
    references: [user.id],
  }),
}));

export const marketRelations = relations(markets, ({ one, many }) => ({
  pool: one(ammPools, {
    fields: [markets.id],
    references: [ammPools.marketId],
  }),
  positions: many(positions),
  transactions: many(transactions),
}));

export const ammPoolRelations = relations(ammPools, ({ one }) => ({
  market: one(markets, {
    fields: [ammPools.marketId],
    references: [markets.id],
  }),
}));

export const positionRelations = relations(positions, ({ one }) => ({
  user: one(user, {
    fields: [positions.userId],
    references: [user.id],
  }),
  market: one(markets, {
    fields: [positions.marketId],
    references: [markets.id],
  }),
}));

export const transactionRelations = relations(transactions, ({ one }) => ({
  user: one(user, {
    fields: [transactions.userId],
    references: [user.id],
  }),
  market: one(markets, {
    fields: [transactions.marketId],
    references: [markets.id],
  }),
}));
