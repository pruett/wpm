import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  bigint,
  serial,
  timestamp,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

export const balances = pgTable("balances", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  amount: bigint("amount", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Singleton row representing the platform treasury. The CHECK constraint
// prevents inserting any row whose id is not 'treasury'.
export const treasury = pgTable(
  "treasury",
  {
    id: text("id").primaryKey().default("treasury"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [check("treasury_singleton", sql`${t.id} = 'treasury'`)],
);

export const markets = pgTable(
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
    startTime: bigint("start_time", { mode: "number" }).notNull(),
    bettingClosesAt: bigint("betting_closes_at", { mode: "number" }).notNull(),
    status: text("status", {
      enum: ["open", "closed", "resolved", "cancelled"],
    }).notNull(),
    resolvedOutcome: text("resolved_outcome", { enum: ["A", "B"] }),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("ix_markets_status_start").on(t.status, t.startTime)],
);

export const ammPools = pgTable("amm_pools", {
  marketId: text("market_id")
    .primaryKey()
    .references(() => markets.id, { onDelete: "cascade" }),
  reserveA: bigint("reserve_a", { mode: "number" }).notNull(),
  reserveB: bigint("reserve_b", { mode: "number" }).notNull(),
  wpmReserve: bigint("wpm_reserve", { mode: "number" }).notNull(),
  seedAmount: bigint("seed_amount", { mode: "number" }).notNull(),
});

export const positions = pgTable(
  "positions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    marketId: text("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    sharesA: bigint("shares_a", { mode: "number" }).notNull().default(0),
    sharesB: bigint("shares_b", { mode: "number" }).notNull().default(0),
    costBasis: bigint("cost_basis", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.marketId] }),
    index("ix_positions_market").on(t.marketId),
  ],
);

export const oracleHeartbeats = pgTable("oracle_heartbeats", {
  job: text("job").primaryKey(),
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  message: text("message"),
  lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true }).notNull(),
});

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

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    type: text("type", { enum: transactionTypes }).notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    marketId: text("market_id").references(() => markets.id, {
      onDelete: "set null",
    }),
    payload: text("payload").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
