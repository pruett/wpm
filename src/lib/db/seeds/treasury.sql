INSERT INTO "treasury" ("id", "amount") VALUES ('treasury', 10000000) ON CONFLICT ("id") DO NOTHING;
