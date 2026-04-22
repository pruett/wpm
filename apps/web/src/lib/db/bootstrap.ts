import { client } from "./index";
import { runMigrations } from "./migrate";
import { seedTreasury } from "./seed";

export async function bootstrapDb(): Promise<void> {
  await runMigrations();
  await seedTreasury();
}

if (import.meta.main) {
  await bootstrapDb();
  await client.end();
}
