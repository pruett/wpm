CREATE TABLE "amm_pools" (
	"market_id" text PRIMARY KEY NOT NULL,
	"reserve_a" bigint NOT NULL,
	"reserve_b" bigint NOT NULL,
	"wpm_reserve" bigint NOT NULL,
	"seed_amount" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"user_id" text PRIMARY KEY NOT NULL,
	"amount" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" text PRIMARY KEY NOT NULL,
	"sport" text NOT NULL,
	"name" text NOT NULL,
	"team_a" text NOT NULL,
	"team_b" text NOT NULL,
	"ticker_a" text,
	"ticker_b" text,
	"closes_at" bigint NOT NULL,
	"status" text NOT NULL,
	"resolved_outcome" text,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL,
	"yes_bid_cents_a" integer,
	"yes_ask_cents_a" integer,
	"no_bid_cents_a" integer,
	"no_ask_cents_a" integer,
	"yes_bid_cents_b" integer,
	"yes_ask_cents_b" integer,
	"no_bid_cents_b" integer,
	"no_ask_cents_b" integer,
	"volume_24h_a" bigint,
	"volume_24h_b" bigint
);
--> statement-breakpoint
CREATE TABLE "oracle_heartbeats" (
	"job" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"shares_a" bigint DEFAULT 0 NOT NULL,
	"shares_b" bigint DEFAULT 0 NOT NULL,
	"cost_basis" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "positions_user_id_market_id_pk" PRIMARY KEY("user_id","market_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"user_id" text,
	"market_id" text,
	"payload" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury" (
	"id" text PRIMARY KEY DEFAULT 'treasury' NOT NULL,
	"amount" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_singleton" CHECK ("treasury"."id" = 'treasury')
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"display_name" text,
	"color" text,
	"icon" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "amm_pools" ADD CONSTRAINT "amm_pools_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balances" ADD CONSTRAINT "balances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_markets_status_closes" ON "markets" USING btree ("status","closes_at");--> statement-breakpoint
CREATE INDEX "ix_positions_market" ON "positions" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "ix_tx_user" ON "transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_tx_market" ON "transactions" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_tx_type_ts" ON "transactions" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
-- seed: treasury.sql
INSERT INTO "treasury" ("id", "amount") VALUES ('treasury', 10000000) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
