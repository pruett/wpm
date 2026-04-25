import { sql } from "drizzle-orm";

import { INITIAL_SUPPLY } from "../../constants";
import { client, db } from "../index";

export const treasurySeedSql = `INSERT INTO "treasury" ("id", "amount") VALUES ('treasury', ${INITIAL_SUPPLY}) ON CONFLICT ("id") DO NOTHING;`;

export async function seedTreasury() {
  await db.execute(sql.raw(treasurySeedSql));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedTreasury();
  await client.end();
}
