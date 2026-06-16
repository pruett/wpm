ALTER TABLE "bets" ADD COLUMN "announced_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: every bet already settled was either announced or is a past recap
-- we are not re-emitting. Stamp them so the first sweep after deploy claims
-- ONLY genuinely new settlements instead of flooding the groups with history.
UPDATE "bets" SET "announced_at" = COALESCE("settled_at", now()) WHERE "status" <> 'open' AND "announced_at" IS NULL;