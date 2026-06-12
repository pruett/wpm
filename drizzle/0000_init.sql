CREATE TYPE "public"."bet_side" AS ENUM('yes', 'no');--> statement-breakpoint
CREATE TYPE "public"."bet_status" AS ENUM('open', 'won', 'lost', 'voided');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('seed', 'bet_place', 'bet_settle', 'bet_void');--> statement-breakpoint
CREATE TABLE "bets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"market_ticker" text NOT NULL,
	"side" "bet_side" NOT NULL,
	"contracts" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"cost_cents" integer NOT NULL,
	"status" "bet_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_ticker" text PRIMARY KEY NOT NULL,
	"series_ticker" text NOT NULL,
	"title" text NOT NULL,
	"mutually_exclusive" boolean NOT NULL,
	"starts_at" timestamp with time zone,
	"game_status" text DEFAULT '' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"bet_id" integer,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"ticker" text PRIMARY KEY NOT NULL,
	"event_ticker" text NOT NULL,
	"outcome" text NOT NULL,
	"status" text NOT NULL,
	"result" text DEFAULT '' NOT NULL,
	"open_time" timestamp with time zone,
	"close_time" timestamp with time zone NOT NULL,
	"expected_expiration_time" timestamp with time zone,
	"yes_bid" integer,
	"yes_ask" integer,
	"no_bid" integer,
	"no_ask" integer,
	"last_price" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"telegram_id" text NOT NULL,
	"username" text,
	"first_name" text,
	"last_name" text,
	"language_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_market_ticker_markets_ticker_fk" FOREIGN KEY ("market_ticker") REFERENCES "public"."markets"("ticker") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_bet_id_bets_id_fk" FOREIGN KEY ("bet_id") REFERENCES "public"."bets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_event_ticker_events_event_ticker_fk" FOREIGN KEY ("event_ticker") REFERENCES "public"."events"("event_ticker") ON DELETE no action ON UPDATE no action;